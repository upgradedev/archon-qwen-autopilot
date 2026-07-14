# Judge guide — Archon Autopilot in five minutes

This is the shortest reproducible path through the Track-4 submission. The public
intake accepts invoices and streams the agent's reasoning. Queue reads and every
reviewer mutation require the private Bearer credential supplied in the Devpost
testing instructions. Never put that credential in a screenshot, recording, post,
repository file, or public URL.

- **Live Approval UI:** https://autopilot.43.106.13.19.sslip.io/
- **Health:** https://autopilot.43.106.13.19.sslip.io/health
- **Readiness:** https://autopilot.43.106.13.19.sslip.io/ready
- **API explorer:** https://autopilot.43.106.13.19.sslip.io/docs
- **Local:** Node 20+, `npm ci`, then start with a reviewer token as shown below.

Two terminal transports are real and configurable after approval: vendor replies
can use `SmtpEmailSink`, and balanced journal entries can use the restart-safe,
append-only `JsonlLedgerSink`. Without `SMTP_HOST` or `LEDGER_JSONL_PATH`, each falls
back to an inspectable Fake and performs no external write. Payment and specialist-
review sinks remain simulated; no bank or ERP is contacted.

## 0 · Authenticate the reviewer surface

On the live page, paste the private credential into **Judge reviewer token**. It is
stored only in that browser tab's `sessionStorage`. The public upload still works
without it, but `/pending`, `/decided`, `/approve`, `/amend`, `/reject`, and `/recover`
fail closed.

For a bare local clone, deterministic Qwen/embedding/vision Fakes need no API key and
no database, but the reviewer boundary still needs a token:

```powershell
$env:REVIEWER_TOKEN="local-reviewer-token-at-least-32-chars"
npm start
```

```bash
REVIEWER_TOKEN="local-reviewer-token-at-least-32-chars" npm start
```

Enter the same value in the UI token field. Production refuses to start without a
token and enforces at least 32 characters.

## 1 · Upload a document and watch the agent gather evidence

1. Open the Approval UI and click **Use sample document**.
2. The real PNG is magic-byte checked, then read by `qwen-vl-max` on the keyed live
   deployment (the deterministic fake supplies the same fields offline).
3. Inspect the extracted invoice, its source confidence, relevance result, and any
   advisory prompt-injection warning. Click **Process invoice**.
4. Watch the Server-Sent Events trace: `recall_vendor_history → validate_invoice →
   check_duplicate / compute_variance_vs_history` before a terminal proposal.

This evidences a bounded, tool-using `qwen-plus` ReAct loop rather than a one-shot
classification. Upload validation runs before quota consumption; low or unknown
extraction confidence is forced to human review.

## 2 · Inspect the PENDING proposal

The loop stops at exactly one terminal proposal. Nothing has executed. The card shows
the proposed tool, safe reasoning, decision confidence, and the full ordered trace.
Low confidence is explicitly labelled as a review nudge, not a calibrated probability.

The injection scanner is deliberately advisory and pattern-based. The safety property
does not depend on recognizing every phrase: the model-facing catalog contains no
approve/pay/execute capability, and execution remains behind the authenticated gate.

## 3 · Prove that the human approves exactly what runs

Edit a domain argument, add a reason, and click **Amend & approve**. The server
validates the approved arguments, atomically claims `PENDING → EXECUTING`, and passes
exactly the audited arguments to the selected sink. A tool override requires an
explicit tool, confirmation, and reason. Concurrent or repeated decisions return a
conflict and cannot cause a second execution.

If the proposal is a journal entry and `LEDGER_JSONL_PATH` is configured, approval
fsyncs one balanced JSONL record and a durable per-work-item idempotency marker. A
vendor reply uses SMTP only when configured. A transport error stays visibly
`executing` for explicit reconciliation; the service never blindly auto-retries an
uncertain external outcome.

## 4 · Inspect the audit trail and learning signal

Open **Decided**. The item shows its outcome, reviewer, timestamp, and proposed→approved
tool/argument diff. The amendment or rejection is written to vendor memory; the next
decision reads that correction. Reproduce the measured rebill behavior with:

```bash
npm run eval:corrections
```

The controlled result is `draft_payment → flag_for_review` when a later invoice
re-bills materially above a human-corrected amount, while the corrected-amount control
remains `draft_payment`.

## 5 · Submit and inspect through the agent-safe MCP surface

```bash
npm run mcp
```

The local stdio server exposes exactly four tools: `intake_invoice`, `list_pending`,
`recall_vendor`, and `list_skills`. HTTP and MCP resolve the same agent dependencies,
queue, memory, and nine-skill catalog, but the MCP capability is intentionally narrower:
it can create PENDING proposals and read state only. It has no approve, amend, reject,
recover, pay, or execution tool. Human decisions are exclusive to the authenticated
HTTP API / Approval UI. MCP is not exposed as a public listener.

## Reproduce the evidence

```bash
npm ci
npm run typecheck
npm run build
npm test                 # 246 total: 240 pass, 0 fail, 6 real-DB skips without DATABASE_URL
npm run test:e2e         # 25/25 Playwright
npm run coverage         # 92.42 stmts · 84.28 branches · 91.26 funcs · 92.42 lines
npm run test:pentest     # 30/30
npm run eval             # 22/22 tool + args + autonomy; avg 2.5 autonomous steps
npm run readiness        # 22 pass · 0 fail · 3 explicitly user-gated
```

The offline `22/22` is a deterministic policy/regression result over the real
multi-step pipeline, not a claim that live `qwen-plus` scored 100%. Keyed Qwen traces
are captured separately. See [`CLAIM_EVIDENCE_MATRIX.md`](CLAIM_EVIDENCE_MATRIX.md)
for the exact source and test behind every submission claim.
