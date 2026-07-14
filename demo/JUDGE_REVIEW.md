# Archon Autopilot — strict final judge review

**Review date:** 2026-07-15

**Entry:** Qwen Cloud Hackathon, Track 4 — Autopilot Agent

**Review posture:** evidence-first, skeptical of unmeasured LLM claims

## Executive verdict

Archon Autopilot is technically credible and differentiated. It is not an invoice
chatbot with a prompt around it: `qwen-plus` runs a bounded function-calling loop over
memory recall and AP validations, stops at one persisted proposal, and cannot execute
without an authenticated human decision. The strongest story is the combination of
agentic depth, structural least agency, and a measurable correction feedback loop.

The engineering package is ready. Presentation is the remaining variable: the final
recording and screenshots must make the workflow obvious within three minutes and must
not expose the reviewer credential.

## Rubric assessment

| Criterion | Strict score | Evidence | What prevents a perfect score |
|---|---:|---|---|
| **Innovation & AI Creativity (30%)** | **9.2/10** | Bounded Qwen function-calling loop; model catalog separated into five read/analyze and four proposal skills; human gate doubles as a correction signal that changes a later decision; injection resistance comes from unreachable execution rather than trusting a classifier. | The offline `22/22` is a deterministic policy result, not live-model accuracy; no multi-agent/A2A layer, by deliberate design. |
| **Technical Depth & Engineering (30%)** | **9.4/10** | Authenticated HTTP/UI exclusively owns decisions; a four-tool MCP surface shares intake/memory but is limited to proposal/read operations; Qwen vision + embeddings + chat; pgvector memory; strict auth; production quotas; atomic claims; explicit uncertain-outcome recovery; durable restart-safe ledger; 240/246 Node pass with six declared DB skips; 25/25 browser; 30/30 adversarial; >80% coverage in every dimension. | Complex-document vision lacks a labelled extraction benchmark; the local MCP surface can still read proposal/vendor state and must be access-controlled at the process boundary; SMTP cannot promise recipient-level exactly once. |
| **Problem Value & Impact (25%)** | **8.9/10** | Solves a real AP bottleneck while retaining human control; duplicate/anomaly checks use cross-session evidence; configurable SMTP and durable JSONL ledger create real post-approval effects. | Payment rail and specialist case system remain simulated; no production time-saved or error-rate study is claimed. |
| **Presentation (15%) — artifacts** | **9.1/10** | Strong README, architecture, judge guide, evidence matrix, honest eval method, Devpost copy, story, blog, and reproducible commands. | Final public hosted video, refreshed screenshots, and published post are human-owned and must still be supplied. |

**Weighted artifact score:** approximately **9.2/10** before judging variance. This is
an assessment of the repository and supplied materials, not a promise of placement.

## What a judge can verify quickly

1. Upload the real sample PNG and watch `qwen-vl-max` extraction feed the same loop as
   JSON intake.
2. See multiple ordered read/analyze steps stream before exactly one PENDING action.
3. Expand the full evidence trace and inspect validation, duplicate, and variance
   observations.
4. Authenticate, amend an argument, approve, and inspect the proposed→approved audit
   diff in Decided.
5. Repeat the same invoice and see the duplicate route to human review.
6. Inspect a recognized injection warning while the item remains PENDING and no sink
   fires automatically.
7. Run the offline evidence commands: 22/22 eval, 30/30 adversarial, 25/25 browser,
   and the 22-pass readiness report.

## Strongest technical differentiators

### 1. The agent gathers evidence; it does not classify once

Qwen chooses the next function call from a bounded catalog. Vendor recall and
structural validation are required evidence; duplicate and amount-variance tools run
when relevant; a terminal tool ends the loop. Max-step, deadline, no-progress, and
deterministic evidence-before-action guards fail safely to review.

### 2. Least agency is enforced structurally

The model can propose `draft_journal_entry`, `draft_payment`, `draft_vendor_reply`, or
`flag_for_review`; it cannot call an approval or execution function. An authenticated
reviewer decision, atomic work-item claim, runtime argument validation, and the single
execution chokepoint are separate layers. The adversarial tests cover direct invoice
payloads, poisoned recalled memory, a compromised model attempting excessive agency,
authorization/replay, sensitive-data exposure, and sink injection.

