import type { Ir, Metric } from './types.js'

/**
 * Code shows syntax, it does not state facts — a fenced example of {{m:…}} must render
 * verbatim, not substitute. Stash code regions before substitution, restore after.
 */
export function protectCode(text: string): { text: string; restore: (s: string) => string } {
  const stash: string[] = []
  const protectedText = text.replace(/```[\s\S]*?```|`[^`\n]*`/g, (m) => {
    stash.push(m)
    return `\u0000${stash.length - 1}\u0000`
  })
  return { text: protectedText, restore: (s) => s.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]) }
}

function escapeHtml(s: string) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function formatValue(m: Metric): string {
  if (Array.isArray(m.value)) {
    const [lo, hi] = m.value
    return `${lo.toLocaleString()}~${hi.toLocaleString()}${m.unit === 'ratio' ? '%' : ` ${m.unit}`}`
  }
  if (m.unit === 'ratio') return `${(m.value * 100).toFixed(m.value < 0.01 ? 2 : 1)}%`
  if (m.unit === 'ratio-point') return `${m.value >= 0 ? '+' : ''}${(m.value * 100).toFixed(1)}%p`
  return `${m.value.toLocaleString()} ${m.unit}`.trim()
}

export function receipt(m: Metric, includeDefinition = true): string {
  const source = m.derived
    ? m.derived.op === 'sum'
      ? `= ${m.derived.of.join(' + ')} (recomputed)`
      : `= ${m.derived.before} → ${m.derived.after} (recomputed)`
    : [m.source?.type, ...Object.entries(m.source ?? {}).filter(([k]) => k !== 'type').map(([, v]) => String(v))].filter(Boolean).join(' · ')
  return [source, m.window, m.fetched_at && `fetched ${m.fetched_at}`, includeDefinition && m.definition].filter(Boolean).join(' · ')
}

/** Minimal markdown: headings, paragraphs, bold, unordered lists. The narrative layer is deliberately thin. */
function markdown(src: string): string {
  return src
    .split(/\n{2,}/)
    .map((block) => {
      const h = block.match(/^(#{1,3}) (.*)$/s)
      if (h) return `<h${h[1].length}>${h[2]}</h${h[1].length}>`
      if (/^- /m.test(block)) {
        return `<ul>${block.split('\n').map((l) => `<li>${l.replace(/^- /, '')}</li>`).join('')}</ul>`
      }
      return `<p>${block.replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
}

export function render(report: string, ir: Ir): string {
  const { text: protectedReport, restore } = protectCode(escapeHtml(report))
  const grounded = restore(protectedReport
    .replace(/\{\{m:([\w-]+)\}\}/g, (_, key) => {
      const m = ir.metrics[key]
      return `<b class="w" title="${escapeHtml(receipt(m))}">${formatValue(m)}<sup>†</sup></b>`
    })
    .replace(/\{\{id:([\w-]+)\}\}/g, (_, key) => `<code>${escapeHtml(ir.identifiers[key])}</code>`)
    .replace(/\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g, (_, text, evidence) => {
      const keys = evidence.split(',').map((k: string) => k.trim()).filter(Boolean)
      const receipts = keys
        .map((k: string) => `${k} = ${formatValue(ir.metrics[k])} (${receipt(ir.metrics[k])})`)
        .join(' | ')
      return `<span class="c" title="${escapeHtml(receipts)}">${text.trim()}<sup>‡</sup></span>`
    })
    .replace(/\{\{raw:([^}]*)\}\}/g, (_, text) => escapeHtml(text)))

  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{font:15px/1.75 -apple-system,system-ui,sans-serif;max-width:720px;margin:40px auto;padding:0 16px;color:#1a1a1a}
  @media(prefers-color-scheme:dark){body{background:#111;color:#ddd}code{background:#222}}
  h1,h2,h3{line-height:1.3}
  .w{border-bottom:2px solid #4a9;cursor:help;font-weight:600}
  .c{border-bottom:2px dotted #4a9;cursor:help}
  code{background:#eee;padding:1px 5px;border-radius:4px;font-size:.9em}
  sup{font-size:.65em;color:#4a9}
</style>
<body>${markdown(grounded)}
<hr><p style="color:#888;font-size:.85em">Compiled by watertight — every underlined figure carries its receipt (hover to see it).</p>`
}
