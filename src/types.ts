export type Severity = 'error' | 'warn' | 'info'

/** A leak is a claim that cannot hold water — the report fails to build while any exist. */
export interface Leak {
  severity: Severity
  /** Stable rule id, e.g. "naked-number" */
  rule: string
  /** 1-indexed line in the narrative, when the leak has a location there */
  line?: number
  message: string
  /** Why it matters, or how to fix it */
  detail?: string
}

export interface Source {
  /** Adapter tag — "mixpanel", "sql", "csv", "hypothesis", … The core treats the rest as opaque. */
  type: string
  [key: string]: unknown
}

export type Derived =
  | { op: 'sum'; of: string[] }
  | { op: 'avg'; of: string[] }
  /** Endpoints are metric keys (recommended — each endpoint then carries its own receipt) or inline numbers */
  | { op: 'pct_change'; before: number | string; after: number | string }
  /** a / b — for rates the narrative states directly */
  | { op: 'ratio'; a: number | string; b: number | string }
  /** a − b */
  | { op: 'diff'; a: number | string; b: number | string }

export interface Metric {
  /** A single value, or [low, high] for a range */
  value: number | [number, number]
  /** Freeform. "ratio" renders as %, "ratio-point" as %p; anything else is a verbatim suffix. */
  unit: string
  /** Required for ratio units — footgun metrics must say how they are aggregated */
  definition?: string
  source?: Source
  window?: string
  fetched_at?: string
  derived?: Derived
}

/**
 * A machine-judged comparison — the arithmetic half of a conclusion ("under target",
 * "no cannibalisation"). Operands are metric keys, range accessors (key.lo / key.hi),
 * or inline numbers. A false assertion fails the build: when refresh moves a number
 * far enough to flip the conclusion, the report stops compiling until it is rewritten.
 */
export interface Assertion {
  op: 'lt' | 'lte' | 'gt' | 'gte'
  a: number | string
  b: number | string
}

export interface Ir {
  /** Numbers that are names, not measurements — versions, flags, unit ids */
  identifiers: Record<string, string>
  metrics: Record<string, Metric>
  assertions: Record<string, Assertion>
}
