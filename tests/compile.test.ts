import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { compile } from '../src/compile.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-experiment')

/** Write a throwaway report+IR pair and compile it. */
async function compileCase(report: string, ir: object, format: 'html' | 'md' = 'html') {
  const dir = await mkdtemp(join(tmpdir(), 'wt-'))
  const reportPath = join(dir, 'report.md')
  const irPath = join(dir, 'metrics.json')
  await writeFile(reportPath, report)
  await writeFile(irPath, JSON.stringify(ir))
  try {
    return await compile(reportPath, irPath, format)
  } finally {
    await rm(dir, { recursive: true })
  }
}

const MEASURED = {
  value: 42, unit: 'count',
  source: { type: 'csv', file: 'x.csv' }, window: 'w', fetched_at: 't',
}

test('the fixture holds water and renders receipts', async () => {
  const result = await compile(join(FIXTURE, 'report.md'), join(FIXTURE, 'metrics.json'))

  assert.equal(result.leaks.length, 0)
  assert.equal(result.grounded.metrics, 6)
  // a receipt travels with the number: source, window, fetch time in the title attribute
  assert.ok(result.output?.includes('title="sql'))
  assert.ok(result.output?.includes('fetched 2026-09-15'))
  // ranges and identifiers render
  assert.ok(result.output?.includes('1,000~5,000'))
  assert.ok(result.output?.includes('<code>3.2.0</code>'))
})

test('a number outside a reference is a leak', async () => {
  const { leaks, output: html } = await compileCase('CTR was 0.8% overall.', { metrics: { x: MEASURED } })

  assert.ok(leaks.some((l) => l.rule === 'naked-number' && l.message.includes('0.8%')))
  assert.equal(html, undefined)
})

test('dates, headings, code and raw spans are not leaks', async () => {
  const { leaks } = await compileCase(
    '# 2 phases\n\nSince 2026-09-01, `retry(3)` ran. Roughly {{raw:one in five}} sessions. Count: {{m:x}}',
    { metrics: { x: MEASURED } },
  )
  assert.equal(leaks.length, 0)
})

test('a dangling reference is a leak', async () => {
  const { leaks } = await compileCase('Value: {{m:missing}} and {{id:ghost}}', { metrics: { x: MEASURED } })
  assert.equal(leaks.filter((l) => l.rule === 'unknown-ref').length, 2)
})

test('a ratio without a definition is a leak', async () => {
  const { leaks } = await compileCase('Rate: {{m:fr}}', {
    metrics: { fr: { ...MEASURED, unit: 'ratio' } },
  })
  assert.ok(leaks.some((l) => l.rule === 'definition-required'))
})

test('a sum that does not add up is a leak', async () => {
  const { leaks } = await compileCase('Total: {{m:total}}', {
    metrics: {
      a: { ...MEASURED, value: 45 },
      b: { ...MEASURED, value: 1383 },
      total: { value: 1440, unit: 'count', derived: { op: 'sum', of: ['a', 'b'] } },
    },
  })
  assert.ok(leaks.some((l) => l.rule === 'derived-mismatch' && l.message.includes('1428')))
})

// The policy that caught a rounding error in the first real document this schema met:
// a stored value must be correctly rounded to its own precision
test('0.15 for a computed 15.5% change is a leak; 0.155 is not', async () => {
  const ir = (value: number) => ({
    metrics: {
      change: {
        value, unit: 'ratio-point', definition: 'd',
        derived: { op: 'pct_change', before: 290, after: 335 },
      },
    },
  })
  const wrong = await compileCase('Change: {{m:change}}', ir(0.15))
  assert.ok(wrong.leaks.some((l) => l.rule === 'derived-mismatch'))

  const right = await compileCase('Change: {{m:change}}', ir(0.155))
  assert.equal(right.leaks.length, 0)
})

test('a measured metric without provenance fields is a leak', async () => {
  const { leaks } = await compileCase('V: {{m:x}}', { metrics: { x: { value: 1, unit: 'count' } } })
  const missing = leaks.filter((l) => l.rule === 'missing-field').map((l) => l.message)
  assert.equal(missing.length, 3) // source, window, fetched_at
})