### 3. Human corrections are read, not merely stored

An amendment/rejection writes structured correction metadata to vendor memory.
`recall_vendor_history` lifts that signal into the next loop. The controlled eval shows
a materially over-billed repeat flip from `draft_payment` to `flag_for_review`, while
the corrected-amount control stays `draft_payment`.

### 4. Two real configurable terminal transports

- `SmtpEmailSink` uses Nodemailer after approval and receives exactly the approved or
  amended message. A transport failure propagates and does not produce a false success.
- `JsonlLedgerSink` appends a balanced double-entry row, fsyncs it, and records a
  per-work-item marker so a completed ref dedupes after restart. Ambiguous outcomes
  require reconciliation rather than automatic replay.

Both select inspectable Fakes when unconfigured. `draft_payment` and specialist review
remain simulations. This is materially stronger than the earlier single-transport
scope and is still honest about the absence of a bank/ERP integration.

## Security, auth, and testability

- Public intake is deliberate for judge access; persistent per-client/global quotas
  bound model spend. Invalid input is rejected before quota consumption.
- HTTP queue reads and all reviewer mutations require a constant-time-compared Bearer
  token. Production refuses to start without a token of at least 32 characters. The UI holds
  it only in tab-scoped `sessionStorage`.
- Same-origin is the default; CORS uses an explicit allowlist and rejects wildcard
  configuration.
- Reviewer request schemas reject unknown control fields. Error responses hide
  provider/database detail and carry a request id for server-side correlation.
- MCP is local stdio with exactly four agent-safe tools: intake, pending read, vendor
  recall, and catalog read. It exposes no decision/execution verb; process access still
  controls who may read state, create PENDING work, and consume model capacity.

## Injection and vision — exact limitations

The advisory scanner is a bounded, documented set of generic patterns. It can miss
novel wording, other languages, images that vision fails to transcribe, or indirect
semantic attacks; therefore the submission must not claim universal detection.
Safety does not depend on scanner recall: untrusted values are fenced, the model has no
execution tool, and a reviewer must authorize the exact action.

Document intake accepts PDF/PNG/JPG, defaults to a 10 MiB limit, and examines at most
the first three PDF pages. Extension/MIME and magic bytes are checked; PDFs are
rasterized under a timeout, Qwen calls have a timeout, and model output is narrowed to
canonical fields. Low or missing extraction confidence and incomplete finance fields
force review. Still:

- magic-byte sniffing is not malware scanning or content disarm;
- relevance and injection findings are advisory rather than hard rejection;
- complex multi-page tables can be misread by a vision model;
- no labelled real-world extraction-accuracy benchmark is claimed.

These limitations are acceptable for a hackathon when shown plainly and paired with
fail-safe review behavior.

## Measurement — exact interpretation

| Measurement | Result | Correct interpretation |
|---|---:|---|
| Offline decision eval | **22/22 tool · 22/22 args · 22/22 autonomy; avg 2.5 steps** | Deterministic policy/regression evidence over the real pipeline, not live-Qwen accuracy |
| Node suite | **240 pass · 0 fail · 6 DB-gated skip (246 total)** | Bare-clone result; skipped real-Postgres cases are explicit |
| Playwright | **25/25** | Served UI flows in Chromium with deterministic providers |
| Coverage | **92.42 stmts · 84.28 branches · 91.26 funcs · 92.42 lines** | Current `c8` result; all above the 80% CI floor |
| Adversarial | **30/30** | Repository threat cases, not proof against every future attack |
| Readiness | **22 pass · 0 fail · 3 user-gated** | 100% of automatable checks; live mailbox/video/deploy evidence is never auto-claimed |
| Audits | **0 vulnerabilities** | Snapshot of current npm advisories, not a permanent guarantee |

## Remaining action

No additional product feature is required for a competitive submission. The remaining
work is the quality of the **video, screenshots, public post, and Devpost assembly**.
Follow [`FINAL_MEDIA_CHECKLIST.md`](FINAL_MEDIA_CHECKLIST.md); use
[`POST_DRAFTS.md`](POST_DRAFTS.md); and keep the claim/evidence wording aligned with
[`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).
