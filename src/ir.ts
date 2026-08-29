import type { Ir, Leak, Metric } from './types.js'

/** Units whose meaning depends on how they were aggregated — a bare value misleads. */
const DEFINITION_REQUIRED = new Set(['ratio', 'ratio-point'])

function decimals(n: number): number {
  const s = String(n)
  const e = s.indexOf('e')
  if (e !== -1) {
    // 1e-7 has 7 decimals, 1.5e-7 has 8 — exponential notation must not disarm the precision check
    const exp = Number(s.slice(e + 1))
    const mantissa = s.slice(0, e)
    const dot = mantissa.indexOf('.')
    return Math.max(0, (dot === -1 ? 0 : mantissa.length - dot - 1) - exp)
  }
  const dot = s.indexOf('.')
  return dot === -1 ? 0 : s.length - dot - 1
}

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

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
  // an identifier names a thing (version, flag, unit id); a value shaped like a
  // measurement is a number smuggled past the receipt requirement through the id door
  const MEASUREMENT_SHAPE = /(%p?$)|(^\d{1,3}(,\d{3})+(\.\d+)?$)/
  for (const [k, v] of Object.entries((root['identifiers'] as object) ?? {})) {
    identifiers[k] = String(v)
    if (MEASUREMENT_SHAPE.test(identifiers[k].trim())) {
      leaks.push({
        severity: 'error',
        rule: 'identifier-measurement',
        message: `identifier "${k}" is "${identifiers[k]}" — that is a measurement, not a name`,
        detail: 'Move it to metrics with a source, or it is a number without a receipt.',
      })
    }
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
    if (!m || typeof m !== 'object') {
      leaks.push({ severity: 'error', rule: 'missing-field', message: `metric "${key}" is not an object` })
      continue
    }
    const valueOk =
      isFiniteNumber(m.value) ||
      (Array.isArray(m.value) && m.value.length === 2 && m.value.every(isFiniteNumber))
    if (!valueOk) {
      leaks.push({ severity: 'error', rule: 'missing-field', message: `metric "${key}" has no usable numeric value` })
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
      const endpoint = (v: number | string): number | undefined => {
        if (typeof v === 'number') return v
        const ref = metrics[v]
        return ref && typeof ref.value === 'number' ? ref.value : undefined
      }
      if (m.derived.op === 'sum' || m.derived.op === 'avg') {
        let total = 0
        let broken = false
        for (const ref of m.derived.of) {
          const part = metrics[ref]
          if (!part || typeof part.value !== 'number') {
            leaks.push({ severity: 'error', rule: 'bad-derived', message: `metric "${key}" ${m.derived.op}s unknown or non-scalar metric "${ref}"` })
            broken = true
            continue
          }
          total += part.value
        }
        const computed = m.derived.op === 'avg' ? total / m.derived.of.length : total
        if (!broken && !roundsTo(m.value, computed)) {
          leaks.push({
            severity: 'error',
            rule: 'derived-mismatch',
            message: `metric "${key}" is ${m.value}, but its parts ${m.derived.op === 'avg' ? 'average' : 'sum'} to ${computed}`,
          })
        }
      } else if (m.derived.op === 'pct_change') {
        const before = endpoint(m.derived.before)
        const after = endpoint(m.derived.after)
        if (before === undefined || after === undefined || before === 0) {
          leaks.push({
            severity: 'error',
            rule: 'bad-derived',
            message: `metric "${key}": pct_change endpoints must be numbers or scalar metric keys (got ${m.derived.before} → ${m.derived.after})`,
          })
          continue
        }
        const computed = (after - before) / before
        if (!roundsTo(m.value, computed)) {
          leaks.push({
            severity: 'error',
            rule: 'derived-mismatch',
            message: `metric "${key}" is ${m.value}, but ${m.derived.before} → ${m.derived.after} computes to ${computed.toFixed(4)}`,
            detail: 'A derived value must be correctly rounded to its own precision.',
          })
        }
      } else if (m.derived.op === 'ratio' || m.derived.op === 'diff') {
        const a = endpoint(m.derived.a)
        const b = endpoint(m.derived.b)
        if (a === undefined || b === undefined || (m.derived.op === 'ratio' && b === 0)) {
          leaks.push({
            severity: 'error',
            rule: 'bad-derived',
            message: `metric "${key}": ${m.derived.op} operands must be numbers or scalar metric keys (got ${m.derived.a}, ${m.derived.b})`,
          })
          continue
        }
        const computed = m.derived.op === 'ratio' ? a / b : a - b
        if (!roundsTo(m.value, computed)) {
          leaks.push({
            severity: 'error',
            rule: 'derived-mismatch',
            message: `metric "${key}" is ${m.value}, but ${m.derived.a} ${m.derived.op === 'ratio' ? '/' : '−'} ${m.derived.b} computes to ${computed.toFixed(4)}`,
            detail: 'A derived value must be correctly rounded to its own precision.',
          })
        }
      } else {
        // an op the verifier cannot recompute must never pass as verified
        leaks.push({
          severity: 'error',
          rule: 'bad-derived',
          message: `metric "${key}" has unknown derived op "${(m.derived as { op: string }).op}"`,
          detail: 'Supported ops: sum, pct_change. A derivation the compiler cannot recompute cannot hold water.',
        })
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
