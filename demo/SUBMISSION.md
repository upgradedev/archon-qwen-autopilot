# Archon Autopilot: Devpost submission description

*Paste the body below into the Devpost "description" field. Track 4. ~750 words.*

---

## The AP agent that stops before the money moves

One invoice is rarely the hard part of accounts payable. The difficulty is the
context around it: a vendor's history, a possible duplicate, a
figure that may not reconcile, and an untrusted document that can even carry prompt
injection. The clerk working that inbox needs leverage without giving up control of
the money.

**Archon Autopilot** reads, recalls, validates, and proposes one action with concrete
arguments. It **structurally cannot move money on its own**. Recognized injection patterns are
surfaced at the approval gate. Safety does not depend on detecting every phrase.

### The product in one pass

- **Bounded multi-step ReAct loop** over `qwen-plus` **function-calling**: the agent
  chains autonomous, side-effect-free tools in order: recall vendor history first →
  validate (R1–R4) → relevant duplicate (R5), variance (R6), or context checks. It then proposes **exactly
  one** terminal action. The 22-scenario eval averages **2.4 autonomous steps**
  (53 total, rounded to one decimal).
- **Human-in-the-loop gate**: reviewer-authenticated proposals persist as PENDING
  **with the auditable tool/observation trace plus concise model rationale**; public
  intake is an isolated non-durable preview with redacted evidence. No sink executes
  at intake: approval executes the original reviewed args,
  amendment executes the reviewed replacement args, and rejection executes nothing.
  The domain args a human approves are exactly the args that execute. Two sinks are
  **real when configured**: `draft_vendor_reply` submits the approved message to the
  configured SMTP transport and awaits transport acceptance; recipient delivery is not
  claimed. A stable intent Message-ID is used, but recipient-level exactly once is not
  claimed. `draft_journal_entry` fsyncs a balanced row to a restart-safe,
  append-only JSONL ledger. Payment and specialist-review sinks remain simulated.
- **Structural tool-attack defense**: the model's tool catalog contains only the
  *proposing* tools; it contains no `approve`, `amend`, `reject`, or `pay`
  capability. Out-of-catalog verbs are rejected and cannot reach execution. No
  injection can autonomously execute. An advisory pattern scan surfaces recognized
  attacks in the trace and at the gate. Offline tests include a **poisoned-memory**
  prior that is genuinely recalled yet still cannot move money
  (`tests/pentest/prompt-injection.test.ts`).
- **Correction-aware memory**: duplicate + anomaly checks read persistent **pgvector**
  vendor history. Human amend/reject outcomes are written back and lifted into the
  next decision. In the controlled delta, a material re-bill above the verified
  human-corrected amount changes `draft_payment → flag_for_review`, while the
  compliant corrected-amount control stays a payment proposal. No model weights are
  updated.
- **One decision surface, one proposal-only surface**: HTTP + Approval UI is the exclusive
  authenticated decision path; an **MCP server exposes four proposal/read-only tools**
  (`intake_invoice`, `list_pending`, `recall_vendor`, `list_skills`) and cannot decide
  or execute. A **9-skill custom catalog** remains introspectable. The measured offline
  policy eval is **22/22**, averaging 2.4 autonomous steps. The final Node,
  real-pgvector, Playwright, adversarial, coverage, and audit totals come directly
  from the immutable CI run for the submitted commit, avoiding stale copied counts.
  A published 50-VU offline application-path k6 ramp completed 13,204 requests with
  zero HTTP failures; it uses Fake Qwen and in-memory storage and is not a live-Qwen,
  provider, pgvector, or production-capacity claim.
- **A small impact model, stated narrowly**: within an authored 12-case workflow
  model, the assisted arm uses fewer modeled base active-review seconds and human
  checkpoints while both arms match the developer policy labels. This is a fixed
  synthetic workflow comparison, not a human study, field trial, labor-savings or ROI
  claim.

### Where Qwen does the work

`qwen-plus` (function-calling decider) · `text-embedding-v4` (memory) · `qwen-vl-max`
(reads uploaded invoice PDFs/images via `src/qwen/vision.ts`). All three use the
OpenAI-compatible DashScope endpoint. Low/unknown extraction confidence, unresolved
field conflicts, or a document payable total inferred because its source total was
unreadable fail toward human review rather than a payment proposal. The distinguishing
combination is an agent that uses persistent evidence to choose a proposal yet cannot
move money by design.

This Track-4 entry carries forward the Archon name and limited
shared plumbing patterns from the separate MemoryAgent foundation (provider-client,
pgvector, health, and deployment conventions). It does **not** claim that shared
plumbing as its judged novelty, and it does not reuse the MemoryAgent entry's
self-audit/resolution product core. The submitted work is the accounts-payable
normalizer and validator, bounded Qwen tool loop, durable PENDING state machine,
authenticated human decision boundary, correction feedback, AP sinks, narrower MCP
surface, adversarial/evaluation suite, separate demo, and Alibaba deployment.

**Live:** https://autopilot.43.106.13.19.sslip.io · **Track 4** · Repo:
https://github.com/upgradedev/archon-qwen-autopilot

**Architecture:**
https://github.com/upgradedev/archon-qwen-autopilot/blob/main/docs/judge-architecture.svg

**Eligibility:** first repository commit `8a6359f` on 2026-07-04, after the
2026-05-26 start; the distinct Track-4 product described above was materially built
during the submission period. Shared naming and limited plumbing are disclosed, not
presented as newly authored evidence.

---

**Alibaba Cloud proof:** the required code proof is the DashScope OpenAI-compatible
client (base URL + Qwen instantiation) in
[`src/qwen/client.ts`](https://github.com/upgradedev/archon-qwen-autopilot/blob/main/src/qwen/client.ts);
the public demo video and gallery proof show the deployed runtime release's sanitized
app-specific identity, exact release provenance, readiness, decision canary, and
vision canary. Devpost uses the video's unrestricted Public hosted URL, not a
repository blob link.
