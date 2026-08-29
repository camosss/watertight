# watertight

[![npm](https://img.shields.io/npm/v/watertight.svg)](https://www.npmjs.com/package/watertight)
[![CI](https://github.com/camosss/watertight/actions/workflows/ci.yml/badge.svg)](https://github.com/camosss/watertight/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/Node-18%2B-brightgreen.svg)
![Dependencies](https://img.shields.io/badge/Dependencies-0-lightgrey.svg)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Reports that hold water — every number carries its **receipt**, and ungrounded claims **fail the build**.

```bash
npx watertight report.md metrics.json
```

```
watertight v0.8.0 · 20 grounded metrics · 4 claims · 5 identifiers
holds water → report.html
```

An ungrounded number is a **leak**. A report with zero leaks **holds water**:

```
2 error(s) — the report does not hold water:

  ✗ [naked-number] report.md:31 — "15%" appears in the narrative without a receipt
  ✗ [derived-mismatch] metric "revenue_total" is 1440, but its parts sum to 1428
```

<br>

## Contents

- [Why this exists](#why-this-exists)
- [Quick start](#quick-start)
  - [The IR — metrics.json](#the-ir--metricsjson)
  - [The narrative — report.md](#the-narrative--reportmd)
- [What the output looks like](#what-the-output-looks-like)
- [What it checks](#what-it-checks)
- [Re-verification](#re-verification)
- [Custom fetchers](#custom-fetchers)
- [In CI](#in-ci)
- [For AI-authored reports](#for-ai-authored-reports)
- [What it deliberately does not do](#what-it-deliberately-does-not-do)
- [Related work](#related-work)
- [License](#license)

<br>

## Why this exists

A number typed into prose has no memory of where it came from. Two weeks later
nobody can say which query produced it, whether it was rounded, or whether it
was ever true — and when an LLM helps write the report, "never true" is a live
possibility.

This came out of writing a real ad-revenue verification report with an AI
assistant. Compiling the draft surfaced three distinct failure classes in one
document:

- a human had written **+15%** for a delta that computed to **+15.5%** —
  a rounding transcription error nobody had caught;
- a stated revenue total did not equal the sum of its per-platform parts;
- the assistant confidently "remembered" a figure that appeared nowhere in
  any export.

All three are the same disease — a number with no receipt — and all three are
mechanically detectable. So: detect them, every build. watertight treats a
report like source code: the narrative references metrics, the metrics carry
provenance, and a compiler refuses to build anything it cannot trace.

<br>

## Quick start

```bash
npm install -g watertight
# or per-run
npx watertight report.md metrics.json
```

You write two files.

### The IR — `metrics.json`

Every value with its receipt. A measured metric says where it was fetched,
over what window, and when:

```json
{
  "metrics": {
    "conversion_after": {
      "value": 0.036,
      "unit": "ratio",
      "definition": "purchases / sessions entering checkout",
      "source": { "type": "sql", "query": "reports/checkout.sql" },
      "window": "2026-09-01 ~ 2026-09-14",
      "fetched_at": "2026-09-15"
    }
  },
  "identifiers": { "app_version": "3.2.0", "flag": "checkout_v2" }
}
```

A **derived** metric is recomputed on every compile — a total that doesn't add
up, or a delta that doesn't recompute, is a build failure. Ops: `sum`, `avg`,
`pct_change`, `ratio` (a / b), `diff` (a − b) — the arithmetic reports actually
do, so hand-computed values don't have to masquerade as measured ones:

```json
"lift": {
  "value": 0.161,
  "unit": "ratio-point",
  "definition": "relative change in conversion",
  "derived": { "op": "pct_change", "before": "conversion_before", "after": "conversion_after" }
},
"revenue_total": {
  "value": 1428,
  "unit": "USD",
  "derived": { "op": "sum", "of": ["revenue_ios", "revenue_android"] }
}
```

An **assertion** is the arithmetic half of a conclusion — "under target",
"no cannibalisation" — judged on every compile. When `refresh` moves a number
far enough to flip it, the build breaks until the conclusion is rewritten:

```json
"assertions": {
  "met_target": { "op": "gte", "a": "revenue_total", "b": "revenue_target.lo" }
}
```

Ops: `lt`, `lte`, `gt`, `gte`. Operands are metric keys, inline numbers, or —
for range metrics, always explicitly — `key.lo` / `key.hi`. Claims can cite
assertion keys as evidence.

A **range** states a hypothesis honestly — plans are receipts too:

```json
"revenue_target": {
  "value": [1000, 5000],
  "unit": "USD",
  "source": { "type": "hypothesis", "doc": "PLAN-42" },
  "window": "planning estimate",
  "fetched_at": "-"
}
```

### The narrative — `report.md`

No literal figures, only references:

```markdown
Rolled out in `{{id:app_version}}` behind `{{id:flag}}`.

Conversion moved from {{m:conversion_before}} to {{m:conversion_after}},
a lift of {{m:lift}}. Revenue impact was {{m:revenue_total}}, within the
hypothesised {{m:revenue_target}}.

{{claim: the experiment met its success criteria | evidence: lift, met_target}}

Support runs {{raw:24/7}}.
```

`{{raw:}}` is the escape hatch, and it stays visible: the compile header counts
raw escapes, the markdown render lists them in an **Ungrounded** section, and
`--max-raw <n>` turns the count into a gate.

Compile:

```bash
watertight report.md metrics.json    # → report.html (self-contained, hover for receipts)
watertight . --format md             # → grounded markdown (below)
watertight . --check                 # verify only, write nothing (CI)
watertight . --check --max-age 30    # also fail receipts older than 30 days
watertight . --strict                # promote warnings (worded-number) to errors
watertight . --max-raw 2             # bound the {{raw:}} escape hatch
watertight verify .                  # re-fetch sources and compare — writes nothing
watertight . --json                  # machine-readable result
```

<br>

## What the output looks like

`--format md` produces grounded markdown that pastes into Notion, a PR body,
or Slack with its provenance intact — every figure bold with a superscript
into a receipts appendix:

```markdown
Conversion moved from **3.1%** ⁽¹⁾ to **3.6%** ⁽²⁾, a lift of **+16.1%p** ⁽³⁾.

---

### Receipts (3 metrics)

1. **conversion_before** = 3.1% — purchases / sessions entering checkout
   sql · reports/checkout.sql · 2026-08-15 ~ 2026-08-31 · fetched 2026-09-15
2. **conversion_after** = 3.6% — purchases / sessions entering checkout
   sql · reports/checkout.sql · 2026-09-01 ~ 2026-09-14 · fetched 2026-09-15
3. **lift** = +16.1%p — relative change in conversion
   = conversion_before → conversion_after (recomputed)
```

The default HTML render is a single self-contained file where hovering any
figure shows its receipt.

<br>

## What it checks

| check | catches |
|---|---|
| `naked-number` | any digit in prose not covered by a reference — heading text included; dates, URLs, code spans, letter-prefixed name tokens (`Q3`, `v6.109.0`, `iOS15`) and `{{raw:}}` are exempt |
| `unknown-ref` | `{{m:...}}` / `{{id:...}}` pointing at nothing |
| `missing-field` | a measured metric without `source`, `window`, or `fetched_at` |
| `definition-required` | a `ratio` / `ratio-point` metric with no stated basis — this is how a fill rate of 107% stays honest |
| `derived-mismatch` | a `sum` that doesn't add up; a `pct_change` that doesn't recompute — to the stored value's own precision, so `0.161` passes as 16.1% but `0.15` for 15.5% fails |
| `claim-without-evidence` | a `{{claim:}}` with no `evidence:` keys, or keys that don't exist |
| `malformed-marker` | anything still marker-shaped after every recognised form — a typo'd `{{claim:…\|evidnce:…}}` must fail, not render verbatim |
| `bad-derived` | derived ops referencing missing or non-numeric inputs |
| `empty-ir` | a report "grounded" in nothing |
| `stale-metric` | with `--max-age <days>`: a receipt whose `fetched_at` is older than the budget — numbers age |
| `identifier-measurement` | an identifier whose value is shaped like a measurement (`"47%"`, `"1,428"`) — a number smuggled past the receipt requirement through the id door |
| `raw-budget` | with `--max-raw <n>`: more `{{raw:}}` escapes than the budget — the escape hatch stays boundable |
| `worded-number` | *(warn)* a quantity written in words — "세 배", "절반", "a million" — that no receipt can bind to; `--strict` makes it fail |
| `assertion-failed` | an `assertions` comparison that is false — the numbers no longer support the conclusion |
| `bad-assertion` / `duplicate-key` | a malformed assertion (unknown op, missing operand, range without `.lo`/`.hi`), or a key that is both metric and assertion |
| `unused-metric` | *(info)* a metric nothing references — drift signal, never fails, never promoted |
| `receipt-mismatch` | *(verify)* a stored value its source no longer returns — the receipt is real, the value is not |

Severities: **error** fails the build and suppresses output; **warn** and **info**
are reported while the output still renders and the exit code stays 0.

<br>

## Re-verification

**`watertight verify .`** re-fetches every reachable source and *compares* —
a stored value the source no longer returns is a `receipt-mismatch`, nothing
is written, and the run fails. This is the check that catches a plausible
receipt attached to a wrong value (the "AI remembered a number" failure) and
the natural CI companion to `--check`.

`watertight refresh .` is the writing counterpart: it re-fetches, rewrites
`value` and `fetched_at`, recomputes derived values — and when a changed
metric is cited as claim evidence, it says so:

```
  fallback_revenue_total: 1,428 → 45,200
  ⚠ claim "수익 가설 미달" cites fallback_revenue_total — the number moved, review the conclusion
```

Conclusions age like numbers do. Sources:

- `csv` sources — `{ "type": "csv", "file": "data.csv", "cell": "B2" }`
- `json` sources — `{ "type": "json", "file": "kpi.json", "path": "revenue.total" }`
- `command` sources — run **only** with the explicit `--allow-commands` flag,
  because refreshing an IR you didn't author must never execute its shell
  commands
- everything else (dashboards, vendor reports, hypotheses) is **named as
  skipped** — never silently assumed fresh

Derived values follow their inputs: sums are recomputed exactly, percentage
changes at the precision the author stated. `--dry-run` previews changes
without writing.

<br>

## Custom fetchers

Any other source type can be refreshed through a JS module you point at
explicitly:

```bash
watertight refresh . --fetchers ./my-fetchers.mjs
```

```js
// my-fetchers.mjs — export one function per source type
export async function mixpanel(source) {
  // credentials from the environment, receipt fields from the IR
  return valueFetchedFrom(source.project, source.bookmark)
}
```

[`examples/fetchers/mixpanel.mjs`](./examples/fetchers/mixpanel.mjs) is a
working reference. The trust boundary is explicit: a fetcher module loads only
when the person running refresh names it on the command line — the IR itself
can never designate one, so an untrusted `metrics.json` still cannot execute
anything. Built-in `csv`/`json`/`command` adapters always win over a custom
one of the same name.

<br>

## In CI

The repo ships a composite GitHub Action that finds every `report.md` under a
path and runs `--check` on it — finding nothing is exit 2, not a green build:

```yaml
on:
  pull_request:
  schedule:
    - cron: '0 9 * * 1'   # numbers age — re-check weekly

jobs:
  reports-hold-water:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: camosss/watertight@v0
        with:
          path: reports/
          max-age: 30        # optional: fail receipts older than 30 days
```

`watertight verify` pairs with it when your sources are reachable from CI:
compile proves the narrative matches the IR, verify proves the IR matches
reality.

<br>

## For AI-authored reports

[`SKILL.md`](./SKILL.md) is an authoring contract for coding agents: gather
receipts first, build the IR from real sources only, reference — never type —
figures, and fix leaks by re-fetching, not by weakening the text. The compile
step turns "please don't hallucinate numbers" from a request into a gate.

<br>

## What it deliberately does not do

- **Judge whether evidence supports a claim.** `{{claim:}}` proves evidence
  is *attached* and *exists*; whether it actually supports the conclusion is
  the author's judgment. The tool makes that judgment inspectable, not
  automatic.
- **Verify a source is truthful.** A receipt says where a number came from,
  not that the origin was right.
- **Use an LLM.** Every check is deterministic. The point is to be the fixed
  ground an LLM-assisted workflow can push against.

<br>

## Related work

- [Proof-Carrying Numbers (arXiv:2509.06902)](https://arxiv.org/abs/2509.06902)
  proposes numbers as claim-bound tokens verified at render time — the same
  philosophy applied to LLM output streams. watertight applies it to the
  document build step instead.
- [Evidence](https://evidence.dev) compiles markdown + SQL into reports, and
  proves the "reports as source code" mechanism — but doesn't enforce that
  prose figures stay grounded.

<br>

## License

`watertight` is released under an MIT license. See [License](LICENSE) for more information.
