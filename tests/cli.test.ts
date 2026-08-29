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