test('an empty IR never passes', async () => {
  const { leaks } = await compileCase('No numbers here.', { metrics: {} })
  assert.ok(leaks.some((l) => l.rule === 'empty-ir'))
})

test('narrative html is escaped — injection cannot ride a report', async () => {
  // no digits in the payload — a digit would (correctly) be flagged as a leak first
  const { html, leaks } = await compileCase('<script>alert("x")</script> count {{m:x}}', { metrics: { x: MEASURED } })
  assert.equal(leaks.length, 0)
  assert.ok(!html?.includes('<script>'))
})

test('a claim renders with the receipts of its evidence', async () => {
  const { leaks, output: html, grounded } = await compileCase(
    'Numbers: {{m:x}}. {{claim: it worked | evidence: x}}',
    { metrics: { x: MEASURED } },
  )
  assert.equal(leaks.length, 0)
  assert.equal(grounded.claims, 1)
  assert.ok(html?.includes('class="c"'))
  assert.ok(html?.includes('x = 42 count'))
})

test('a claim without evidence is a leak, in both spellings', async () => {
  const bare = await compileCase('{{claim: it worked}}', { metrics: { x: MEASURED } })
  assert.ok(bare.leaks.some((l) => l.rule === 'claim-without-evidence'))

  const empty = await compileCase('{{claim: it worked | evidence: }}', { metrics: { x: MEASURED } })
  assert.ok(empty.leaks.some((l) => l.rule === 'claim-without-evidence'))
})

test('a claim citing an unknown metric is a leak', async () => {
  const { leaks } = await compileCase('{{claim: fine | evidence: ghost}}', { metrics: { x: MEASURED } })
  assert.ok(leaks.some((l) => l.rule === 'unknown-ref' && l.message.includes('ghost')))
})

test('a number smuggled into claim text is still a leak', async () => {
  const { leaks } = await compileCase('{{claim: lifted 12% | evidence: x}}', { metrics: { x: MEASURED } })
  assert.ok(leaks.some((l) => l.rule === 'naked-number' && l.message.includes('12%')))
})

test('md format renders superscripts and a receipts appendix', async () => {
  const result = await compile(join(FIXTURE, 'report.md'), join(FIXTURE, 'metrics.json'), 'md')
  assert.equal(result.leaks.length, 0)
  // first metric use gets superscript 1, and the appendix lists it with its receipt
  assert.match(result.output ?? '', /\*\*.+\*\* ⁽¹⁾/)
  assert.match(result.output ?? '', /### Receipts \(6 metrics\)/)
  // identifiers stay as code spans, claims keep their evidence inline
  assert.ok(result.output?.includes('`3.2.0`'))
  assert.match(result.output ?? '', /\*\(evidence: /)
  // no HTML leaked into the markdown output
  assert.ok(!result.output?.includes('<span'))
})

test('md format repeats the same superscript for a reused metric', async () => {
  const { output } = await compileCase(
    'A {{m:x}} and again {{m:x}} then {{m:y}}.',
    { metrics: { x: MEASURED, y: { ...MEASURED, value: 7 } } },
    'md',
  )
  const supers = [...(output ?? '').matchAll(/⁽([⁰¹²³⁴⁵⁶⁷⁸⁹]+)⁾/g)].map((m) => m[1])
  // body only — the appendix numbers with an ordered list, not superscripts
  assert.deepEqual(supers, ['¹', '¹', '²'])
})

test('pct_change endpoints may be metric keys, and an unknown key is a leak', async () => {
  const base = {
    a: { ...MEASURED, value: 200 },
    b: { ...MEASURED, value: 300 },
  }
  const good = await compileCase('Change: {{m:d}} from {{m:a}} to {{m:b}}.', {
    metrics: { ...base, d: { value: 0.5, unit: 'ratio-point', definition: 'x', derived: { op: 'pct_change', before: 'a', after: 'b' } } },
  })
  assert.equal(good.leaks.length, 0)

  const bad = await compileCase('Change: {{m:d}}.', {
    metrics: { ...base, d: { value: 0.5, unit: 'ratio-point', definition: 'x', derived: { op: 'pct_change', before: 'a', after: 'nope' } } },
  })
  assert.deepEqual(bad.leaks.map((l) => l.rule), ['bad-derived'])
})
