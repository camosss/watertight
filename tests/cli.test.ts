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
