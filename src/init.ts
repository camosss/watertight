import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Scaffold a report pair that holds water as written — the first compile a new
 * user runs must succeed, so every figure in the template is already grounded.
 */
const REPORT = `# Checkout experiment — verification

Rolled out in \`{{id:app_version}}\` behind \`{{id:flag}}\`.

## Outcome

Conversion moved from {{m:conversion_before}} to {{m:conversion_after}} —
a change of {{m:conversion_change}}.

{{claim: state your conclusion here, pinned to the metrics that support it | evidence: conversion_change}}

## Next steps

Replace these metrics with your own. Every number needs a receipt:
run \`watertight .\` and fix what leaks.
`

const METRICS = `${JSON.stringify(
  {
    metrics: {
      conversion_before: {
        value: 0.031,
        unit: 'ratio',
        definition: 'purchases / sessions entering checkout',
        source: { type: 'sql', query: 'replace-with-your-query.sql' },
        window: '2026-01-01 ~ 2026-01-14',
        fetched_at: '2026-01-15',
      },
      conversion_after: {
        value: 0.036,
        unit: 'ratio',
        definition: 'purchases / sessions entering checkout',
        source: { type: 'sql', query: 'replace-with-your-query.sql' },
        window: '2026-01-15 ~ 2026-01-28',
        fetched_at: '2026-01-29',
      },
      conversion_change: {
        value: 0.161,
        unit: 'ratio-point',
        definition: 'relative change in conversion',
        derived: { op: 'pct_change', before: 'conversion_before', after: 'conversion_after' },
      },
    },
    identifiers: { app_version: '1.0.0', flag: 'checkout_v2' },
  },
  null,
  2,
)}\n`

export interface InitResult {
  written: string[]
}

/** Refuses to touch anything that already exists — init never overwrites. */
export async function init(dir: string): Promise<InitResult> {
  const files: [string, string][] = [
    [join(dir, 'report.md'), REPORT],
    [join(dir, 'metrics.json'), METRICS],
  ]
  for (const [path] of files) {
    if (existsSync(path)) throw new Error(`refusing to overwrite ${path}`)
  }
  await mkdir(dir, { recursive: true })
  for (const [path, content] of files) await writeFile(path, content)
  return { written: files.map(([p]) => p) }
}
