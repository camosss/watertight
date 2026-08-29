import { readFile } from 'node:fs/promises'
import { parseIr } from './ir.js'
import { render } from './render.js'
import { renderMarkdown } from './renderMd.js'
import { blankCode, scanMarkers, scanNakedNumbers, scanRefs, scanWordedNumbers } from './scan.js'
import type { Leak } from './types.js'

export type Format = 'html' | 'md'

export interface CompileOptions {
  format?: Format
  /** Fail metrics whose fetched_at is older than this many days — numbers age */
  maxAgeDays?: number
  /** Fail when the report uses more than this many {{raw:}} escapes */
  maxRaw?: number
  /** Promote warnings to errors — info stays info */
  strict?: boolean
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

  // counted on code-blanked text so a fenced syntax example is neither a grounded
  // metric nor a raw escape — the header, the scanner and the render must agree
  const prose = blankCode(report)
  const grounded = {
    metrics: [...prose.matchAll(/\{\{m:/g)].length,
    identifiers: [...prose.matchAll(/\{\{id:/g)].length,
    claims: [...prose.matchAll(/\{\{claim:/g)].length,
    raw: [...prose.matchAll(/\{\{raw:/g)].length,
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
  leaks.push(...scanWordedNumbers(report))
  if (ir) {
    leaks.push(
      ...scanRefs(
        report,
        new Set(Object.keys(ir.metrics)),
        new Set(Object.keys(ir.identifiers)),
        new Set(Object.keys(ir.assertions)),
      ),
    )

    // a metric nothing references is drift, not a failure — info, and never promoted
    const referenced = new Set<string>()
    for (const m of prose.matchAll(/\{\{m:([\w-]+)\}\}/g)) referenced.add(m[1])
    for (const [, , evidence] of prose.matchAll(/\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g)) {
      for (const k of evidence.split(',').map((k) => k.trim()).filter(Boolean)) referenced.add(k)
    }
    for (const m of Object.values(ir.metrics)) {
      const d = m?.derived
      if (!d) continue
      if (d.op === 'sum' || d.op === 'avg') { if (Array.isArray(d.of)) for (const k of d.of) referenced.add(k) }
      else if (d.op === 'pct_change') { for (const k of [d.before, d.after]) if (typeof k === 'string') referenced.add(k) }
      else { for (const k of [d.a, d.b]) if (typeof k === 'string') referenced.add(k) }
    }
    for (const a of Object.values(ir.assertions)) {
      for (const k of [a.a, a.b]) if (typeof k === 'string') referenced.add(k.replace(/\.(lo|hi)$/, ''))
    }
    for (const key of Object.keys(ir.metrics)) {
      if (!referenced.has(key)) {
        leaks.push({ severity: 'info', rule: 'unused-metric', message: `metric "${key}" is in the IR but nothing references it`, detail: 'Drift signal — cite it, or remove it.' })
      }
    }
  }

  if (opts.strict) {
    for (const leak of leaks) if (leak.severity === 'warn') leak.severity = 'error'
  }

  // only errors stop the build — warn and info are reported, and the output still renders
  const hasErrors = leaks.some((l) => l.severity === 'error')
  if (hasErrors || !ir) return { leaks, grounded }
  return { leaks, output: format === 'md' ? renderMarkdown(report, ir) : render(report, ir), grounded }
}
