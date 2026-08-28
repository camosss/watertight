import type { Ir, Leak, Metric } from './types.js'

/** Units whose meaning depends on how they were aggregated — a bare value misleads. */
const DEFINITION_REQUIRED = new Set(['ratio', 'ratio-point'])

function decimals(n: number): number {
  const s = String(n)
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

/**
 * A stored derived value must be correctly rounded to its own precision: writing 0.15
 * for a computed 0.155 is a mismatch, writing 0.155 for 0.15517 is fine. This is what
 * caught a rounding error in the first real document this schema was tested against.
 */
function roundsTo(stored: number, computed: number): boolean {
  return Math.abs(stored - computed) < 0.5 * 10 ** -decimals(stored)
}

export function parseIr(raw: unknown): { ir?: Ir; leaks: Leak[] } {
  const leaks: Leak[] = []
  const root = (raw ?? {}) as Record<string, unknown>

  const identifiers: Record<string, string> = {}
  for (const [k, v] of Object.entries((root['identifiers'] as object) ?? {})) {
    identifiers[k] = String(v)
  }

  const metrics = (root['metrics'] as Record<string, Metric>) ?? {}
  if (Object.keys(metrics).length === 0) {
    leaks.push({
      severity: 'error',
      rule: 'empty-ir',
      message: 'The IR declares no metrics',
      detail: 'A report with nothing grounded is not a watertight report.',
    })
    return { leaks }
  }

  for (const [key, m] of Object.entries(metrics)) {
    if (m.value === undefined) {
      leaks.push({ severity: 'error', rule: 'missing-field', message: `metric "${key}" has no value` })
      continue
    }
    if (typeof m.unit !== 'string' || m.unit.length === 0) {
      leaks.push({ severity: 'error', rule: 'missing-field', message: `metric "${key}" has no unit` })
    }
    if (DEFINITION_REQUIRED.has(m.unit) && !m.definition) {
      leaks.push({
        severity: 'error',
        rule: 'definition-required',
        message: `metric "${key}" is a ${m.unit} without a definition`,
        detail: 'Ratios mislead without their aggregation basis — a fill rate above 100% is either a bug or a definition, and the reader must be told which.',
      })
    }

    if (m.derived) {
      if (Array.isArray(m.value)) {
        leaks.push({ severity: 'error', rule: 'bad-derived', message: `metric "${key}": a range cannot be derived` })
        continue
      }
      if (m.derived.op === 'sum') {
        let computed = 0
        let broken = false
        for (const ref of m.derived.of) {
          const part = metrics[ref]
          if (!part || typeof part.value !== 'number') {
            leaks.push({ severity: 'error', rule: 'bad-derived', message: `metric "${key}" sums unknown or non-scalar metric "${ref}"` })
            broken = true
            continue
          }
          computed += part.value
        }
        if (!broken && computed !== m.value) {
          leaks.push({
            severity: 'error',
            rule: 'derived-mismatch',
            message: `metric "${key}" is ${m.value}, but its parts sum to ${computed}`,
          })
        }
      } else if (m.derived.op === 'pct_change') {
        const computed = (m.derived.after - m.derived.before) / m.derived.before
        if (!roundsTo(m.value, computed)) {
          leaks.push({
            severity: 'error',
            rule: 'derived-mismatch',
            message: `metric "${key}" is ${m.value}, but ${m.derived.before} → ${m.derived.after} computes to ${computed.toFixed(4)}`,
            detail: 'A derived value must be correctly rounded to its own precision.',
          })
        }
      }
    } else {
      // a measured value must say where it came from and when
      for (const field of ['source', 'window', 'fetched_at'] as const) {
        if (m[field] === undefined) {
          leaks.push({ severity: 'error', rule: 'missing-field', message: `metric "${key}" has no ${field}` })
        }
      }
    }
  }

  return { ir: { identifiers, metrics }, leaks }
}
