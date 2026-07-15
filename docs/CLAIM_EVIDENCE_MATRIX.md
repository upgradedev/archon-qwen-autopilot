# Claim → evidence matrix

**Snapshot:** 2026-07-15. Use this table as the source of truth for the README,
Devpost copy, narration, screenshots, and posts. A claim may be described more simply
in public copy, but not made stronger than the evidence below.

| Submission claim | Implementation evidence | Behavioral evidence | Approved wording / boundary |
|---|---|---|---|
| Qwen runs a bounded multi-step function-calling loop | `src/ap/loop.ts`, `src/ap/analysis-tools.ts`, `src/qwen/client.ts` | `tests/unit/loop.test.ts`, `tests/unit/workflow.test.ts`, `npm run eval` | “`qwen-plus` chooses successive read/analyze tools before one proposal.” Do not call the deterministic offline score live-Qwen accuracy. |
| Every eval scenario is genuinely multi-step | `eval/run.ts`, `eval/lib.ts`, `eval/dataset.ts` | **22/22 tool + args + autonomy; 53 total autonomous steps** | “All 22 scenarios take at least two autonomous steps; average 2.4 (53/22, rounded to one decimal).” |
| Document intake uses Qwen vision | `src/qwen/vision.ts`, `src/server.ts` | `tests/unit/vision.test.ts`, `tests/security/upload-guard.test.ts`, sample at `demo/sample-invoice.png` | “`qwen-vl-max` reads PDF/PNG/JPG on the keyed path.” Offline uses a declared deterministic extractor. No general extraction-accuracy claim. |
| Decisions use persistent vendor memory | `src/memory/store.ts`, `src/memory/embeddings.ts`, `src/ap/analysis-tools.ts` | `tests/integration/pgvector-store.test.ts`, `tests/integration/workflow-http.test.ts` | “Duplicate/anomaly checks use recalled vendor history; production uses pgvector.” Bare-clone DB cases skip visibly when no `DATABASE_URL`. |
| Nothing executes at intake | `src/agents/autopilot-agent.ts`, `src/ap/tools.ts`, `src/server.ts` | `tests/pentest/authz-hitl.test.ts`, `tests/pentest/prompt-injection.test.ts`, sink tests | “Reviewer/process-authorized intake produces at most a durable PENDING proposal; unauthenticated HTTP produces only an isolated non-durable preview. No sink fires.” |
| The model cannot approve/pay/execute | `src/ap/loop.ts`, `src/ap/tools.ts`, `src/skills/catalog.ts` | `tests/pentest/excessive-agency.test.ts`, `tests/unit/skills.test.ts` | “Execution capabilities are absent from the model-facing catalog.” This is the structural safety boundary. |
| HTTP reviewer actions are authenticated | `src/server.ts`, `src/ui.html` | `tests/unit/server.test.ts`, `tests/pentest/authz-hitl.test.ts` | “HTTP queue/reviewer APIs require a private Bearer token; production fails closed without ≥32 characters.” MCP pending reads are local-process scoped and MCP has no mutation tool. Never publish the token. |
| Approval is atomic and replay-safe | `src/ap/workitem-store.ts`, `src/agents/autopilot-agent.ts`, `src/db/schema.sql` | `tests/unit/workflow.test.ts`, `tests/integration/pgvector-store.test.ts`, `tests/pentest/authz-hitl.test.ts` | “One atomic PENDING→EXECUTING claim; concurrent/repeated decisions conflict.” |
| Approved arguments are exactly what runs | `src/agents/autopilot-agent.ts`, `src/ap/tools.ts` | `tests/pentest/authz-hitl.test.ts`, `tests/unit/smtp-sink.test.ts`, `tests/unit/ledger-sink.test.ts` | “Runtime-validated approved/amended args reach the sink; tool override needs explicit confirmation + reason.” |
| Uncertain side effects are not blindly retried | `src/agents/autopilot-agent.ts`, `src/server.ts` | recovery cases in `tests/unit/workflow.test.ts` | “A sink failure remains visible as executing until audited retry/mark-completed reconciliation.” |
| SMTP is a real configurable transport | `src/ap/smtp-sink.ts`, `src/deps.ts` | `tests/unit/smtp-sink.test.ts`, readiness `sink-smtp` | “With `SMTP_HOST`, the sink submits the approved message to the configured SMTP transport and awaits transport acceptance; recipient delivery is not claimed. Otherwise the Fake records intent and submits nothing.” Do not claim a mailbox receipt without a captured receipt. |
| The ledger is a real durable configurable transport | `src/ap/ledger-sink.ts`, `src/deps.ts` | `tests/unit/ledger-sink.test.ts`, readiness `sink-ledger` | “With `LEDGER_JSONL_PATH`, approval appends/fsyncs one balanced JSONL row and restart-safe idempotency marker.” It is a file ledger, not an ERP. |
| Payment/review sinks are simulated | `src/ap/sinks.ts`, `src/deps.ts` | unit/workflow sink assertions | “Scheduled-payment and specialist-review adapters remain inspectable Fakes; no bank/ERP is contacted.” |
| Human correction changes a later decision | `src/agents/autopilot-agent.ts`, `src/ap/analysis-tools.ts`, `src/ap/loop.ts` | `npm run eval:corrections`, `tests/integration/learning-from-corrections.test.ts`, raw-vs-final guard case in `tests/unit/loop.test.ts` | “A material rebill above a verified corrected amount flips payment proposal→review; the corrected-amount control does not.” Runtime correction recall, not model training; no weights update. A real model that ignores the evidence is deterministically guarded and its raw choice remains visible. |
| Correction persistence is verified, not assumed | `src/agents/autopilot-agent.ts`, `src/types.ts`, `src/ui.html` | correction-store failure + tool-override cases in `tests/integration/learning-from-corrections.test.ts` | “The decided item persists `correctionMemory { applicable, stored, error? }` before finalization; the UI says verified only on `stored=true`.” A completed sink cannot be rolled back when memory later fails, so that failure remains explicit. |
| Injection cannot autonomously cause execution | tool separation above; untrusted-data fences in `src/ap/loop.ts` | `tests/pentest/prompt-injection.test.ts`, `tests/pentest/excessive-agency.test.ts` | “Tested direct, recalled-memory, and compromised-model attacks cannot bypass the human gate.” Do not say every possible attack is detected. |
| Recognized injection is visible | `src/qwen/injection-scan.ts`, `src/server.ts`, `src/ui.html` | `tests/security/upload-guard.test.ts` | “A documented generic pattern set is surfaced as an advisory.” Pattern-based, language/phrasing-limited, not universal. |
| Uploads are bounded and type-checked | `src/qwen/vision.ts`, `src/server.ts` | `tests/unit/vision.test.ts`, `tests/security/upload-guard.test.ts` | “Size/type/magic-byte/page/time caps run before extraction.” Magic bytes are not antivirus/content disarm. |
| Weak extraction fails toward review | `src/ap/extraction-confidence.ts`, `src/ap/normalize.ts`, `src/ap/validate.ts` | `tests/unit/workflow.test.ts`, `tests/unit/normalize.test.ts`, `tests/unit/validate.test.ts` | “Low/unknown confidence, missing date/currency, conflicts, or partial line items cannot produce a payment proposal.” Relevance remains advisory. |
| Production workflow quotas survive restarts/replicas | `src/ap/rate-limit.ts`, `src/db/schema.sql` | `tests/unit/rate-limit.test.ts`, `tests/integration/pgvector-store.test.ts` | “Per-client + global daily workflow-entitlement counters update atomically in Postgres; in-memory limiter is dev/test only.” These count accepted workflows, not provider retries, tokens, or billing. |
| Public traffic cannot consume judge intake capacity | `src/ap/rate-limit.ts`, `src/server.ts`, `src/ui.html` | reserve isolation/exhaustion/invalid-token/document cases in `tests/unit/server.test.ts` | “A valid private reviewer credential selects a separate bounded per-credential + global daily reserve. Invalid credentials stay on public quota; neither tier is unlimited.” Maximum accepted workflows/day is bounded by the sum of both global caps; per-workflow provider use is bounded separately. |
| HTTP and MCP share one core with asymmetric authority | `src/deps.ts`, `src/server.ts`, `src/mcp/server.ts` | `tests/unit/mcp.test.ts`, `tests/integration/mcp-transport.test.ts` | “MCP exposes exactly four proposal/read tools: intake, pending, recall, catalog. It cannot decide or execute; Bearer-authenticated HTTP/UI is exclusive for approve/amend/reject/recover.” MCP is local stdio; process access still controls state visibility, proposal creation, and model spend. |
| AP evaluation is preregistered and honest | `eval/dataset.ts`, `eval/dataset.sha256`, `eval/hash.ts`, `eval/lib.ts`, `eval/run.ts` | `npm run eval -- --gate`; post-commit `npm run eval:live` | “22/22 is deterministic agreement on a tuned developer-labelled regression set, not live-Qwen accuracy.” Online artifacts keep raw model vs guarded system, errors/fallbacks in 22-case denominators, three per-run values, stability, latency, usage and protocol/commit hashes. |
| Vision evaluation is frozen and original | `eval/vision/manifest.json`, `fixtures.sha256`, `generate_fixtures.py`, `eval/vision/run.ts` | `npm run eval:vision`; post-commit `npm run eval:vision:live` | “16 original synthetic PDF/PNG/JPG fixtures verify extraction and safe-review behavior.” Not expert-labelled or representative production data; errors remain in fixed denominators. |
| Model promotion has an explicit rollback gate | `.env.example`, `src/qwen/client.ts`, `src/qwen/vision.ts`, `docs/MODEL_PROMOTION.md` | candidate request-shape tests in `tests/unit/loop.test.ts` and `tests/unit/vision.test.ts`; frozen side-by-side artifacts after commit | “`qwen3.7-plus-2026-05-26` is evaluated side by side; defaults stay `qwen-plus`/`qwen-vl-max` until every gate passes.” No silent substitution. |
| Workflow impact panel is measured instrumentation | `src/server.ts`, `src/types.ts`, `src/ui.html` | telemetry and legacy-compatibility cases in `tests/unit/server.test.ts` | “`/impact-metrics` reports retained-work-item proposal latency, steps, catches and human touches.” No labor-saving, ROI or human error-reduction study. |
| Quality gates are comprehensive | `package.json`, `.github/workflows/ci.yml`, `scripts/readiness.ts` | Run the reproduction set below and record the final clean-tree totals | State the exact final outputs only after the last full run; identify real-DB skips. |
| Coverage exceeds the enforced floor | `package.json` (`c8` ≥80% in all dimensions) | `npm run coverage` | Use the four final percentages from the last clean-tree run; never reuse a superseded badge. |
| Deployment uses Alibaba Cloud/Qwen | `src/qwen/client.ts`, `deploy/`, expected final `demo/final-media/autopilot-alibaba-proof.png` + nine-beat `demo/final-media/autopilot-demo.mp4` | live URL + `/health` + `/ready` + authenticated `/ready/deep` + `npm run smoke:submission` after final redeploy | “Deployed on Alibaba ECS; Qwen calls use the DashScope OpenAI-compatible endpoint.” Reconfirm the final revision and capture app-specific proof without credentials or administrative identifiers. |
| Built during the submission period | repository history | first commit `8a6359f`, 2026-07-04 | “Materially built during the eligibility window, after the 2026-05-26 start.” |

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
judge-relevant, freshly rerun evidence: **22/22 tuned offline policy agreement**, the
measured average read/analyze steps, final adversarial/browser totals, the frozen
16-document vision protocol, and two configurable post-approval real transports.
