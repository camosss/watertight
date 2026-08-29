#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compile } from './compile.js'
import { refresh } from './refresh.js'

const USAGE = `watertight — reports that hold water. Every number carries its receipt;
an ungrounded claim is a leak, and a report with leaks does not build.

Usage
  watertight <dir>             compile <dir>/report.md + <dir>/metrics.json → <dir>/report.html
  watertight <report> <ir>     explicit file paths
  watertight refresh <dir>     re-fetch metric values from their sources, update metrics.json

Options
  --out <file>       where to write the HTML (default: report.html next to the report)
  --check            verify only, write nothing
  --dry-run          refresh only: show what would change, write nothing
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
  let help = false
  let version = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') out = args[++i]
    else if (arg === '--check') check = true
    else if (arg === '--dry-run') dryRun = true
    else if (arg === '--allow-commands') allowCommands = true
    else if (arg === '--json') json = true
    else if (arg === '-h' || arg === '--help') help = true
    else if (arg === '-v' || arg === '--version') version = true
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  const command = positional[0] === 'refresh' ? 'refresh' : 'compile'
  if (command === 'refresh') positional.shift()
  return { command, positional, out, check, json, help, version, dryRun, allowCommands }
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
  for (const path of [reportPath, irPath]) {
    if (!(await exists(path))) {
      console.error(`Not found: ${path}`)
      console.error('Expected report.md and metrics.json — see --help.')
      process.exit(2)
    }
  }

  if (opts.command === 'refresh') {
    const r = await refresh(irPath, { allowCommands: opts.allowCommands, dryRun: opts.dryRun })
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

  const result = await compile(reportPath, irPath)
  const outPath = resolve(opts.out ?? join(reportPath, '..', 'report.html'))

  if (opts.json) {
    console.log(JSON.stringify({ version: pkg.version, ...result, html: undefined, wrote: result.html && !opts.check ? outPath : undefined }, null, 2))
  } else {
    console.log(`\nwatertight v${pkg.version} · ${result.grounded.metrics} grounded metrics · ${result.grounded.claims} claims · ${result.grounded.identifiers} identifiers`)
    if (result.leaks.length > 0) {
      console.log(`\n${result.leaks.length} leak(s) — the report does not hold water:\n`)
      for (const leak of result.leaks) {
        console.log(`  ✗ [${leak.rule}] ${leak.message}`)
        if (leak.detail) console.log(`    ${leak.detail}`)
      }
      console.log()
    }
  }

  if (result.html && !opts.check) {
    await writeFile(outPath, result.html)
    if (!opts.json) console.log(`holds water → ${outPath}\n`)
  } else if (result.html && opts.check && !opts.json) {
    console.log('holds water (check only — nothing written)\n')
  }

  process.exit(result.leaks.length > 0 ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
