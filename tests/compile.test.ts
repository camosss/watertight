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

test('dates, code, urls and raw spans are not leaks — heading text is', async () => {
  const { leaks } = await compileCase(
    '# Rollout\n\nSince 2026-09-01, `retry(3)` ran. Roughly {{raw:one in five}} sessions. '
      + 'See [dash](https://mixpanel.com/project/2773336) or https://x.com/p/42. Count: {{m:x}}',
    { metrics: { x: MEASURED } },
  )
  assert.equal(leaks.length, 0)

  // people summarise numbers in headings — those are claims like any other
  const heading = await compileCase('# Growth hit 47% this quarter\n\nBody {{m:x}}.', { metrics: { x: MEASURED } })
  assert.deepEqual(heading.leaks.map((l) => l.rule), ['naked-number'])
  assert.match(heading.leaks[0].message, /47%/)
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
  assert.deepEqual(bad.leaks.filter((l) => l.severity === 'error').map((l) => l.rule), ['bad-derived'])
})

test('a leak carries the line it lives on, even after stripping', async () => {
  const report = [
    '# Heading 42',                       // exempt
    '',
    'Clean line with {{m:x}}.',
    'A naked 1440 hides here.',           // line 4
    '',
    '{{claim: too big | evidence: nope}}', // line 6
    '{{m:ghost}} dangles.',                // line 7
  ].join('\n')
  const { leaks } = await compileCase(report, { metrics: { x: MEASURED } })
  const at = Object.fromEntries(leaks.map((l) => [l.rule + (l.message.includes('ghost') ? ':ghost' : ''), l.line]))
  assert.equal(at['naked-number'], 4)
  assert.equal(at['unknown-ref'], 6)      // claim citing unknown metric
  assert.equal(at['unknown-ref:ghost'], 7)
})

test('max-age fails old receipts, spares fresh ones and dateless hypotheses', async () => {
  const now = new Date('2026-09-15')
  const ir = {
    metrics: {
      fresh: { ...MEASURED, fetched_at: '2026-09-10' },
      old: { ...MEASURED, fetched_at: '2026-07-01' },
      plan: { ...MEASURED, source: { type: 'hypothesis' }, fetched_at: '-' },
    },
  }
  const dir = await mkdtemp(join(tmpdir(), 'wt-'))
  await writeFile(join(dir, 'report.md'), 'Values: {{m:fresh}} {{m:old}} {{m:plan}}.')
  await writeFile(join(dir, 'metrics.json'), JSON.stringify(ir))

  const stale = await compile(join(dir, 'report.md'), join(dir, 'metrics.json'), { maxAgeDays: 30, now })
  assert.deepEqual(stale.leaks.map((l) => l.rule), ['stale-metric'])
  assert.match(stale.leaks[0].message, /"old".*76 days ago/)

  // without the flag, age is not checked
  const lax = await compile(join(dir, 'report.md'), join(dir, 'metrics.json'))
  assert.equal(lax.leaks.length, 0)
})

test('float sums are compared at the stored precision, not bit-exactly', async () => {
  const part = (v: number) => ({ ...MEASURED, value: v, unit: 'ratio', definition: 'd' })
  const ok = await compileCase('Total {{m:t}} of {{m:a}} {{m:b}}.', {
    metrics: { a: part(0.1), b: part(0.2), t: { value: 0.3, unit: 'ratio', definition: 'd', derived: { op: 'sum', of: ['a', 'b'] } } },
  })
  assert.equal(ok.leaks.length, 0)
  const bad = await compileCase('Total {{m:t}} of {{m:a}} {{m:b}}.', {
    metrics: { a: part(0.1), b: part(0.2), t: { value: 0.31, unit: 'ratio', definition: 'd', derived: { op: 'sum', of: ['a', 'b'] } } },
  })
  assert.deepEqual(bad.leaks.map((l) => l.rule), ['derived-mismatch'])
})

test('an unknown derived op is a leak, never a verification bypass', async () => {
  const { leaks } = await compileCase('Sneaky {{m:s}}.', {
    metrics: { s: { value: 999, unit: 'USD', derived: { op: 'median', of: ['s'] } } },
  })
  assert.deepEqual(leaks.map((l) => l.rule), ['bad-derived'])
  assert.match(leaks[0].message, /unknown derived op "median"/)
})

test('a typo in a marker is a leak, not verbatim output', async () => {
  const { leaks } = await compileCase(
    'Total {{m:x}}. {{claim: it works | evidnce: x}} And {{m: x}} too.',
    { metrics: { x: MEASURED } },
  )
  assert.deepEqual(leaks.map((l) => l.rule).sort(), ['malformed-marker', 'malformed-marker'])
})

