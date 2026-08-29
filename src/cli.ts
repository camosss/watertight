#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compile, type Format } from './compile.js'
import { basename } from 'node:path'
import { refresh, type Fetcher } from './refresh.js'
import { pathToFileURL } from 'node:url'

const USAGE = `watertight — reports that hold water. Every number carries its receipt;
an ungrounded claim is a leak, and a report with leaks does not build.

Usage
  watertight <dir>             compile <dir>/report.md + <dir>/metrics.json → <dir>/report.html
  watertight <report> <ir>     explicit file paths
  watertight refresh <dir>     re-fetch metric values from their sources, update metrics.json

Options
  --max-age <days>   compile only: fail any metric whose fetched_at is older —
                     numbers age, and a stale receipt is quietly becoming a leak
  --format <html|md> output format (default: html). md is grounded markdown with a
                     receipts appendix — pastes into Notion, PR bodies or Slack intact
  --out <file>       where to write the output (default: report.html / report.grounded.md)
  --check            verify only, write nothing
  --dry-run          refresh only: show what would change, write nothing
  --fetchers <file>  refresh only: a JS module of custom source adapters, e.g.
                     export function mixpanel(source) { ... return value }
                     Loading a module runs its code — only pass files you wrote or trust.
  --allow-commands   refresh only: let "command" sources run shell (off by default —
                     an IR from someone else's repo must not execute code on your machine)
  --json          machine-readable result on stdout
  -v, --version   print the version
  -h, --help      show this message

watertight only reads the two input files and writes the one output file — nothing else.
`

function parseArgs(argv: string[]) {
  const args = argv.slice(2)
  const positional: string[] = []
  let out: string | undefined
  let check = false
  let json = false
  let dryRun = false
  let allowCommands = false
  let fetchersPath: string | undefined
  let format: Format = 'html'
  let maxAgeDays: number | undefined
  let help = false
  let version = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') out = args[++i]
    else if (arg === '--check') check = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--allow-commands') allowCommands = true
    else if (arg === '--fetchers') fetchersPath = args[++i]
    else if (arg === '--format') format = args[++i] === 'md' ? 'md' : 'html'
    else if (arg === '--max-age') {
      maxAgeDays = Number(args[++i])
      if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
        console.error(`error: --max-age needs a number of days, got "${args[i]}"`)
        process.exit(2)
      }
    }
    else if (arg === '--json') json = true
    else if (arg === '-h' || arg === '--help') help = true
    else if (arg === '-v' || arg === '--version') version = true
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  const command = positional[0] === 'refresh' ? 'refresh' : 'compile'
  if (command === 'refresh') positional.shift()
  return { command, positional, out, check, json, help, version, dryRun, allowCommands, format, fetchersPath, maxAgeDays }
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const opts = parseArgs(process.argv)
  const pkg = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }

  if (opts.version) return console.log(pkg.version)
  if (opts.help) return console.log(USAGE)

  // a mistyped path must fail loudly, never read as an empty report
  let reportPath: string
  let irPath: string
  if (opts.positional.length === 2) {
    ;[reportPath, irPath] = opts.positional.map((p) => resolve(p))
  } else {
    const dir = resolve(opts.positional[0] ?? '.')
    reportPath = join(dir, 'report.md')
    irPath = join(dir, 'metrics.json')
  }
  // refresh works on the IR alone — an IR-only directory is a legitimate workspace
  for (const path of opts.command === 'refresh' ? [irPath] : [reportPath, irPath]) {
    if (!(await exists(path))) {
      console.error(`Not found: ${path}`)
      console.error('Expected report.md and metrics.json — see --help.')
      process.exit(2)
    }
  }

  if (opts.command === 'refresh') {
    let fetchers: Record<string, Fetcher> | undefined
    if (opts.fetchersPath) {
      const mod = await import(pathToFileURL(resolve(opts.fetchersPath)).href)
      const exports = (typeof mod.default === 'object' && mod.default !== null ? mod.default : mod) as Record<string, unknown>
      fetchers = Object.fromEntries(
        Object.entries(exports).filter(([, v]) => typeof v === 'function'),
      ) as Record<string, Fetcher>
      if (Object.keys(fetchers).length === 0) {
        console.error(`error: ${opts.fetchersPath} exports no functions — nothing to fetch with`)
        process.exit(2)
      }
    }
    const r = await refresh(irPath, { allowCommands: opts.allowCommands, dryRun: opts.dryRun, fetchers })
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2))
      process.exit(r.errors.length > 0 ? 1 : 0)
    }
    for (const c of r.changes) console.log(`  ${c.key}: ${c.before.toLocaleString()} → ${c.after.toLocaleString()}`)
    for (const s of r.skipped) console.log(`  ~ ${s.key} skipped — ${s.reason}`)
    for (const e of r.errors) console.error(`  ✗ ${e.key}: ${e.message}`)
    console.log(
      r.errors.length > 0
        ? `\n${r.errors.length} fetch error(s) — metrics.json ${r.wrote ? 'partially updated' : 'not written'}`
        : `\n${r.changes.length} change(s)${opts.dryRun ? ' (dry run — nothing written)' : r.wrote ? ` — updated ${irPath}` : ''}`,
    )
    process.exit(r.errors.length > 0 ? 1 : 0)
  }

  const result = await compile(reportPath, irPath, { format: opts.format, maxAgeDays: opts.maxAgeDays })
  const defaultName = opts.format === 'md' ? 'report.grounded.md' : 'report.html'
  const outPath = resolve(opts.out ?? join(reportPath, '..', defaultName))

  if (opts.json) {
    console.log(JSON.stringify({ version: pkg.version, ...result, output: undefined, wrote: result.output && !opts.check ? outPath : undefined }, null, 2))
  } else {
    console.log(`\nwatertight v${pkg.version} · ${result.grounded.metrics} grounded metrics · ${result.grounded.claims} claims · ${result.grounded.identifiers} identifiers`)
    if (result.leaks.length > 0) {
      console.log(`\n${result.leaks.length} leak(s) — the report does not hold water:\n`)
      for (const leak of result.leaks) {
        const where = leak.line !== undefined ? `${basename(reportPath)}:${leak.line} — ` : ''
        console.log(`  ✗ [${leak.rule}] ${where}${leak.message}`)
        if (leak.detail) console.log(`    ${leak.detail}`)
      }
      console.log()
    }
  }

  if (result.output && !opts.check) {
    await writeFile(outPath, result.output)
    if (!opts.json) console.log(`holds water → ${outPath}\n`)
  } else if (result.output && opts.check && !opts.json) {
    console.log('holds water (check only — nothing written)\n')
  }

  process.exit(result.leaks.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
