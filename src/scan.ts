import type { Leak } from './types.js'

/**
 * Find numbers in the narrative that are not bound to the IR. These are the leaks the
 * tool exists to catch: a typed, transcribed, or hallucinated figure reads exactly like
 * a real one, so none are allowed outside a reference.
 */
export function scanNakedNumbers(report: string): Leak[] {
  const stripped = report
    .replace(/\{\{(m|id):[\w-]+\}\}/g, ' ')
    // a claim's prose stays scanned — only its syntax is removed, so a number
    // smuggled into claim text is still a leak
    .replace(/\{\{claim:([^|}]*)\|[^}]*\}\}/g, (_, text) => ` ${text} `)
    .replace(/\{\{raw:[^}]*\}\}/g, ' ')      // explicit, greppable escape hatch
    .replace(/```[\s\S]*?```/g, ' ')          // fenced code
    .replace(/`[^`\n]*`/g, ' ')               // inline code
    .replace(/\d{4}-\d{2}-\d{2}/g, ' ')       // ISO dates locate, they do not measure
    .replace(/^#+ .*$/gm, ' ')                // headings
    .replace(/^\s*\d+\.\s/gm, ' ')            // ordered-list markers

  const leaks: Leak[] = []
  for (const m of stripped.matchAll(/\d[\d,.]*\s*(%p?|[가-힣]{1,2})?/g)) {
    const token = m[0].trim()
    if (!token) continue
    leaks.push({
      severity: 'error',
      rule: 'naked-number',
      message: `"${token}" appears in the narrative without a receipt`,
      detail: 'Bind it to the IR as {{m:…}} or {{id:…}}, or mark deliberate prose as {{raw:…}}.',
    })
  }
  return leaks
}

/** Every reference in the narrative must resolve; a dangling one is authoring drift. */
export function scanRefs(report: string, metricKeys: Set<string>, idKeys: Set<string>): Leak[] {
  const leaks: Leak[] = []
  for (const [, text, evidence] of report.matchAll(/\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g)) {
    const keys = evidence.split(',').map((k) => k.trim()).filter(Boolean)
    if (keys.length === 0) {
      leaks.push({
        severity: 'error',
        rule: 'claim-without-evidence',
        message: `claim "${text.trim()}" names no evidence`,
        detail: 'A conclusion must point at the metrics it rests on. Whether they support it stays a human judgement — but they must be attached.',
      })
    }
    for (const key of keys) {
      if (!metricKeys.has(key)) {
        leaks.push({ severity: 'error', rule: 'unknown-ref', message: `claim "${text.trim()}" cites unknown metric "${key}"` })
      }
    }
  }
  // a claim marker missing its evidence clause entirely is malformed, not exempt
  for (const [, text] of report.matchAll(/\{\{claim:([^|}]*)\}\}/g)) {
    leaks.push({
      severity: 'error',
      rule: 'claim-without-evidence',
      message: `claim "${text.trim()}" names no evidence`,
      detail: 'Write it as {{claim: … | evidence: metric_key}}.',
    })
  }
  for (const [, key] of report.matchAll(/\{\{m:([\w-]+)\}\}/g)) {
    if (!metricKeys.has(key)) {
      leaks.push({ severity: 'error', rule: 'unknown-ref', message: `{{m:${key}}} is not in the IR` })
    }
  }
  for (const [, key] of report.matchAll(/\{\{id:([\w-]+)\}\}/g)) {
    if (!idKeys.has(key)) {
      leaks.push({ severity: 'error', rule: 'unknown-ref', message: `{{id:${key}}} is not in the IR` })
    }
  }
  return leaks
}
