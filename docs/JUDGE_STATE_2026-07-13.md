# Judge state — final engineering refresh, 2026-07-15

> The filename preserves the original 2026-07-13 review artifact; this content is the
> refreshed final engineering state. It deliberately separates automated evidence,
> live/configurable capabilities, and human publication work.

## Challenge target

| Item | State |
|---|---|
| Challenge | Alibaba Cloud / Qwen Hackathon — **Track 4 (Autopilot Agent)** |
| Deadline | **2026-07-20, 2:00 PM PDT** |
| Rubric | Innovation & AI Creativity **30%** · Technical Depth & Engineering **30%** · Problem Value & Impact **25%** · Presentation **15%** |
| Submission essentials | Public repository + license, description, Alibaba deployment proof, architecture diagram, public hosted video under three minutes, selected track |
| Optional lift | Published technical blog or social post |

## Verified engineering state

| Evidence | Verified result |
|---|---:|
| Node + real-pgvector suites | Exact pass/fail/skip totals come from the final immutable CI run |
| Browser end to end | Exact Playwright total comes from the final immutable CI run |
| Coverage | CI enforces ≥80% statements, branches, functions, and lines; quote final measured values from CI |
| Decision eval | **22/22 tool choice · 22/22 argument sanity · 22/22 autonomy**, average **2.4** autonomous steps (53/22, rounded) |
| Readiness | Machine-gated at ≥95% automatable completion with zero failed automatable checks; publication items remain user-gated |
| Adversarial suite | Exact total comes from the final immutable CI run |
| Dependency audits | Final result comes from the submitted commit's audit job |

Real-Postgres integration cases skip explicitly, never silently, when a local
`DATABASE_URL` is absent. CI supplies PostgreSQL/pgvector and executes that tier.

## Rubric view

| Criterion | Evidence-backed final assessment |
|---|---|
| **Innovation & AI Creativity (30%)** | Strong. A bounded `qwen-plus` function-calling loop gathers vendor-memory and validation evidence before one proposal. The human gate is also a measured correction signal. Prompt-injection safety is structural: the model catalog contains no approval/execution capability. |
| **Technical Depth & Engineering (30%)** | Strong. Authenticated HTTP/UI is the exclusive decision surface, while a four-tool MCP proposal/read surface shares the injectable intake/memory core without exposing decisions; `qwen-vl-max` handles document intake; pgvector grounds decisions; atomic work-item claims, explicit uncertain-outcome recovery, persistent production quotas, strict auth, two configurable real transports, and the verified quality gates above materially exceed a thin hackathon wrapper. |
| **Problem Value & Impact (25%)** | Strong and bounded. In an authored 12-case synthetic workflow model, the assisted arm uses fewer modeled base active-review seconds and human checkpoints while both arms match the developer policy labels; this is not a field study, labor-savings result, or ROI claim. SMTP vendor replies and a durable JSONL double-entry ledger are real when configured; payment and specialist-review adapters remain simulated, so no bank/ERP integration is implied. |
| **Presentation (15%)** | Engineering artifacts are ready: README, architecture, evidence matrix, judge guide, Devpost copy, project story, blog draft, and media plan. The score on this axis still depends on the human-owned final screenshots, refreshed <3-minute recording, public video host, and published post. |

## Security and reliability invariants now closed

- HTTP reviewer queue reads and mutations require a private Bearer credential;
  production refuses to start without a sufficiently long token. Intake remains public for judge
  access but is bounded by persistent per-client and global quotas.
- A model can analyze and propose but cannot approve, amend, reject, pay, or execute.
  The only side-effect path is an authenticated human decision followed by an atomic
  `PENDING → EXECUTING` claim.
- Approved tool arguments are schema-validated. A tool change requires explicit
  confirmation and a reason, and the proposed→approved diff is retained.
- Concurrent approvals and replay are rejected. Uncertain sink failures stay visibly
  executing for audited reconciliation; there is no unsafe automatic retry.
- The JSONL ledger fsyncs the row and a per-work-item idempotency marker, and dedupes
  a completed ref after restart. SMTP uses a stable application `Message-ID`, while
  honestly not claiming recipient-level exactly-once semantics.
- Unknown/conflicting currency, missing or invalid dates, incomplete line items,
  low/unknown Qwen-VL extraction confidence, and a payable total inferred because it
  was unreadable in the document fail toward human review instead of a payment proposal.
- Uploaded PDF/PNG/JPG files are bounded and magic-byte checked; PDF pages and model
  calls have caps/timeouts. Recognized injection patterns and non-invoice relevance
  are surfaced to the reviewer.

## Claims that remain intentionally bounded

- The **22/22 offline eval** is a deterministic policy/regression measurement over the
  real loop. It is not presented as live-model accuracy. Keyed Qwen traces are separate.
- The advisory injection scanner recognizes a documented generic pattern set; it is
  not a universal detector. The safety invariant rests on tool separation + human
  authorization, not scanner recall.
- Vision extraction is limited to PDF/PNG/JPG, 10 MiB by default; PDFs above three
  pages are rejected as a whole by default. Magic-byte sniffing is not antivirus/content disarm, relevance
  is advisory, and there is no claim of benchmarked accuracy on arbitrary complex
  multi-page tables.
- The MCP server is local stdio and exposes only intake/list-pending/recall/catalog
  operations. It can create proposals but cannot approve, amend, reject, recover, or
  execute. Authenticated HTTP/UI is the exclusive reviewer boundary.
- SMTP and JSONL are real **configurable** transports with real implementation tests.
  A delivered mailbox receipt and live persistent-volume proof must be shown only if
  they are actually captured; the docs do not fabricate either.

## Only human media/publication work remains

1. Capture fresh screenshots without exposing the reviewer token.
2. Capture the five sanitized live proof images and build the fail-closed **nine-beat**
   judge-first video; verify runtime remains below three minutes and host it publicly.
3. Publish one supplied blog/social draft and save the public URL.
4. Paste the supplied Devpost description, architecture, repository, Alibaba proof,
   public video URL, track, and private reviewer credential into the correct fields;
   test every public link in an incognito window before submission.

The exact shot list is [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md),
and operator handling is [`../demo/POST_PUBLICATION_CHECKLIST.md`](../demo/POST_PUBLICATION_CHECKLIST.md);
copy only a fenced public draft from [`../demo/POST_DRAFTS.md`](../demo/POST_DRAFTS.md).
