import type { Leak } from './types.js'

/** Same-length whitespace, newlines kept — stripping must not move anything */
const blank = (s: string): string => s.replace(/[^\n]/g, ' ')

const lineAt = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length

/** Code shows syntax, it does not state facts — refs and numbers inside it are exempt */
export const blankCode = (report: string): string =>
  report.replace(/```[\s\S]*?```/g, blank).replace(/`[^`\n]*`/g, blank)

/**
 * Find numbers in the narrative that are not bound to the IR. These are the leaks the
 * tool exists to catch: a typed, transcribed, or hallucinated figure reads exactly like
 * a real one, so none are allowed outside a reference.
 */
/** The prose that remains once every non-statement region is blanked in place. */
function strippedProse(report: string): string {
  return report
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
    .replace(/\]\([^)\s]*\)/g, blank)          // markdown link targets — URLs locate, they do not measure
    .replace(/https?:\/\/\S+/g, blank)         // bare URLs, same reason
    .replace(/\d{4}-\d{2}-\d{2}/g, blank)      // ISO dates locate, they do not measure
    .replace(/(?<![A-Za-z0-9가-힣])[A-Za-z]+\d[\w.\-]*/g, blank) // Q3, v6.109.0, iOS15 — names, not measurements
    .replace(/^#{1,6}(?= )/gm, blank)          // heading markers only — heading TEXT is scanned, people summarise numbers there
    .replace(/^\s*\d+\.\s/gm, blank)           // ordered-list markers
}

export function scanNakedNumbers(report: string): Leak[] {
  const stripped = strippedProse(report)
  const leaks: Leak[] = []
  for (const m of stripped.matchAll(/\d[\d,.]*\s*(%p?|[가-힣]{1,2})?/g)) {
    const token = m[0].trim().replace(/[.,]+$/, '')
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
export function scanRefs(
  rawReport: string,
  metricKeys: Set<string>,
  idKeys: Set<string>,
  assertionKeys: Set<string> = new Set(),
): Leak[] {
  const leaks: Leak[] = []
  const report = blankCode(rawReport)
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
      if (!metricKeys.has(key) && !assertionKeys.has(key)) {
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

/**
 * Anything still shaped like a marker after every recognised form is removed was a typo —
 * and a typo'd marker must be a leak, or it renders verbatim and its number sails through.
 */
export function scanMarkers(rawReport: string): Leak[] {
  const known = blankCode(rawReport)
    .replace(/\{\{(m|id):[\w-]+\}\}/g, blank)
    .replace(/\{\{raw:[^}]*\}\}/g, blank)
    .replace(/\{\{claim:[^|}]*\|\s*evidence:[^}]*\}\}/g, blank)
    .replace(/\{\{claim:[^|}]*\}\}/g, blank) // no-pipe form is already claim-without-evidence
  const leaks: Leak[] = []
  for (const m of known.matchAll(/\{\{[^}]*\}\}?/g)) {
    leaks.push({
      severity: 'error',
      rule: 'malformed-marker',
      line: lineAt(known, m.index),
      message: `"${m[0]}" is not a recognised marker`,
      detail: 'Valid forms: {{m:key}}, {{id:key}}, {{raw:…}}, {{claim: text | evidence: keys}}.',
    })
  }
  return leaks
}

// Narrow on purpose: a false worded-number on 배송 or 건물 costs more trust than a
// missed 수사 표현. Longest alternatives first; boundaries block compound words.
const WORDED_KO_COUNTED = /(?<![가-힣])(한|두|세|네|다섯|여섯|일곱|여덟|아홉|열|몇)\s?(배|건|명|번|곳|개)(?![가-힣])/g
const WORDED_KO_STANDALONE = /(?<![가-힣])(절반|과반|대다수|수십만|수백만|수천만|수억|수십|수백|수천|수만)(\s?(배|건|명|번|곳|개|원|회))?(?![가-힣])/g
const WORDED_EN = /\b(doubled?|tripled?|halved|half of|a million|millions of|thousands of|dozens of)\b/gi

/** Quantities written in words — the digit scanner cannot see them, but a reader does. */
export function scanWordedNumbers(report: string): Leak[] {
  const stripped = strippedProse(report)
  const leaks: Leak[] = []
  for (const re of [WORDED_KO_COUNTED, WORDED_KO_STANDALONE, WORDED_EN]) {
    for (const m of stripped.matchAll(re)) {
      leaks.push({
        severity: 'warn',
        rule: 'worded-number',
        line: lineAt(stripped, m.index),
        message: `"${m[0].trim()}" is a quantity in words — no receipt can bind to it`,
        detail: 'If it has a basis, state it as {{m:…}} or a derived metric; if it is rhetoric, mark it {{raw:…}}.',
      })
    }
  }
  return leaks.sort((x, y) => (x.line ?? 0) - (y.line ?? 0))
}