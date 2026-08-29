import { formatValue, linkifyMd, metricKind, protectCode, receipt } from './render.js'
import type { Ir } from './types.js'

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const sup = (n: number): string => `⁽${String(n).split('').map((d) => SUPERSCRIPT[Number(d)]).join('')}⁾`

/**
 * Grounded markdown: the portable render target. Every figure is bold with a superscript
 * that points into a receipts appendix, so the output pastes into Notion, a PR body, or
 * Slack without losing its provenance. Posting is deliberately left to the caller —
 * keeping publishing out of the tool is what keeps the tool free of anyone's auth.
 */
export function renderMarkdown(report: string, ir: Ir): string {
  const used: string[] = []

  const { text: protectedReport, restore } = protectCode(report)
  const body = restore(protectedReport
    .replace(/\{\{m:([\w-]+)\}\}/g, (_, key) => {
      if (!used.includes(key)) used.push(key)
      const m = ir.metrics[key]
      const marker = sup(used.indexOf(key) + 1)
      // an assumption reads differently at a glance: ⁽³ᵃ⁾, and the appendix says why
      return `**${formatValue(m)}** ${metricKind(m) === 'assumption' ? marker.replace('⁾', 'ᵃ⁾') : marker}`
    })
    .replace(/\{\{id:([\w-]+)\}\}/g, (_, key) => `\`${ir.identifiers[key]}\``)
    .replace(
      /\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g,
      (_, text, evidence) => `**${text.trim()}** *(evidence: ${evidence.trim()})*`,
    )
    .replace(/\{\{raw:([^}]*)\}\}/g, (_, text) => text))

  // evidence-only metrics get receipts too — a claim's reader must be able to check its keys
  for (const [, , evidence] of protectedReport.matchAll(/\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g)) {
    for (const key of evidence.split(',').map((k) => k.trim()).filter(Boolean)) {
      if (ir.metrics[key] && !used.includes(key)) used.push(key)
    }
  }

  // the report discloses its own escape hatches — a reader (and a reviewer) sees
  // exactly which prose numbers carry no receipt
  const raws = [...protectedReport.matchAll(/\{\{raw:([^}]*)\}\}/g)].map((m) => m[1].trim())
  const rawSection =
    raws.length === 0
      ? ''
      : `\n\n### Ungrounded (${raws.length} raw escape${raws.length === 1 ? '' : 's'})\n\n${raws
          .map((r) => `- ${r}`)
          .join('\n')}`

  const appendix = used
    .map((key, i) => {
      const m = ir.metrics[key]
      const definition = m.definition ? ` — ${m.definition}` : ''
      const tag = metricKind(m) === 'assumption' ? ' *(assumption — not measured)*' : ''
      return `${i + 1}. **${key}** = ${formatValue(m)}${definition}${tag}\n   ${linkifyMd(receipt(m, false))}`
    })
    .join('\n')

  return `${body.trimEnd()}\n\n---\n\n### Receipts (${used.length} metrics)\n\n${appendix}${rawSection}\n`
}
