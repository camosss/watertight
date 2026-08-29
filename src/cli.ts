#!/usr/bin/env node
import { access, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { compile, type Format } from './compile.js'
import { basename } from 'node:path'
import { refresh, type Fetcher } from './refresh.js'
import { parseIr } from './ir.js'
import { init } from './init.js'
import { pathToFileURL } from 'node:url'

const USAGE = `watertight — reports that hold water. Every number carries its receipt;
an ungrounded claim is a leak, and a report with leaks does not build.

Usage
  watertight <dir>             compile <dir>/report.md + <dir>/metrics.json → <dir>/report.html
  watertight <report> <ir>     explicit file paths
  watertight refresh <dir>     re-fetch metric values from their sources, update metrics.json
  watertight verify <dir>      re-fetch and COMPARE — a stored value its source no longer
                               returns is a receipt-mismatch; nothing is written
  watertight init [dir]        scaffold a report.md + metrics.json pair that already holds water

Options
  --max-age <days>   compile only: fail any metric whose fetched_at is older —
                     numbers age, and a stale receipt is quietly becoming a leak
  --max-raw <n>      compile only: fail when the report uses more than n {{raw:}}
                     escapes — the escape hatch must stay boundable
  --strict           compile only: promote warnings (worded-number) to errors.
                     info (unused-metric) is a drift signal and never promotes
  --format <html|md> output format (default: html). md is grounded markdown with a
                     receipts appendix — pastes into Notion, PR bodies or Slack intact
  --out <file>       where to write the output (default: report.html / report.grounded.md)
  --check            verify only, write nothing
  --dry-run          refresh only: show what would change, write nothing
  --fetchers <file>  refresh/verify: a JS module of custom source adapters, e.g.
                     export function mixpanel(source) { ... return value }
                     Loading a module runs its code — only pass files you wrote or trust.
  --allow-commands   refresh/verify: let "command" sources run shell (off by default —
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
  let maxRaw: number | undefined
  let strict = false
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
    else if (arg === '--strict') strict = true
    else if (arg === '--max-raw') {
      maxRaw = Number(args[++i])
      if (!Number.isFinite(maxRaw) || maxRaw < 0) {
        console.error(`error: --max-raw needs a number, got "${args[i]}"`)
        process.exit(2)
      }
    }
    else if (arg === '--json') json = true
    else if (arg === '-h' || arg === '--help') help = true
    else if (arg === '-v' || arg === '--version') version = true
    else if (arg.startsWith('-')) {
      // a strictness tool must not silently ignore a typo'd flag — --chekc writing a file is a betrayal
      console.error(`error: unknown flag "${arg}" — see --help`)
      process.exit(2)
    } else positional.push(arg)
  }
  const command = ['refresh', 'init', 'verify'].includes(positional[0]) ? positional[0] : 'compile'
  if (command !== 'compile') positional.shift()
  return { command, positional, out, check, json, help, version, dryRun, allowCommands, format, fetchersPath, maxAgeDays, maxRaw, strict }
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

  if (opts.command === 'init') {
    const dir = resolve(opts.positional[0] ?? '.')
    try {
      const { written } = await init(dir)
      for (const f of written) console.log(`  + ${f}`)
      console.log('\nCompile it: watertight ' + (opts.positional[0] ?? '.'))
      process.exit(0)
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(2)
    }
  }

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
  // refresh/verify work on the IR alone — an IR-only directory is a legitimate workspace
  for (const path of opts.command === 'refresh' || opts.command === 'verify' ? [irPath] : [reportPath, irPath]) {
    if (!(await exists(path))) {
      console.error(`Not found: ${path}`)
      console.error('Expected report.md and metrics.json — see --help.')
      process.exit(2)
    }
  }

  if (opts.command === 'refresh' || opts.command === 'verify') {
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
    const ir = JSON.parse(await readFile(irPath, 'utf8')) as {
      metrics?: Record<string, { derived?: unknown }>
    }
    const r = await refresh(irPath, {
      allowCommands: opts.allowCommands,
      dryRun: opts.dryRun || opts.command === 'verify',
      fetchers,
    })

    if (opts.command === 'verify') {
      // integrity first: a tampered derived (inputs unchanged, value edited) is not a
      // cascade — parseIr recomputes every derivation, so verify alone catches it even
      // in an IR-only directory where no compile ever runs
      const integrity = parseIr(ir).leaks
      // a change on a MEASURED metric means the IR no longer matches its source —
      // the receipt is real but the value is not. Derived drift is covered above.
      const mismatches = r.changes.filter((c) => !ir.metrics?.[c.key]?.derived)
      const failing = mismatches.length > 0 || integrity.length > 0 || r.errors.length > 0
      if (opts.json) {
        console.log(JSON.stringify({ mismatches, integrity, skipped: r.skipped, errors: r.errors }, null, 2))
        process.exit(failing ? 1 : 0)
      }
      for (const leak of integrity) console.log(`  ✗ [${leak.rule}] ${leak.message}`)
      for (const m of mismatches) {
        console.log(`  ✗ [receipt-mismatch] metric "${m.key}" is ${m.before.toLocaleString()} in the IR, but its source now returns ${m.after.toLocaleString()}`)
      }
      for (const sk of r.skipped) console.log(`  ~ ${sk.key} skipped — ${sk.reason}`)
      for (const e of r.errors) console.error(`  ✗ ${e.key}: ${e.message}`)
      if (failing) {
        console.log(`\n${mismatches.length} receipt mismatch(es), ${integrity.length} integrity leak(s), ${r.errors.length} fetch error(s) — the IR does not hold water`)
        process.exit(1)
      }
      const verified = Object.keys(ir.metrics ?? {}).length - r.skipped.length
      console.log(`\nreceipts verified (${verified} checked, ${r.skipped.length} named as skipped) — nothing written`)
      process.exit(0)
    }

    // conclusions age too: a claim citing a metric that just moved needs a re-read
    const changedKeys = new Set(r.changes.map((c) => c.key))
    const reviewClaims: { claim: string; evidence: string[] }[] = []
    if (changedKeys.size > 0 && (await exists(reportPath))) {
      const report = await readFile(reportPath, 'utf8')
      for (const [, text, evidence] of report.matchAll(/\{\{claim:([^|}]*)\|\s*evidence:([^}]*)\}\}/g)) {
        const cited = evidence.split(',').map((k) => k.trim()).filter((k) => changedKeys.has(k))
        if (cited.length > 0) reviewClaims.push({ claim: text.trim(), evidence: cited })
      }
    }
    if (opts.json) {
      console.log(JSON.stringify({ ...r, reviewClaims }, null, 2))
      process.exit(r.errors.length > 0 ? 1 : 0)
    }
    for (const c of r.changes) console.log(`  ${c.key}: ${c.before.toLocaleString()} → ${c.after.toLocaleString()}`)
    for (const rc of reviewClaims) {
      console.log(`  ⚠ claim "${rc.claim}" cites ${rc.evidence.join(', ')} — the number moved, review the conclusion`)
    }
    for (const s of r.skipped) console.log(`  ~ ${s.key} skipped — ${s.reason}`)
    for (const e of r.errors) console.error(`  ✗ ${e.key}: ${e.message}`)
    console.log(
      r.errors.length > 0
        ? `\n${r.errors.length} fetch error(s) — metrics.json ${r.wrote ? 'partially updated' : 'not written'}`
        : `\n${r.changes.length} change(s)${opts.dryRun ? ' (dry run — nothing written)' : r.wrote ? ` — updated ${irPath}` : ''}`,
    )
    process.exit(r.errors.length > 0 ? 1 : 0)
  }

  const result = await compile(reportPath, irPath, { format: opts.format, maxAgeDays: opts.maxAgeDays, maxRaw: opts.maxRaw, strict: opts.strict })
  const defaultName = opts.format === 'md' ? 'report.grounded.md' : 'report.html'
  const outPath = resolve(opts.out ?? join(reportPath, '..', defaultName))

  if (opts.json) {
    console.log(JSON.stringify({ version: pkg.version, ...result, output: undefined, wrote: result.output && !opts.check ? outPath : undefined }, null, 2))
  } else {
    const rawNote = result.grounded.raw > 0 ? ` · ${result.grounded.raw} raw escape(s)` : ''
    console.log(`\nwatertight v${pkg.version} · ${result.grounded.metrics} grounded metrics · ${result.grounded.claims} claims · ${result.grounded.identifiers} identifiers${rawNote}`)
    if (result.leaks.length > 0) {
      const count = (sev: string) => result.leaks.filter((l) => l.severity === sev).length
      const errors = count('error')
      const parts = [
        errors > 0 && `${errors} error(s)`,
        count('warn') > 0 && `${count('warn')} warning(s)`,
        count('info') > 0 && `${count('info')} info`,
      ].filter(Boolean)
      console.log(`\n${parts.join(', ')}${errors > 0 ? ' — the report does not hold water' : ''}:\n`)
      const ICON = { error: '✗', warn: '⚠', info: 'ℹ' } as const
      for (const leak of result.leaks) {
        const where = leak.line !== undefined ? `${basename(reportPath)}:${leak.line} — ` : ''
        console.log(`  ${ICON[leak.severity]} [${leak.rule}] ${where}${leak.message}`)
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

  // warn and info report without blocking; only an error (or a promoted warn) fails
  process.exit(result.leaks.some((l) => l.severity === 'error') ? 1 : 0)
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(2)
})
