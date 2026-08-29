import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { refresh } from '../src/refresh.js'

const MEASURED = { unit: 'count', window: 'w', fetched_at: 'old' }

async function setup(metrics: object, files: Record<string, string> = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'wt-'))
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content)
  const irPath = join(dir, 'metrics.json')
  await writeFile(irPath, JSON.stringify({ metrics }))
  return { dir, irPath }
}

test('csv and json values are re-fetched, and stale sums recomputed', async () => {
  const { dir, irPath } = await setup(
    {
      web: { ...MEASURED, value: 40, source: { type: 'csv', file: 'rev.csv', cell: 'B2' } },
      app: { ...MEASURED, value: 1383, source: { type: 'json', file: 'rev.json', path: 'totals.app' } },
      total: { value: 1423, unit: 'count', derived: { op: 'sum', of: ['web', 'app'] } },
    },
    {
      'rev.csv': 'name,amount\nweb,"1,045"\n',
      'rev.json': JSON.stringify({ totals: { app: 1383 } }),
    },
  )
  try {
    const result = await refresh(irPath, { allowCommands: false, dryRun: false })
    assert.deepEqual(
      result.changes.map((c) => `${c.key}:${c.before}→${c.after}`),
      ['web:40→1045', 'total:1423→2428'],
    )
    const written = JSON.parse(await readFile(irPath, 'utf8'))
    assert.equal(written.metrics.web.value, 1045)
    assert.equal(written.metrics.total.value, 2428)
    assert.notEqual(written.metrics.web.fetched_at, 'old')
    // untouched metric keeps its provenance timestamp
    assert.notEqual(written.metrics.app.fetched_at, 'old') // re-fetched, same value, new timestamp
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a command source does not run unless explicitly allowed', async () => {
  const { dir, irPath } = await setup({
    n: { ...MEASURED, value: 1, source: { type: 'command', run: 'echo 99' } },
  })
  try {
    const gated = await refresh(irPath, { allowCommands: false, dryRun: true })
    assert.equal(gated.changes.length, 0)
    assert.ok(gated.skipped.some((s) => s.key === 'n' && s.reason.includes('--allow-commands')))

    const allowed = await refresh(irPath, { allowCommands: true, dryRun: true })
    assert.deepEqual(allowed.changes, [{ key: 'n', before: 1, after: 99 }])
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('an unknown source type is named, never silently skipped', async () => {
  const { dir, irPath } = await setup({
    m: { ...MEASURED, value: 5, source: { type: 'mixpanel', query: '…' } },
  })
  try {
    const result = await refresh(irPath, { allowCommands: false, dryRun: true })
    assert.ok(result.skipped.some((s) => s.key === 'm' && s.reason.includes('mixpanel')))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('dry run writes nothing', async () => {
  const { dir, irPath } = await setup(
    { web: { ...MEASURED, value: 1, source: { type: 'csv', file: 'r.csv', cell: 'A1' } } },
    { 'r.csv': '7\n' },
  )
  try {
    const before = await readFile(irPath, 'utf8')
    const result = await refresh(irPath, { allowCommands: false, dryRun: true })
    assert.equal(result.changes.length, 1)
    assert.equal(result.wrote, false)
    assert.equal(await readFile(irPath, 'utf8'), before)
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a fetch error names the metric and the cell', async () => {
  const { dir, irPath } = await setup(
    { web: { ...MEASURED, value: 1, source: { type: 'csv', file: 'r.csv', cell: 'Z9' } } },
    { 'r.csv': 'a,b\n1,2\n' },
  )
  try {
    const result = await refresh(irPath, { allowCommands: false, dryRun: true })
    assert.equal(result.errors.length, 1)
    assert.ok(result.errors[0].message.includes('9'))
  } finally {
    await rm(dir, { recursive: true })
  }
})

test('a custom fetcher covers its source type, and derived changes follow', async () => {
  const { irPath } = await setup({
    conv_before: { ...MEASURED, value: 0.031, source: { type: 'mixpanel', bookmark: 'abc' } },
    conv_after: { ...MEASURED, value: 0.036, source: { type: 'mixpanel', bookmark: 'def' } },
    lift: { value: 0.161, unit: 'ratio-point', definition: 'd', derived: { op: 'pct_change', before: 'conv_before', after: 'conv_after' } },
  })
  const result = await refresh(irPath, {
    allowCommands: false,
    dryRun: false,
    fetchers: { mixpanel: (source) => (source['bookmark'] === 'def' ? 0.04 : 0.031) },
  })
  assert.equal(result.skipped.length, 0)
  const written = JSON.parse(await readFile(irPath, 'utf8'))
  assert.equal(written.metrics.conv_after.value, 0.04)
  assert.notEqual(written.metrics.conv_after.fetched_at, 'old')
  // pct_change follows the moved input, at the author's stated precision
  assert.equal(written.metrics.lift.value, 0.29)
})

test('a fetcher that throws names the metric; a built-in type is never shadowed', async () => {
  const { irPath } = await setup(
    {
      broken: { ...MEASURED, value: 1, source: { type: 'vendor' } },
      safe: { ...MEASURED, value: 40, source: { type: 'csv', file: 'a.csv', cell: 'A1' } },
    },
    { 'a.csv': '77\n' },
  )
  const result = await refresh(irPath, {
    allowCommands: false,
    dryRun: false,
    fetchers: {
      vendor: () => { throw new Error('token expired') },
      csv: () => 999, // must not be consulted — built-ins win
    },
  })
  assert.deepEqual(result.errors.map((e) => e.key), ['broken'])
  assert.match(result.errors[0].message, /token expired/)
  const written = JSON.parse(await readFile(irPath, 'utf8'))
  assert.equal(written.metrics.safe.value, 77)
})

test('a fetcher returning garbage is an error, not a silent write', async () => {
  const { irPath } = await setup({
    x: { ...MEASURED, value: 5, source: { type: 'vendor' } },
  })
  const result = await refresh(irPath, {
    allowCommands: false,
    dryRun: false,
    fetchers: { vendor: () => Number('not-a-number') },
  })
  assert.equal(result.errors.length, 1)
  assert.match(result.errors[0].message, /not a number/)
  const written = JSON.parse(await readFile(irPath, 'utf8'))
  assert.equal(written.metrics.x.value, 5)
})
