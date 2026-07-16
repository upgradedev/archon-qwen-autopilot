# Archon Autopilot — public post copy

Replace bracketed publication URLs only after signed-out verification. Remove an
optional URL line rather than publishing a placeholder.

## LinkedIn / long-form social

```text
We built Archon Autopilot for the Qwen Cloud Hackathon, Track 4: a human-gated
accounts-payable agent that does the expensive cognitive work without quietly taking
control of the money.

For each invoice, qwen-plus runs a bounded function-calling loop: recall vendor
history from pgvector first, validate the finance fields, select only the relevant
subset of duplicate, amount-variance, or context checks, then propose exactly one
action. With a valid reviewer credential, the proposal becomes a durable PENDING item
with full evidence; the unauthenticated demo returns only an isolated, non-durable,
redacted PREVIEW with no
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

Measured evidence includes a 22/22 offline policy eval with 2.4 average autonomous
steps plus Node, real-pgvector, browser, adversarial, coverage, and audit gates. The
submission links the exact immutable run for its final commit. The deterministic eval
is a regression measurement, not live-model accuracy.

Within an authored 12-case workflow model, the assisted arm uses fewer modeled base
active-review seconds and human checkpoints while both arms match developer policy
labels. This is synthetic workflow evidence—not a human study, field trial,
labor-savings or ROI claim.

Live: https://autopilot.43.106.13.19.sslip.io

Code (MIT): https://github.com/upgradedev/archon-qwen-autopilot

Demo: [PUBLIC_VIDEO_URL]

Build journey: [PUBLIC_BLOG_URL]

#Qwen #AlibabaCloud #AIHackathon #AgenticAI #FinTech #HumanInTheLoop
```

## X / short post

```text
Archon Autopilot (Track 4): Qwen recalls first, validates, selects only relevant duplicate/variance/context checks, then stops at PENDING. The model has no approve/pay tool; an authenticated human owns every consequence. Live: https://autopilot.43.106.13.19.sslip.io #QwenCloudHackathon
```

## X thread

```text
1/4 Archon Autopilot is a human-gated AP agent on Qwen. It reads an original synthetic invoice document, recalls vendor history first, validates it, selects only the duplicate/variance/context checks warranted by the evidence, and proposes one action. Public intake returns an isolated redacted PREVIEW; reviewer-authenticated intake persists the full trace/rationale as PENDING, then stops.

2/4 Safety is structural: the model has no approve/pay/execute tool. Injection or poisoned memory may influence a proposal but cannot cross the human gate. MCP is proposal/read only; authenticated HTTP/UI alone owns decisions.

3/4 Two real configurable effects live after approval: SMTP vendor reply + a restart-safe append-only JSONL ledger. Payment/review are intentionally simulated. Evidence: 22/22 offline policy eval, avg 2.4 steps, with final security/browser/DB totals linked from the submitted commit's immutable CI run.

4/4 Live on Alibaba Cloud / Qwen, MIT licensed:
https://autopilot.43.106.13.19.sslip.io
https://github.com/upgradedev/archon-qwen-autopilot
[PUBLIC_VIDEO_URL]
```

## Devpost community update

```text
What changed in the final hardening pass

Archon Autopilot now has authenticated reviewer APIs, atomic single-execution claims,
explicit recovery for uncertain sink outcomes, persistent production quotas, stricter
currency/date/line-item/extraction-confidence fail-safes, and two real configurable
post-approval transports: SMTP and a restart-safe durable JSONL ledger.

The submitted commit is gated by Node, real-pgvector, browser, adversarial,
four-metric coverage, secret-scan, and dependency-audit checks. The deterministic
policy eval is 22/22 and averages 2.4 autonomous steps. Full evidence and honest
limitations are mapped in the repository.
```

## Suggested image alt text

- **Hero:** `Archon Autopilot approval dashboard showing document intake and a
  human-gated pending queue.`
- **Trace:** `Expanded AP proposal showing vendor recall first, finance validation,
  the relevant subset of duplicate, amount-variance, or context observations, and one
  pending terminal action.`
- **Architecture:** `Flow from untrusted invoice through Qwen's bounded read/analyze
  loop to a pending proposal, authenticated human gate, SMTP/JSONL sinks, and pgvector
  memory.`
