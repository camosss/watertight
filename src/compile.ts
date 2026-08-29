import { readFile } from 'node:fs/promises'
import { parseIr } from './ir.js'
import { render } from './render.js'
import { renderMarkdown } from './renderMd.js'
import { scanMarkers, scanNakedNumbers, scanRefs } from './scan.js'
import type { Leak } from './types.js'

export type Format = 'html' | 'md'

export interface CompileOptions {
  format?: Format
  /** Fail metrics whose fetched_at is older than this many days — numbers age */
  maxAgeDays?: number
  /** Fail when the report uses more than this many {{raw:}} escapes */
  maxRaw?: number
  /** Injectable for tests */
  now?: Date
}

export interface CompileResult {
  leaks: Leak[]
  /** Present only when the report holds water */
  output?: string
  grounded: { metrics: number; identifiers: number; claims: number; raw: number }
}

export async function compile(
  reportPath: string,
  irPath: string,
  options: Format | CompileOptions = 'html',
): Promise<CompileResult> {
  const opts: CompileOptions = typeof options === 'string' ? { format: options } : options
  const format = opts.format ?? 'html'
  const report = await readFile(reportPath, 'utf8')
  const { ir, leaks } = parseIr(JSON.parse(await readFile(irPath, 'utf8')))

  if (ir && opts.maxAgeDays !== undefined) {
    const now = opts.now ?? new Date()
    for (const [key, m] of Object.entries(ir.metrics)) {
      if (!m.fetched_at) continue
      const fetched = new Date(m.fetched_at)
      if (Number.isNaN(fetched.getTime())) continue // "-" and friends: no date to age
      const days = Math.floor((now.getTime() - fetched.getTime()) / 86_400_000)
      if (days > opts.maxAgeDays) {
        leaks.push({
          severity: 'error',
          rule: 'stale-metric',
          message: `metric "${key}" was fetched ${m.fetched_at} — ${days} days ago, older than max-age ${opts.maxAgeDays}`,
          detail: 'Run watertight refresh, or re-fetch by hand and update fetched_at.',
        })
      }
    }
  }

  const grounded = {
    metrics: [...report.matchAll(/\{\{m:/g)].length,
    identifiers: [...report.matchAll(/\{\{id:/g)].length,
    claims: [...report.matchAll(/\{\{claim:/g)].length,
    raw: [...report.matchAll(/\{\{raw:/g)].length,
  }

  // the escape hatch must stay visible and boundable — wrapping everything in raw
  // is how an agent games the compile instead of grounding the numbers
  if (opts.maxRaw !== undefined && grounded.raw > opts.maxRaw) {
    leaks.push({
      severity: 'error',
      rule: 'raw-budget',
      message: `${grounded.raw} raw escape(s) exceed the budget of ${opts.maxRaw}`,
      detail: 'Ground the numbers instead, or raise --max-raw deliberately.',
    })
  }

  leaks.push(...scanNakedNumbers(report))
  leaks.push(...scanMarkers(report))
  if (ir) leaks.push(...scanRefs(report, new Set(Object.keys(ir.metrics)), new Set(Object.keys(ir.identifiers))))

  if (leaks.length > 0 || !ir) return { leaks, grounded }
  return { leaks, output: format === 'md' ? renderMarkdown(report, ir) : render(report, ir), grounded }
}