test('a null value is a missing-field leak, not a crash', async () => {
  const { leaks } = await compileCase('V {{m:x}}.', { metrics: { x: { ...MEASURED, value: null } } })
  assert.equal(leaks.some((l) => l.rule === 'missing-field'), true)
})

test('exponential notation does not disarm the precision check', async () => {
  const part = (v: number) => ({ ...MEASURED, value: v })
  const { leaks } = await compileCase('T {{m:t}} {{m:a}} {{m:b}}.', {
    metrics: { a: part(1e-7), b: part(5e-8), t: { value: 1e-7, unit: 'count', derived: { op: 'sum', of: ['a', 'b'] } } },
  })
  assert.deepEqual(leaks.map((l) => l.rule), ['derived-mismatch'])
})

test('a syntax example inside a code fence is neither substituted nor a dangling ref', async () => {
  const report = 'Real: {{m:x}}.\n\n```\nExample: {{m:ghost}} renders the value\n```\n\nInline `{{id:nope}}` too.'
  const { leaks, output } = await compileCase(report, { metrics: { x: MEASURED } }, 'md')
  assert.equal(leaks.length, 0)
  assert.ok(output?.includes('{{m:ghost}}'))
  assert.ok(output?.includes('{{id:nope}}'))
})

test('a ratio range converts like a scalar, and ratio-point ranges get %p', async () => {
  const range = (unit: string) => ({
    value: [0.3, 0.5], unit, definition: 'd',
    source: { type: 't' }, window: 'w', fetched_at: '2026-01-01',
  })
  const { leaks, output } = await compileCase(
    'Between {{m:r}} and points {{m:rp}}.',
    { metrics: { r: range('ratio'), rp: range('ratio-point') } },
    'md',
  )
  assert.equal(leaks.length, 0)
  assert.ok(output?.includes('30.0~50.0%'))
  assert.ok(output?.includes('30.0~50.0%p'))
})

