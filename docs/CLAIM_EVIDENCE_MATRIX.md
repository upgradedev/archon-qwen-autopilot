# Claim → evidence matrix

**Snapshot:** 2026-07-15. Use this table as the source of truth for the README,
Devpost copy, narration, screenshots, and posts. A claim may be described more simply
in public copy, but not made stronger than the evidence below.

| Submission claim | Implementation evidence | Behavioral evidence | Approved wording / boundary |
|---|---|---|---|
| Qwen runs a bounded multi-step function-calling loop | `src/ap/loop.ts`, `src/ap/analysis-tools.ts`, `src/qwen/client.ts` | `tests/unit/loop.test.ts`, `tests/unit/workflow.test.ts`, `npm run eval` | “`qwen-plus` chooses successive read/analyze tools before one proposal.” Do not call the deterministic offline score live-Qwen accuracy. |
| Every eval scenario is genuinely multi-step | `eval/run.ts`, `eval/lib.ts`, `eval/dataset.ts` | **22/22 tool + args + autonomy; avg 2.5 autonomous steps** | “All 22 scenarios take at least two autonomous steps; average 2.5.” |
| Document intake uses Qwen vision | `src/qwen/vision.ts`, `src/server.ts` | `tests/unit/vision.test.ts`, `tests/security/upload-guard.test.ts`, sample at `demo/sample-invoice.png` | “`qwen-vl-max` reads PDF/PNG/JPG on the keyed path.” Offline uses a declared deterministic extractor. No general extraction-accuracy claim. |
| Decisions use persistent vendor memory | `src/memory/store.ts`, `src/memory/embeddings.ts`, `src/ap/analysis-tools.ts` | `tests/integration/pgvector-store.test.ts`, `tests/integration/workflow-http.test.ts` | “Duplicate/anomaly checks use recalled vendor history; production uses pgvector.” Bare-clone DB cases skip visibly when no `DATABASE_URL`. |
| Nothing executes at intake | `src/agents/autopilot-agent.ts`, `src/ap/tools.ts` | `tests/pentest/authz-hitl.test.ts`, `tests/pentest/prompt-injection.test.ts`, sink tests | “Intake produces at most a PENDING proposal; no sink fires.” |
| The model cannot approve/pay/execute | `src/ap/loop.ts`, `src/ap/tools.ts`, `src/skills/catalog.ts` | `tests/pentest/excessive-agency.test.ts`, `tests/unit/skills.test.ts` | “Execution capabilities are absent from the model-facing catalog.” This is the structural safety boundary. |
| HTTP reviewer actions are authenticated | `src/server.ts`, `src/ui.html` | `tests/unit/server.test.ts`, `tests/pentest/authz-hitl.test.ts` | “HTTP queue/reviewer APIs require a private Bearer token; production fails closed without ≥32 characters.” MCP pending reads are local-process scoped and MCP has no mutation tool. Never publish the token. |
| Approval is atomic and replay-safe | `src/ap/workitem-store.ts`, `src/agents/autopilot-agent.ts`, `src/db/schema.sql` | `tests/unit/workflow.test.ts`, `tests/integration/pgvector-store.test.ts`, `tests/pentest/authz-hitl.test.ts` | “One atomic PENDING→EXECUTING claim; concurrent/repeated decisions conflict.” |
| Approved arguments are exactly what runs | `src/agents/autopilot-agent.ts`, `src/ap/tools.ts` | `tests/pentest/authz-hitl.test.ts`, `tests/unit/smtp-sink.test.ts`, `tests/unit/ledger-sink.test.ts` | “Runtime-validated approved/amended args reach the sink; tool override needs explicit confirmation + reason.” |
| Uncertain side effects are not blindly retried | `src/agents/autopilot-agent.ts`, `src/server.ts` | recovery cases in `tests/unit/workflow.test.ts` | “A sink failure remains visible as executing until audited retry/mark-completed reconciliation.” |
| SMTP is a real configurable transport | `src/ap/smtp-sink.ts`, `src/deps.ts` | `tests/unit/smtp-sink.test.ts`, readiness `sink-smtp` | “With `SMTP_HOST`, Nodemailer sends after approval; otherwise the Fake records intent and sends nothing.” Do not claim a mailbox receipt without a captured receipt. |
| The ledger is a real durable configurable transport | `src/ap/ledger-sink.ts`, `src/deps.ts` | `tests/unit/ledger-sink.test.ts`, readiness `sink-ledger` | “With `LEDGER_JSONL_PATH`, approval appends/fsyncs one balanced JSONL row and restart-safe idempotency marker.” It is a file ledger, not an ERP. |
| Payment/review sinks are simulated | `src/ap/sinks.ts`, `src/deps.ts` | unit/workflow sink assertions | “Payment rail and specialist review remain inspectable Fakes; no bank/ERP is contacted.” |
| Human correction changes a later decision | `src/agents/autopilot-agent.ts`, `src/ap/analysis-tools.ts` | `npm run eval:corrections`, `tests/integration/learning-from-corrections.test.ts` | “A material rebill above a corrected amount flips payment→review; the corrected-amount control does not.” Not generalized online learning. |
| Injection cannot autonomously cause execution | tool separation above; untrusted-data fences in `src/ap/loop.ts` | `tests/pentest/prompt-injection.test.ts`, `tests/pentest/excessive-agency.test.ts` | “Tested direct, recalled-memory, and compromised-model attacks cannot bypass the human gate.” Do not say every possible attack is detected. |
| Recognized injection is visible | `src/qwen/injection-scan.ts`, `src/server.ts`, `src/ui.html` | `tests/security/upload-guard.test.ts` | “A documented generic pattern set is surfaced as an advisory.” Pattern-based, language/phrasing-limited, not universal. |
| Uploads are bounded and type-checked | `src/qwen/vision.ts`, `src/server.ts` | `tests/unit/vision.test.ts`, `tests/security/upload-guard.test.ts` | “Size/type/magic-byte/page/time caps run before extraction.” Magic bytes are not antivirus/content disarm. |
| Weak extraction fails toward review | `src/ap/extraction-confidence.ts`, `src/ap/normalize.ts`, `src/ap/validate.ts` | `tests/unit/workflow.test.ts`, `tests/unit/normalize.test.ts`, `tests/unit/validate.test.ts` | “Low/unknown confidence, missing date/currency, conflicts, or partial line items cannot straight-through pay.” Relevance remains advisory. |
| Production quotas survive restarts/replicas | `src/ap/rate-limit.ts`, `src/db/schema.sql` | `tests/unit/rate-limit.test.ts`, `tests/integration/pgvector-store.test.ts` | “Per-client + global daily counters update atomically in Postgres; in-memory limiter is dev/test only.” |
| HTTP and MCP share one core with asymmetric authority | `src/deps.ts`, `src/server.ts`, `src/mcp/server.ts` | `tests/unit/mcp.test.ts`, `tests/integration/mcp-transport.test.ts` | “MCP exposes exactly four proposal/read tools: intake, pending, recall, catalog. It cannot decide or execute; Bearer-authenticated HTTP/UI is exclusive for approve/amend/reject/recover.” MCP is local stdio; process access still controls state visibility, proposal creation, and model spend. |
| Quality gates are comprehensive | `package.json`, `.github/workflows/ci.yml`, `scripts/readiness.ts` | Node **240 pass / 0 fail / 6 skip**; Playwright **25/25**; pentest **30/30**; readiness **22/0/3**; audits **0** | State the exact numbers and the six real-DB skips. |
| Coverage exceeds the enforced floor | `package.json` (`c8` ≥80% in all dimensions) | **92.42% statements · 84.28% branches · 91.26% functions · 92.42% lines** | Use all four current numbers when space permits; never reuse a superseded badge. |
| Deployment uses Alibaba Cloud/Qwen | `src/qwen/client.ts`, `deploy/`, `demo/alibaba-proof.mp4` | live URL + `/health`/`/ready` after final redeploy | “Deployed on Alibaba ECS; Qwen calls use the DashScope OpenAI-compatible endpoint.” Reconfirm the final revision before recording. |

## Reproduction command set

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run test:e2e
npm run coverage
npm run test:pentest
npm run eval
npm run eval:corrections
npm run readiness
npm run test:docs
npm audit
npm audit --omit=dev
```

The public media should show representative behavior, not a wall of numbers. Put the
full matrix in the repository and use the final screen of the video for only the most
judge-relevant evidence: **22/22 offline policy eval, 2.5 average steps, 30/30
adversarial, 25/25 browser, and two post-approval real transports**.
