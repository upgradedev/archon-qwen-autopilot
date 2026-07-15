# Ready-to-publish post drafts

Replace `[VIDEO_URL]` and `[POST_IMAGE_ALT]` only after the final public assets exist.
The repository and public hostname are fixed, but publish only after the exact-release
proof in [`BUILD_RECORDING.md`](BUILD_RECORDING.md) passes. Do not include the reviewer
token.

## LinkedIn / long-form social

We built **Archon Autopilot** for the Qwen Cloud Hackathon, Track 4: a human-gated
accounts-payable agent that does the expensive cognitive work without quietly taking
control of the money.

For each invoice, `qwen-plus` runs a bounded function-calling loop: recall vendor
history from pgvector, validate the finance fields, check for a duplicate, compare the
amount with prior invoices, then propose exactly one action. With a valid reviewer
credential, the proposal becomes a durable PENDING item with full evidence; the
unauthenticated demo returns only an isolated, non-durable, redacted PREVIEW with no
queue/history access. A human must approve or amend the exact durable arguments before
anything executes.

That boundary is structural. The model-facing tool catalog has no approve/pay/execute
capability, so direct invoice injection, poisoned recalled memory, and compromised-
model attempts cannot autonomously cross the gate. Recognized generic injection
patterns are surfaced for review, but the safety property does not depend on perfect
detection.

The MCP integration follows the same least-agency rule: its four tools can intake a
proposal and read pending/vendor/catalog state, but cannot approve or execute.
Authenticated HTTP/UI is the exclusive human decision surface.

Two post-approval transports are real when configured: an SMTP vendor reply and a
restart-safe, fsynced append-only JSONL double-entry ledger. Payment and specialist
review stay simulated—no claim of a bank or ERP integration.

Measured evidence: **22/22 offline policy eval with 2.4 average autonomous steps**,
plus Node, real-pgvector, Playwright, adversarial, coverage and audit gates. Copy the
exact final totals from the immutable CI run before publishing; do not reuse an old
count. The deterministic eval is a regression measurement, not live-model accuracy.

Live: https://autopilot.43.106.13.19.sslip.io

Code (MIT): https://github.com/upgradedev/archon-qwen-autopilot

Demo: [VIDEO_URL]

#Qwen #AlibabaCloud #AIHackathon #AgenticAI #FinTech #HumanInTheLoop

## X / short post

Archon Autopilot for the Qwen Cloud Hackathon (Track 4): Qwen recalls, validates,
dedupes and checks variance. Public callers get an isolated PREVIEW; reviewer-authenticated
proposals stop PENDING at a human gate. No approve/pay model tool.
22/22 tuned offline policy · avg 2.4 steps · full security/browser/DB CI gates.

https://github.com/upgradedev/archon-qwen-autopilot

## X thread

**1/4** Archon Autopilot is a human-gated AP agent on Qwen. It reads a real invoice,
recalls vendor history, validates R1–R6, checks duplicate/variance, and proposes one
action. Public intake returns an isolated redacted PREVIEW; reviewer-authenticated
intake persists the full trace/rationale as PENDING, then stops.

**2/4** Safety is structural: the model has no approve/pay/execute tool. Injection or
poisoned memory may influence a proposal but cannot cross the human gate. MCP is
proposal/read only; authenticated HTTP/UI alone owns decisions.

**3/4** Two real configurable effects live after approval: SMTP vendor reply + a
restart-safe append-only JSONL ledger. Payment/review are intentionally simulated.
Evidence: 22/22 offline policy eval, avg 2.4 steps, with final security/browser/DB
totals linked from the submitted commit's immutable CI run.

**4/4** Live on Alibaba Cloud / Qwen, MIT licensed:
https://autopilot.43.106.13.19.sslip.io
https://github.com/upgradedev/archon-qwen-autopilot
[VIDEO_URL]

## Devpost community update

**What changed in the final hardening pass**

Archon Autopilot now has authenticated reviewer APIs, atomic single-execution claims,
explicit recovery for uncertain sink outcomes, persistent production quotas, stricter
currency/date/line-item/extraction-confidence fail-safes, and two real configurable
post-approval transports: SMTP and a restart-safe durable JSONL ledger.

The final submitted commit must have green Node, real-pgvector, Playwright,
adversarial, four-metric coverage, secret-scan and dependency-audit gates; paste its
exact immutable CI totals here immediately before publishing. The deterministic
policy eval is 22/22 and averages 2.4 autonomous steps. Full evidence and honest
limitations are mapped in the repository.

## Suggested image alt text

- **Hero:** `[POST_IMAGE_ALT] Archon Autopilot approval dashboard showing document
  intake and a human-gated pending queue.`
- **Trace:** `Expanded AP proposal showing vendor recall, finance validation, duplicate
  check, amount variance, and one pending terminal action.`
- **Architecture:** `Flow from untrusted invoice through Qwen's bounded read/analyze
  loop to a pending proposal, authenticated human gate, SMTP/JSONL sinks, and pgvector
  memory.`
