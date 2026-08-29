import type { Leak } from './types.js'

/** Same-length whitespace, newlines kept — stripping must not move anything */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ')

const lineAt = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length

/**
 * Find numbers in the narrative that are not bound to the IR. These are the leaks the
 * tool exists to catch: a typed, transcribed, or hallucinated figure reads exactly like
 * a real one, so none are allowed outside a reference.
 */
export function scanNakedNumbers(report: string): Leak[] {
  const stripped = report
    .replace(/\{\{(m|id):[\w-]+\}\}/g, blank)
    // a claim's prose stays scanned — only its syntax is blanked, so a number
    // smuggled into claim text is still a leak, at its true position
    .replace(/\{\{claim:([^|}]*)\|[^}]*\}\}/g, (whole, text: string) => {
      const start = whole.indexOf(text)
      return blank(whole.slice(0, start)) + text + blank(whole.slice(start + text.length))
    })
    .replace(/\{\{raw:[^}]*\}\}/g, blank)     // explicit, greppable escape hatch
    .replace(/```[\s\S]*?```/g, blank)         // fenced code
    .replace(/`[^`\n]*`/g, blank)              // inline code
    .replace(/\d{4}-\d{2}-\d{2}/g, blank)      // ISO dates locate, they do not measure
    .replace(/^#+ .*$/gm, blank)               // headings
    .replace(/^\s*\d+\.\s/gm, blank)           // ordered-list markers

  const leaks: Leak[] = []
  for (const m of stripped.matchAll(/\d[\d,.]*\s*(%p?|[가-힣]{1,2})?/g)) {
    const token = m[0].trim()
    if (!token) continue
    leaks.push({
      severity: 'error',
      rule: 'naked-number',
      line: lineAt(stripped, m.index),
      message: `"${token}" appears in the narrative without a receipt`,
      detail: 'Bind it to the IR as {{m:…}} or {{id:…}}, or mark deliberate prose as {{raw:…}}.',
    })
  }
  return leaks
}

/** Every reference in the narrative must resolve; a dangling one is authoring drift. */
export function scanRefs(report: string, metricKeys: Set<string>, idKeys: Set<string>): Leak[] {
  const leaks: Leak[] = []
  for (const m of report.matchAll(/\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g)) {
    const [, text, evidence] = m
    const line = lineAt(report, m.index)
    const keys = evidence.split(',').map((k) => k.trim()).filter(Boolean)
    if (keys.length === 0) {
      leaks.push({
        severity: 'error',
        rule: 'claim-without-evidence',
        line,
        message: `claim "${text.trim()}" names no evidence`,
        detail: 'A conclusion must point at the metrics it rests on. Whether they support it stays a human judgement — but they must be attached.',
      })
    }
    for (const key of keys) {
      if (!metricKeys.has(key)) {
        leaks.push({ severity: 'error', rule: 'unknown-ref', line, message: `claim "${text.trim()}" cites unknown metric "${key}"` })
      }
    }
  }
  // a claim marker missing its evidence clause entirely is malformed, not exempt
  for (const m of report.matchAll(/\{\{claim:([^|}]*)\}\}/g)) {
    leaks.push({
      severity: 'error',
      rule: 'claim-without-evidence',
      line: lineAt(report, m.index),
      message: `claim "${m[1].trim()}" names no evidence`,
      detail: 'Write it as {{claim: … | evidence: metric_key}}.',
    })
  }
  for (const m of report.matchAll(/\{\{m:([\w-]+)\}\}/g)) {
    if (!metricKeys.has(m[1])) {
      leaks.push({ severity: 'error', rule: 'unknown-ref', line: lineAt(report, m.index), message: `{{m:${m[1]}}} is not in the IR` })
    }
  }
  for (const m of report.matchAll(/\{\{id:([\w-]+)\}\}/g)) {
    if (!idKeys.has(m[1])) {
      leaks.push({ severity: 'error', rule: 'unknown-ref', line: lineAt(report, m.index), message: `{{id:${m[1]}}} is not in the IR` })
    }
  }
  return leaks
}