test('evidence-only metrics appear in the receipts appendix', async () => {
  const { output } = await compileCase(
    'Body uses {{m:x}}. {{claim: it held | evidence: hidden}}',
    { metrics: { x: MEASURED, hidden: { ...MEASURED, value: 7 } } },
    'md',
  )
  assert.match(output ?? '', /### Receipts \(2 metrics\)/)
  assert.match(output ?? '', /\*\*hidden\*\* = 7/)
})

test('letter-prefixed tokens are names — Q3 and v6.109.0 pass, 약30% does not', async () => {
  const ok = await compileCase('# Q3 rollout in v6.109.0 on iOS15\n\nBody {{m:x}}.', { metrics: { x: MEASURED } })
  assert.equal(ok.leaks.length, 0)
  const korean = await compileCase('약30% 상승. {{m:x}}', { metrics: { x: MEASURED } })
  assert.deepEqual(korean.leaks.map((l) => l.rule), ['naked-number'])
})

test('a null metric object is a leak with a name, not a crash', async () => {
  const { leaks } = await compileCase('V {{m:x}}.', { metrics: { x: null } })
  assert.equal(leaks.some((l) => l.rule === 'missing-field' && l.message.includes('"x"')), true)
})

test('avg, ratio and diff are recomputed like every other derivation', async () => {
  const part = (v: number) => ({ ...MEASURED, value: v })
  const ok = await compileCase('{{m:mean}} {{m:rate}} {{m:delta}} of {{m:a}} {{m:b}}.', {
    metrics: {
      a: part(10), b: part(30),
      mean: { value: 20, unit: 'count', derived: { op: 'avg', of: ['a', 'b'] } },
      rate: { value: 0.33, unit: 'ratio', definition: 'a per b', derived: { op: 'ratio', a: 'a', b: 'b' } },
      delta: { value: 20, unit: 'count', derived: { op: 'diff', a: 'b', b: 'a' } },
    },
  })
  assert.equal(ok.leaks.length, 0)
  const bad = await compileCase('{{m:mean}} of {{m:a}} {{m:b}}.', {
    metrics: { a: part(10), b: part(30), mean: { value: 25, unit: 'count', derived: { op: 'avg', of: ['a', 'b'] } } },
  })
  assert.deepEqual(bad.leaks.map((l) => l.rule), ['derived-mismatch'])
})

test('an identifier shaped like a measurement is a smuggled number', async () => {
  const { leaks } = await compileCase('Grew {{id:growth}} to {{id:revenue}} in {{id:app_version}} flag {{id:flag}} timeout {{id:timeout}}. {{m:x}}', {
    metrics: { x: MEASURED },
    identifiers: { growth: '47%', revenue: '1,428', app_version: '6.109.0', flag: '45', timeout: '30초' },
  })
  // % and thousands-separated forms are measurements; versions, bare flags, 30초 are names
  assert.deepEqual(leaks.map((l) => l.rule), ['identifier-measurement', 'identifier-measurement'])
})

test('raw escapes are counted, disclosed in the md appendix, and boundable', async () => {
  const report = 'Up {{raw:three-fold}} at {{raw:24/7}}. {{m:x}}'
  const ok = await compileCase(report, { metrics: { x: MEASURED } }, 'md')
  assert.equal(ok.grounded.raw, 2)
  assert.match(ok.output ?? '', /### Ungrounded \(2 raw escapes\)/)
  assert.match(ok.output ?? '', /- three-fold/)

  const dir = await mkdtemp(join(tmpdir(), 'wt-'))
  await writeFile(join(dir, 'report.md'), report)
  await writeFile(join(dir, 'metrics.json'), JSON.stringify({ metrics: { x: MEASURED } }))
  const gated = await compile(join(dir, 'report.md'), join(dir, 'metrics.json'), { maxRaw: 1 })
  assert.deepEqual(gated.leaks.map((l) => l.rule), ['raw-budget'])
})

test('a malformed derived "of" is a leak, not a crash or a letter-by-letter loop', async () => {
  for (const of of [undefined, 'ab', []]) {
    const { leaks } = await compileCase('T {{m:t}}.', {
      metrics: { t: { value: 5, unit: 'count', derived: { op: 'sum', of } } },
    })
    assert.equal(leaks.some((l) => l.rule === 'bad-derived'), true, `of=${JSON.stringify(of)}`)
  }
})

test('fenced syntax examples count toward nothing — header, scanner and render agree', async () => {
  const { grounded } = await compileCase(
    'Real {{m:x}} and {{raw:24/7}}.\n\n```\n{{raw:example}} {{m:demo}} {{claim: d | evidence: x}}\n```',
    { metrics: { x: MEASURED } }, 'md',
  )
  assert.equal(grounded.metrics, 1)
  assert.equal(grounded.raw, 1)
  assert.equal(grounded.claims, 0)
})

test('Korean counter units are measurements in an identifier; 초 stays a name', async () => {
  const { leaks } = await compileCase('{{id:rev}} {{id:cnt}} {{id:timeout}} {{m:x}}', {
    metrics: { x: MEASURED },
    identifiers: { rev: '1428원', cnt: '72건', timeout: '30초' },
  })
  assert.equal(leaks.filter((l) => l.rule === 'identifier-measurement').length, 2)
})

test('a warning reports without blocking; --strict promotes it; info never promotes', async () => {
  const report = '거의 세 배 늘었다. Count {{m:x}}.'
  const ir = { metrics: { x: MEASURED, spare: { ...MEASURED, value: 1 } } }

  const lax = await compileCase(report, ir)
  const severities = lax.leaks.map((l) => `${l.severity}:${l.rule}`).sort()
  assert.deepEqual(severities, ['info:unused-metric', 'warn:worded-number'])
  assert.ok(lax.output, 'warn/info must not suppress the output')

  const dir = await mkdtemp(join(tmpdir(), 'wt-strict-'))
  await writeFile(join(dir, 'report.md'), report)
  await writeFile(join(dir, 'metrics.json'), JSON.stringify(ir))
  const strict = await compile(join(dir, 'report.md'), join(dir, 'metrics.json'), { strict: true })
  assert.equal(strict.leaks.some((l) => l.rule === 'worded-number' && l.severity === 'error'), true)
  assert.equal(strict.leaks.some((l) => l.rule === 'unused-metric' && l.severity === 'info'), true)
  assert.equal(strict.output, undefined)
})

test('worded quantities warn; compound words never do', async () => {
  const hit = await compileCase('세 배 가까이 늘어 절반 이상이 됐고, 수십만 건과 a million 규모다. {{m:x}}', { metrics: { x: MEASURED } })
  assert.equal(hit.leaks.filter((l) => l.rule === 'worded-number').length, 4)

  const miss = await compileCase('배송이 지연되어 건물 번호를 재배포했다. {{m:x}}', { metrics: { x: MEASURED } })
  assert.equal(miss.leaks.filter((l) => l.rule === 'worded-number').length, 0)
})

test('assertions judge the arithmetic half of a conclusion', async () => {
  const irFor = (total: number) => ({
    metrics: {
      total: { ...MEASURED, value: total },
      target: { value: [30000, 140000], unit: '원', source: { type: 'hypothesis' }, window: 'plan', fetched_at: '-' },
    },
    assertions: { under_target: { op: 'lt', a: 'total', b: 'target.lo' } },
  })
  const report = 'Total {{m:total}} vs {{m:target}}. {{claim: 미달 | evidence: under_target}}'

  const ok = await compileCase(report, irFor(1428))
  assert.equal(ok.leaks.filter((l) => l.severity === 'error').length, 0)

  const flipped = await compileCase(report, irFor(45200))
  assert.deepEqual(flipped.leaks.filter((l) => l.severity === 'error').map((l) => l.rule), ['assertion-failed'])
})

test('malformed assertions are leaks, never crashes', async () => {
  const base = { metrics: { total: { ...MEASURED, value: 1428 }, target: { value: [1, 2], unit: 'x', source: { type: 'hypothesis' }, window: 'w', fetched_at: '-' } } }
  const cases: [object, string][] = [
    [{ under: { op: 'lt' } }, 'bad-assertion'],                                  // operands missing
    [{ under: { op: 'between', a: 1, b: 2 } }, 'bad-assertion'],                 // unknown op
    [{ under: { op: 'lt', a: 'total', b: 'target' } }, 'bad-assertion'],         // range without accessor
    [{ under: { op: 'lt', a: 'ghost', b: 1 } }, 'bad-assertion'],                // unknown key
    [{ total: { op: 'lt', a: 1, b: 2 } }, 'duplicate-key'],                      // namespace collision
  ]
  for (const [assertions, rule] of cases) {
    const { leaks } = await compileCase('T {{m:total}} {{m:target}}.', { ...base, assertions })
    assert.equal(leaks.some((l) => l.rule === rule), true, JSON.stringify(assertions))
  }
})

test('an assumption reads differently from a measurement, in both renders', async () => {
  const ir = {
    metrics: {
      real: { ...MEASURED, value: 5, source: { type: 'sql', query: 'https://mixpanel.com/p/1' } },
      plan: { ...MEASURED, value: 9, source: { type: 'hypothesis' } },
    },
  }
  const md = await compileCase('Real {{m:real}}, plan {{m:plan}}.', ir, 'md')
  assert.match(md.output ?? '', /⁽²ᵃ⁾/)
  assert.match(md.output ?? '', /\*\(assumption — not measured\)\*/)
  // receipts autolink conservative scheme-prefixed URLs
  assert.ok(md.output?.includes('<https://mixpanel.com/p/1>'))

  const html = await compileCase('Real {{m:real}}, plan {{m:plan}}.', ir)
  assert.ok(html.output?.includes('class="w a"'))
  assert.ok(html.output?.includes('<a href="https://mixpanel.com/p/1">'))
})

test('html receipt links escape hostile URLs', async () => {
  const { output } = await compileCase('V {{m:x}}.', {
    metrics: { x: { ...MEASURED, source: { type: 'web', url: 'https://x.com/"><script>alert(1)</script>' } } },
  })
  assert.ok(!output?.includes('<script>'))
})

test('unused-metric is info: reported, never failing, exempt when feeding a derived', async () => {
  const { leaks, output } = await compileCase('Only {{m:total}}.', {
    metrics: {
      a: { ...MEASURED, value: 1 },
      total: { value: 1, unit: 'count', derived: { op: 'sum', of: ['a'] } },
      orphan: { ...MEASURED, value: 9 },
    },
  })
  const unused = leaks.filter((l) => l.rule === 'unused-metric')
  assert.deepEqual(unused.map((l) => l.severity), ['info'])
  assert.match(unused[0].message, /"orphan"/)
  assert.ok(output)
})

test('a non-string, non-number assertion operand is a leak, cited or not', async () => {
  for (const bad of [null, true, { lo: 1 }]) {
    const { leaks, output } = await compileCase('V {{m:x}}.', {
      metrics: { x: MEASURED },
      assertions: { ghost: { op: 'lt', a: bad, b: 5 } },
    })
    assert.equal(leaks.some((l) => l.rule === 'bad-assertion'), true, `a=${JSON.stringify(bad)}`)
    assert.equal(output, undefined)
  }
})

test('한 번 and double-check are rhetoric; 두 번 and doubled still warn', async () => {
  const miss = await compileCase('한 번 더 확인했고 double-check 했다. {{m:x}}', { metrics: { x: MEASURED } })
  assert.equal(miss.leaks.filter((l) => l.rule === 'worded-number').length, 0)
  const hit = await compileCase('두 번 실패했고 revenue doubled. {{m:x}}', { metrics: { x: MEASURED } })
  assert.equal(hit.leaks.filter((l) => l.rule === 'worded-number').length, 2)
})

test('the markdown appendix shows what each assertion judged', async () => {
  const { output } = await compileCase(
    'T {{m:total}} vs {{m:target}}. {{claim: under | evidence: under_target}}',
    {
      metrics: {
        total: { ...MEASURED, value: 1428 },
        target: { value: [30000, 140000], unit: '원', source: { type: 'hypothesis' }, window: 'w', fetched_at: '-' },
      },
      assertions: { under_target: { op: 'lt', a: 'total', b: 'target.lo' } },
    },
    'md',
  )
  assert.match(output ?? '', /### Assertions \(1\)/)
  assert.match(output ?? '', /\*\*under_target\*\*: 1,428 lt 30,000 — holds/)
})
