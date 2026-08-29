---
name: watertight
description: Write reports where every number carries its receipt. Use when authoring any document that states metrics — experiment verifications, incident reviews, performance reports — so that no figure appears without a recorded source, and hallucinated or stale numbers fail the build instead of shipping.
---

# watertight

You are writing a report that must hold water: every number in it either
carries a receipt or the compile fails. Your job is not to make the compiler
pass — it is to make the report true, and use the compiler to prove it.

## Setup

```bash
npm install -g watertight   # or: npx watertight
```

## The workflow

**1. Gather receipts before writing prose.**
For every figure the report will state, record where it came from *at the
moment you obtain it* — the query, the export, the dashboard URL, the
document. If you cannot say where a number came from, you do not have the
number yet.

**2. Write the IR (`metrics.json`).**

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
    },
    "revenue_total": {
      "value": 1428, "unit": "USD",
      "derived": { "op": "sum", "of": ["revenue_ios", "revenue_android"] }
    },
    "lift": {
      "value": 0.161, "unit": "ratio-point",
      "definition": "relative change in conversion",
      "derived": { "op": "pct_change", "before": "conversion_before", "after": "conversion_after" }
    }
  },
  "identifiers": { "app_version": "3.2.0", "flag": "checkout_v2" }
}
```

- `source.type` is free-form (`sql`, `mixpanel`, `csv`, `hypothesis`, …);
  put enough alongside it that a stranger could re-fetch the value.
- Numbers that *name* rather than *measure* (versions, flags, unit IDs) go
  in `identifiers`, not `metrics`.
- Anything computed from other metrics must be `derived` — the compiler
  recomputes it and rejects mismatches beyond the value's own precision.
- `ratio` / `ratio-point` metrics require a `definition`. Ratios above 1.0
  are legal but the definition must explain the basis.
- A hypothesis or plan figure is still a metric — source it as
  `{ "type": "hypothesis", ... }` pointing at the planning doc.

**3. Write the narrative (`report.md`).**
Never type a figure into prose. Reference it:

- `{{m:conversion_after}}` — renders the value with its receipt
- `{{id:app_version}}` — identifier
- `{{claim: the fallback works on both platforms | evidence: recovery_ios, recovery_android}}`
  — a qualitative conclusion, pinned to the metrics that support it
- `{{raw:24/7}}` — escape hatch for rhetorical numbers; it is greppable,
  so use it rarely and honestly

**4. Compile, and treat every leak as a question about the data.**

```bash
watertight report.md metrics.json          # writes report.html
watertight . --format md                    # grounded markdown (Notion / PR / Slack)
watertight . --check                        # CI mode: verify, write nothing
watertight . --check --max-age 30           # also fail receipts older than 30 days
```

Every leak names its line (`report.md:31`), so fix them where they live.
Fix leaks by *going and getting the receipt* — running the query, opening
the export — never by deleting the number, weakening the claim, or wrapping
a measurement in `{{raw:}}` to silence the checker. A `derived-mismatch` is
the tool telling you a stated total or delta does not follow from its
inputs: recompute at the source and correct whichever side is wrong.

**5. Re-verify later with `watertight refresh .`** — re-fetches csv/json
sources, updates `fetched_at`, recomputes derived values, and names every
metric it could *not* refresh. `command` sources run only under
`--allow-commands`; never pass that flag on an IR you did not author.
Other source types (vendor APIs, analytics tools) can be refreshed through
`--fetchers <module.mjs>` — one exported function per source type, with
credentials from the environment, never from the IR.

## What stays yours

The compiler proves every number has a source and every arithmetic step
checks out. It does not judge whether the evidence actually supports the
claim — that judgment is the author's, and pinning claims to named metrics
exists to make that judgment inspectable, not to automate it away.

## Hard rules

- Never invent, estimate, or "recall" a value into the IR. No source, no number.
- Never edit a `value` to make a `derived-mismatch` pass. Fix the inputs.
- Real company data stays in private storage; fixtures and examples are fictional.
