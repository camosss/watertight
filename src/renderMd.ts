import { formatValue, protectCode, receipt } from './render.js'
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
      return `**${formatValue(ir.metrics[key])}** ${sup(used.indexOf(key) + 1)}`
    })
    .replace(/\{\{id:([\w-]+)\}\}/g, (_, key) => `\`${ir.identifiers[key]}\``)
    .replace(
      /\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g,
      (_, text, evidence) => `**${text.trim()}** *(evidence: ${evidence.trim()})*`,
    )
    .replace(/\{\{raw:([^}]*)\}\}/g, (_, text) => text))

  const appendix = used
    .map((key, i) => {
      const m = ir.metrics[key]
      const definition = m.definition ? ` — ${m.definition}` : ''
      return `${i + 1}. **${key}** = ${formatValue(m)}${definition}\n   ${receipt(m, false)}`
    })
    .join('\n')

  return `${body.trimEnd()}\n\n---\n\n### Receipts (${used.length} metrics)\n\n${appendix}\n`
}
