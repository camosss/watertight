#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compile } from './compile.js'

const USAGE = `watertight — reports that hold water. Every number carries its receipt;
an ungrounded claim is a leak, and a report with leaks does not build.

Usage
  watertight <dir>             compile <dir>/report.md + <dir>/metrics.json → <dir>/report.html
  watertight <report> <ir>     explicit file paths

Options
  --out <file>    where to write the HTML (default: report.html next to the report)
  --check         verify only, write nothing
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
  let help = false
  let version = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--out') out = args[++i]
    else if (arg === '--check') check = true
    else if (arg === '--json') json = true
    else if (arg === '-h' || arg === '--help') help = true
    else if (arg === '-v' || arg === '--version') version = true
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  return { positional, out, check, json, help, version }
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

  const result = await compile(reportPath, irPath)
  const outPath = resolve(opts.out ?? join(reportPath, '..', 'report.html'))

  if (opts.json) {
    console.log(JSON.stringify({ version: pkg.version, ...result, html: undefined, wrote: result.html && !opts.check ? outPath : undefined }, null, 2))
  } else {
    console.log(`\nwatertight v${pkg.version} · ${result.grounded.metrics} grounded metrics · ${result.grounded.identifiers} identifiers`)
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
