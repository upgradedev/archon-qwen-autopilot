# Offline synthetic impact study

This evidence is a **fixed synthetic workflow-model comparison; not a human
study, field trial, production benchmark, labor-savings claim, or ROI analysis**.
It answers a deliberately narrow judging question: if the same 12 authored AP
cases are processed through a reasonable manual checklist model versus an
Autopilot-assisted review model, how do their declared active-review tasks,
human checkpoints, and developer-policy-label mismatches compare?

The answer is reproducible and useful as workflow-design evidence. It is not a
claim about actual employees, elapsed production time, wages, invoice volumes,
or economic return.

## Design and registration boundary

The repository-local analysis plan is frozen in
[`impact/protocol.json`](../impact/protocol.json). It fixes:

- the 12-case denominator and order, with no post-freeze exclusions or
  imputation;
- a manual checklist that includes history, duplicate, amount, and currency
  checks rather than an intentionally weak comparator;
- the assisted human-review checkpoints;
- low/base/high task weights;
- two primary endpoints (modeled active-review seconds and modeled human
  touches), one safety endpoint (developer-policy-label mismatch), rounding,
  and sensitivity rules;
- descriptive analysis only, with no p-values, confidence intervals, causal
  inference, or population extrapolation.

This is a repository-local **analysis-plan freeze**, not an external,
prospective, outcome-blind preregistration. The underlying developer regression
fixtures and their deterministic outcomes already existed before this study was
assembled. That limitation is part of the protocol and generated result.

## Fixed case set and provenance

[`impact/cases.json`](../impact/cases.json) is an exact 12-case projection from
the 22-scenario [`eval/dataset.ts`](../eval/dataset.ts) set. The analyzer fails
if that projection, order, denominator, or any copied payload/label drifts.
Cases cover:

- clean new and recurring vendors;
- missing fields and unreconciled totals;
- exact and near duplicates;
- amount anomalies;
- colliding precedence rules;
- a currency change; and
- an invoice with no parseable payable total.

The labels are developer-authored AP policy labels, not independent expert
ground truth. The raw record
[`impact/raw-observations.json`](../impact/raw-observations.json) binds the
assisted actions and tool traces to a deterministic offline replay through
`eval/lib.ts` at the exact source commit recorded inside that raw file, using
Node.js 24.18.0 and `FakeQwenChatClient` without network access. It deliberately
excludes local wall-clock replay latency.

Every `impact:check` and `impact:write` executes all 12 cases again through
`runScenario(scenario, "offline")` and requires the final action, reported
model id, raw model action, stop reason, read/analyze-step count, exact trace
tool sequence, and policy-override flag to match the frozen raw record. A
focused `impact:check-raw` command exposes that replay comparison directly.

The replay cannot merely label itself as canonical. The command requires the
executing `process.version` to equal `v24.18.0`, resolves the raw record's full
Git commit and tree IDs, requires that source commit to remain an ancestor of
the current `HEAD`, and proves that the complete local replay closure is
unchanged and free of staged, unstaged, untracked, assume-unchanged, or
skip-worktree state. That closure includes `src/`; the five transitively loaded
`eval/` modules; the analyzer and provenance gate; protocol/case inputs; and the
package, lock, and TypeScript runtime manifests. The eval dataset and runner are
dynamically imported only after the runtime, committed-raw, and source gates
pass. A later commit may add the refreshed evidence without changing the frozen
replay source; the verifier deliberately does not serialize the later `HEAD`,
so such an evidence-only commit remains reproducible.

The manual actions are a frozen developer application of the declared
checklist; no human participant made or timed those decisions. Both arms store
task sequences, not precomputed time/touch outcomes. The analyzer derives every
number from the protocol.

## Descriptive result

The canonical generated report is
[`impact/RESULTS.md`](../impact/RESULTS.md), with machine-readable rows and
input hashes in [`impact/results.json`](../impact/results.json).

Every textual input hash is SHA-256 over its LF-canonical UTF-8 form. CRLF and
LF checkouts therefore bind to the same evidence identity, while any lone
carriage return is rejected as ambiguous. `.gitattributes` also pins the full
replay source and evidence-input closure to LF so Windows and Linux checkouts
exercise the same bytes before analysis.

| Fixed 12-case endpoint | Manual model | Assisted model | Manual − assisted |
|---|---:|---:|---:|
| Base modeled active-review seconds, total | 2,292 | 836 | 1,456 |
| Base modeled active-review seconds, mean/case | 191.0 | 69.7 | 121.3 |
| Modeled human touches, total | 100 | 58 | 42 |
| Modeled human touches, mean/case | 8.3 | 4.8 | 3.5 |
| Developer-policy-label mismatches | 0/12 | 0/12 | 0 |

Within these authored tasks and weights, the assisted arm is 63.5% lower on
base modeled active-review seconds and 42.0% lower on modeled human
checkpoints. Under the deliberately adverse declared-weight comparison
(manual low versus assisted high), the paired total remains +68 modeled seconds
overall, but only 9/12 cases are positive and 3/12 are at or below zero. Those
are task-weight sensitivity bounds, not confidence intervals or measured human
variability.

Both arms have 0/12 label mismatches. This does **not** establish error
reduction: actions and labels are developer-authored and the cases are tuned
synthetic fixtures. It shows only self-consistency with the fixed AP policy.

## Permitted and prohibited interpretation

Permitted:

> Within this authored 12-case workflow model, the assisted arm uses fewer
> modeled base active-review seconds and human checkpoints while both arms
> match the developer policy labels.

Not supported by this study:

- ROI, labor savings, wage savings, or headcount reduction;
- production throughput, service-level, or cycle-time improvement;
- production or human error reduction;
- causal impact, statistical significance, or population generalization; or
- a claim that synthetic seconds equal elapsed employee time.

The existing authenticated `/impact-metrics` endpoint is complementary
operational instrumentation over retained work items. It measures proposal
latency, read/analyze steps, caught conditions, and recorded reviewer touches;
it also does not establish ROI or labor savings.

## Reproduce and audit

Using the repository-locked Node/npm toolchain:

```bash
npm run impact:check
```

For the focused agent-to-raw replay check:

```bash
npm run impact:check-raw
```

The full command replays the agent, validates inputs and LF-canonical hashes, recomputes
every row, and requires
`impact/results.json` and `impact/RESULTS.md` to be byte-identical to fresh
output. `impact:write` can regenerate only those two derived outputs after the
committed raw/source identity is already valid:

```bash
npm run impact:write
```

After any replay-source or protocol change, use the two-commit evidence flow:

```bash
# Commit A: every source, protocol, raw-input, documentation, and code change;
# the worktree must now be completely clean.
npm run impact:refresh-source
# Review the three resulting evidence-only changes, then commit B.
npm run impact:check
```

`impact:refresh-source` refuses a dirty or uncommitted commit A, records that
exact `HEAD` and tree in the raw collection, reruns all 12 cases, and rewrites
only the raw identity plus the two generated results. Do not silently rewrite
v1 inputs after seeing a result. Version the protocol, retain every case in the
denominator, commit the complete source first, and make the refreshed evidence
an auditable descendant commit.
