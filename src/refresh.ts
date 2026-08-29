import { execSync } from 'node:child_process'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import type { Metric, Source } from './types.js'

/**
 * A custom source adapter: given the receipt, return the current value.
 * Registered per source type via --fetchers; the module is chosen by the person
 * running refresh, never by the IR, so secrets and vendor APIs stay out of core.
 */
export type Fetcher = (
  source: Source,
  ctx: { key: string; metric: Metric; baseDir: string },
) => number | Promise<number>

export interface RefreshOptions {
  /** command sources execute arbitrary shell from the IR — off unless explicitly allowed */
  allowCommands: boolean
  dryRun: boolean
  /** custom adapters by source type — built-in csv/json/command always win */
  fetchers?: Record<string, Fetcher>
}

export interface RefreshChange {
  key: string
  before: number
  after: number
}

export interface RefreshResult {
  changes: RefreshChange[]
  /** metrics whose source has no built-in adapter — left untouched, named so silence is impossible */
  skipped: { key: string; reason: string }[]
  errors: { key: string; message: string }[]
  wrote: boolean
}

/** "B4" → row 4, column B. The spreadsheet convention people already know. */
function cellToIndex(cell: string): { row: number; col: number } {
  const m = /^([A-Z]+)(\d+)$/i.exec(cell.trim())
  if (!m) throw new Error(`not an A1-style cell: "${cell}"`)
  let col = 0
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64)
  return { row: Number(m[2]) - 1, col: col - 1 }
}

/** Minimal CSV: quoted fields with embedded commas supported, embedded newlines not. */
function parseCsvLine(line: string): string[] {
  const out: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') { field += '"'; i++ }
      else if (ch === '"') quoted = false
      else field += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { out.push(field); field = '' }
    else field += ch
  }
  out.push(field)
  return out
}

function toNumber(raw: unknown, where: string): number {
  const n = Number(String(raw).replace(/[,\s]/g, ''))
  if (!Number.isFinite(n)) throw new Error(`${where} is not a number: "${raw}"`)
  return n
}

async function fetchCsv(source: Source, baseDir: string): Promise<number> {
  const text = await readFile(resolve(baseDir, String(source['file'])), 'utf8')
  const { row, col } = cellToIndex(String(source['cell']))
  const lines = text.split(/\r?\n/)
  if (row >= lines.length) throw new Error(`row ${row + 1} is past the end of ${source['file']}`)
  const fields = parseCsvLine(lines[row])
  if (col >= fields.length) throw new Error(`column ${source['cell']} is past the end of row ${row + 1}`)
  return toNumber(fields[col], `${source['file']}!${source['cell']}`)
}

async function fetchJson(source: Source, baseDir: string): Promise<number> {
  const data = JSON.parse(await readFile(resolve(baseDir, String(source['file'])), 'utf8'))
  let node: unknown = data
  const path = String(source['path'])
  for (const part of path.split(/[.[\]]+/).filter(Boolean)) {
    node = (node as Record<string, unknown>)?.[part]
  }
  return toNumber(node, `${source['file']} → ${path}`)
}

function fetchCommand(source: Source, baseDir: string): number {
  const stdout = execSync(String(source['run']), { cwd: baseDir, encoding: 'utf8', timeout: 30_000 })
  return toNumber(stdout.trim().split('\n').at(-1), `command output`)
}

export async function refresh(irPath: string, options: RefreshOptions): Promise<RefreshResult> {
  const raw = JSON.parse(await readFile(irPath, 'utf8')) as {
    identifiers?: Record<string, string>
    metrics: Record<string, Metric>
  }
  const baseDir = dirname(resolve(irPath))
  const result: RefreshResult = { changes: [], skipped: [], errors: [], wrote: false }
  const now = new Date().toISOString()

  for (const [key, m] of Object.entries(raw.metrics)) {
    if (m.derived || !m.source || Array.isArray(m.value)) continue
    try {
      let value: number
      if (m.source.type === 'csv') value = await fetchCsv(m.source, baseDir)
      else if (m.source.type === 'json') value = await fetchJson(m.source, baseDir)
      else if (m.source.type === 'command') {
        if (!options.allowCommands) {
          result.skipped.push({ key, reason: 'command sources run only with --allow-commands' })
          continue
        }
        value = fetchCommand(m.source, baseDir)
      } else if (options.fetchers?.[m.source.type]) {
        value = toNumber(
          await options.fetchers[m.source.type](m.source, { key, metric: m, baseDir }),
          `fetcher "${m.source.type}" for "${key}"`,
        )
      } else {
        result.skipped.push({ key, reason: `no adapter for source type "${m.source.type}"` })
        continue
      }
      if (value !== m.value) result.changes.push({ key, before: m.value, after: value })
      m.value = value
      m.fetched_at = now
    } catch (err) {
      result.errors.push({ key, message: err instanceof Error ? err.message : String(err) })
    }
  }

  // inputs may have moved, so derived values are recomputed rather than left to go stale
  for (const [key, m] of Object.entries(raw.metrics)) {
    if (!m.derived || Array.isArray(m.value)) continue
    let computed: number
    if (m.derived.op === 'sum') {
      computed = m.derived.of.reduce((acc, ref) => {
        const part = raw.metrics[ref]
        return acc + (part && typeof part.value === 'number' ? part.value : NaN)
      }, 0)
    } else {
      const endpoint = (v: number | string): number | undefined => {
        if (typeof v === 'number') return v
        const ref = raw.metrics[v]
        return ref && typeof ref.value === 'number' ? ref.value : undefined
      }
      const before = endpoint(m.derived.before)
      const after = endpoint(m.derived.after)
      if (before === undefined || after === undefined || before === 0) continue
      // keep the author's stated precision — refresh must not turn 0.155 into 0.1551724
      const decimals = (String(m.value).split('.')[1] ?? '').length
      computed = Number(((after - before) / before).toFixed(decimals))
    }
    if (Number.isFinite(computed) && computed !== m.value) {
      result.changes.push({ key, before: m.value as number, after: computed })
      m.value = computed
    }
  }

  if (!options.dryRun && (result.changes.length > 0 || result.errors.length === 0)) {
    await writeFile(irPath, `${JSON.stringify(raw, null, 2)}\n`)
    result.wrote = true
  }
  return result
}
