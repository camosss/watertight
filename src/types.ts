export type Severity = 'error' | 'warn'

/** A leak is a claim that cannot hold water — the report fails to build while any exist. */
export interface Leak {
  severity: Severity
  /** Stable rule id, e.g. "naked-number" */
  rule: string
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
  | { op: 'pct_change'; before: number; after: number }

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

export interface Ir {
  /** Numbers that are names, not measurements — versions, flags, unit ids */
  identifiers: Record<string, string>
  metrics: Record<string, Metric>
}
