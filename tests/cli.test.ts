import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { test } from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const cli = (...args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'cli.ts'), ...args], { encoding: 'utf8' })

test('a clean report exits 0 and says it holds water', () => {
  const result = cli(join(ROOT, 'fixtures', 'sample-experiment'), '--check')
  assert.equal(result.status, 0)
  assert.ok(result.stdout.includes('holds water'))
})

// a mistyped path must fail loudly, never read as an empty report
test('a missing input is exit 2 with the path named', () => {
  const result = cli(join(ROOT, 'does-not-exist'))
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('does-not-exist'))
})

test('refresh --fetchers loads the named module; an empty module is exit 2', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'wt-cli-'))
  await writeFile(join(dir, 'metrics.json'), JSON.stringify({
    metrics: { x: { value: 1, unit: 'count', window: 'w', fetched_at: 'old', source: { type: 'vendor' } } },
  }))
  await writeFile(join(dir, 'fetchers.mjs'), 'export function vendor() { return 42 }\n')
  await writeFile(join(dir, 'empty.mjs'), 'export const nothing = 1\n')

  const ok = cli('refresh', dir, '--fetchers', join(dir, 'fetchers.mjs'), '--json')
  assert.equal(ok.status, 0)
  assert.deepEqual(JSON.parse(ok.stdout).changes, [{ key: 'x', before: 1, after: 42 }])

  const empty = cli('refresh', dir, '--fetchers', join(dir, 'empty.mjs'))
  assert.equal(empty.status, 2)
  assert.match(empty.stderr, /exports no functions/)
})

test('init scaffolds a pair that holds water, and never overwrites', async () => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'wt-init-'))

  const first = cli('init', dir)
  assert.equal(first.status, 0)

  const compiled = cli(dir, '--check')
  assert.equal(compiled.status, 0)
  assert.match(compiled.stdout, /holds water/)

  const second = cli('init', dir)
  assert.equal(second.status, 2)
  assert.match(second.stderr, /refusing to overwrite/)
})

test('an unknown flag is exit 2, and init creates missing directories', async () => {
  const typo = cli(join(ROOT, 'fixtures', 'sample-experiment'), '--chekc')
  assert.equal(typo.status, 2)
  assert.match(typo.stderr, /unknown flag "--chekc"/)

  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const base = await mkdtemp(join(tmpdir(), 'wt-deep-'))
  const nested = cli('init', join(base, 'reports', 'new'))
  assert.equal(nested.status, 0)
  assert.equal(cli(join(base, 'reports', 'new'), '--check').status, 0)
})

test('verify is read-only and fails on a value the source no longer returns', async () => {
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'wt-verify-'))
  await writeFile(join(dir, 'data.csv'), '1045\n')
  const ir = JSON.stringify({
    metrics: {
      web: { value: 40, unit: 'count', window: 'w', fetched_at: '2026-01-01', source: { type: 'csv', file: 'data.csv', cell: 'A1' } },
      total: { value: 40, unit: 'count', derived: { op: 'sum', of: ['web'] } },
      vendor: { value: 7, unit: 'count', window: 'w', fetched_at: '2026-01-01', source: { type: 'mixpanel' } },
    },
  })
  await writeFile(join(dir, 'metrics.json'), ir)

  const bad = cli('verify', dir)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /receipt-mismatch.*"web" is 40.*now returns 1,045/)
  // derived drift is a cascade, not a separate mismatch; unfetchable sources are named
  assert.equal((bad.stdout.match(/receipt-mismatch/g) ?? []).length, 1)
  assert.match(bad.stdout, /~ vendor skipped/)
  // nothing was written
  assert.equal(await readFile(join(dir, 'metrics.json'), 'utf8'), ir)

  await writeFile(join(dir, 'data.csv'), '40\n')
  const ok = cli('verify', dir)
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /receipts verified/)
})

test('refresh points at claims whose evidence moved', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'wt-claims-'))
  await writeFile(join(dir, 'data.csv'), '99\n')
  await writeFile(join(dir, 'report.md'), 'Value {{m:web}}. {{claim: it stayed low | evidence: web}}')
  await writeFile(join(dir, 'metrics.json'), JSON.stringify({
    metrics: { web: { value: 40, unit: 'count', window: 'w', fetched_at: 'old', source: { type: 'csv', file: 'data.csv', cell: 'A1' } } },
  }))
  const r = cli('refresh', dir)
  assert.equal(r.status, 0)
  assert.match(r.stdout, /⚠ claim "it stayed low" cites web/)
})

test('verify catches a tampered derived even when no source moved', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'wt-tamper-'))
  await writeFile(join(dir, 'data.csv'), '0.1\n')
  await writeFile(join(dir, 'metrics.json'), JSON.stringify({
    metrics: {
      a: { value: 0.1, unit: 'count', window: 'w', fetched_at: '2026-01-01', source: { type: 'csv', file: 'data.csv', cell: 'A1' } },
      total: { value: 0.9, unit: 'count', derived: { op: 'sum', of: ['a'] } },
    },
  }))
  const r = cli('verify', dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /derived-mismatch/)
})
