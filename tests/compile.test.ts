import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { compile } from '../src/compile.js'

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'sample-experiment')

/** Write a throwaway report+IR pair and compile it. */
async function compileCase(report: string, ir: object) {
  const dir = await mkdtemp(join(tmpdir(), 'wt-'))
  const reportPath = join(dir, 'report.md')
  const irPath = join(dir, 'metrics.json')
  await writeFile(reportPath, report)
  await writeFile(irPath, JSON.stringify(ir))
  try {
    return await compile(reportPath, irPath)
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
  assert.ok(result.html?.includes('title="sql'))
  assert.ok(result.html?.includes('fetched 2026-09-15'))
  // ranges and identifiers render
  assert.ok(result.html?.includes('1,000~5,000'))
  assert.ok(result.html?.includes('<code>3.2.0</code>'))
})

test('a number outside a reference is a leak', async () => {
  const { leaks, html } = await compileCase('CTR was 0.8% overall.', { metrics: { x: MEASURED } })

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
