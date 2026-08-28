import { readFile } from 'node:fs/promises'
import { parseIr } from './ir.js'
import { render } from './render.js'
import { scanNakedNumbers, scanRefs } from './scan.js'
import type { Leak } from './types.js'

export interface CompileResult {
  leaks: Leak[]
  /** Present only when the report holds water */
  html?: string
  grounded: { metrics: number; identifiers: number }
}

export async function compile(reportPath: string, irPath: string): Promise<CompileResult> {
  const report = await readFile(reportPath, 'utf8')
  const { ir, leaks } = parseIr(JSON.parse(await readFile(irPath, 'utf8')))

  const grounded = {
    metrics: [...report.matchAll(/\{\{m:/g)].length,
    identifiers: [...report.matchAll(/\{\{id:/g)].length,
  }

  leaks.push(...scanNakedNumbers(report))
  if (ir) leaks.push(...scanRefs(report, new Set(Object.keys(ir.metrics)), new Set(Object.keys(ir.identifiers))))

  if (leaks.length > 0 || !ir) return { leaks, grounded }
  return { leaks, html: render(report, ir), grounded }
}
