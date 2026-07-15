# Security policy and trust boundaries

Archon Autopilot processes untrusted invoice content next to money-adjacent
workflows. Its primary security property is deliberately narrow and testable:
**Qwen may gather evidence and propose an action, but it cannot approve, pay, or
execute one.** A reviewer-authenticated server path owns every consequential
decision.

This document describes the implemented controls and their limits. It is not a
security certification, a claim of universal prompt-injection detection, or a claim
that the demo is ready to control a real bank or ERP.

## Trust boundaries

| Surface | Trust level | Authority |
|---|---|---|
| Public HTTP document/JSON intake | Untrusted and rate-limited | Isolated, redacted, non-durable preview only |
| Reviewer HTTP/UI | Private Bearer credential | Durable intake, queue/history reads, approve/amend/reject/recover |
| Qwen decision catalog | Model-controlled output | Five read/analyze skills and four terminal **proposals**; no decision or execution verb |
| Local MCP stdio process | Operator-controlled process boundary | Four proposal/read tools; no approve/amend/reject/recover/pay/execute tool |
| PostgreSQL runtime role | Least-privilege application principal | DML in the isolated `autopilot` database; no migration/admin authority and no Memory database connection |
| SMTP / JSONL sinks | Consequential only after the gate | Configurable transport submission or durable ledger append; payment/review adapters remain simulated |

## Enforced invariants

- Intake never fires a sink. Reviewer-authenticated intake can create at most one
  durable `PENDING` proposal; unauthenticated intake uses isolated in-memory state.
- The model-facing catalog excludes `approve`, `amend`, `reject`, `recover`, `pay`,
  and sink execution. Prompt text cannot add a missing server capability.
- A human decision atomically claims `PENDING → EXECUTING`. Concurrent or repeated
  decisions conflict instead of replaying the effect.
- Runtime schema validation occurs after amendment and before the sink. The audited
  approved arguments are the arguments passed to the selected sink.
- Ambiguous post-claim failures remain visible for explicit reconciliation; the
  service does not blindly retry an uncertain external effect.
- Default production dependency resolution fails closed without PostgreSQL, real
  Qwen configuration, and a reviewer token of at least 32 characters. Explicit
  `ALLOW_FAKE_QWEN` / `ALLOW_IN_MEMORY_STORE` opt-ins exist only for declared
  ephemeral demonstrations; the authoritative submission deploy does not enable
  them and independently requires the real dependencies.

## Threats, controls, and honest limits

| Threat | Implemented control | Limit that remains |
|---|---|---|
| Prompt injection in invoice text or recalled memory | Untrusted-data fences, advisory pattern surfacing, model catalog without execution, authenticated human gate | The scanner is pattern- and language-limited; a novel phrase can influence a proposal |
| Excessive model agency | Server-owned catalog and single execution chokepoint | A reviewer can still authorize a bad proposal and must inspect the evidence |
| Unauthorized reviewer action | Constant-time Bearer verification, production token-strength check, protected queue/decision routes | The shared judging token is a bearer secret; possession grants reviewer authority |
| Replay or concurrent approval | Atomic database claim, terminal state conflicts, durable JSONL ref marker | SMTP recipient delivery cannot be made exactly-once by the application |
| Public quota exhaustion | Persistent per-client/global public limits plus a separate bounded reviewer reserve | Limits count accepted workflows, not provider billing units; a fleet deployment needs a shared edge policy |
| Malicious upload | Size/type/magic-byte/page/time caps and bounded PDF rasterization | Magic bytes are not antivirus or content disarm; complex documents can be misread |
| Vision source ambiguity | Low/missing extraction confidence and a payable total inferred because it was unreadable deterministically replace any money proposal with review | Confidence is model-reported, not calibrated; the reviewer must compare the extracted fields with the source image |
| Sensitive-data leakage | Redacted public preview, protected evidence reads, generic errors with request IDs, secret scanning | Operators must still keep tokens, `.env`, cloud identity, and real vendor data out of media/logs |
| Cross-application database access | Dedicated database/principal and release-time denial check | The physical PostgreSQL service is shared and still requires host-level protection |
| MCP misuse | Local stdio only and four narrow tools | Anyone who can spawn the process may read state, create proposals, and consume configured model capacity |

## Credentials and production handling

- Never commit `.env`, `.env.migration`, API keys, reviewer tokens, SMTP secrets,
  database passwords, cloud instance IDs, or administrative principal identifiers.
- Put the reviewer credential only in Devpost's private testing instructions. Never
  place it in a URL, query string, screenshot, recording, post, issue, or CI log.
- The UI keeps the reviewer token in tab-scoped `sessionStorage`; use a clean judging
  profile and close the tab after testing.
- Public traffic terminates at HTTPS. The backend binds to host loopback; TCP 9100
  and PostgreSQL must not be opened publicly.
- Runtime and migration credentials remain separate. The bootstrap/admin DSN is used
  only by the one-shot migration path and is not passed to the serving container.
- Rotate any secret immediately if it appears in a terminal capture, browser
  recording, CI output, or public artifact. Removing a file is not sufficient once a
  secret has been exposed.

## AI and data-safety boundary

Model rationale and confidence are model-supplied review aids, not hidden
chain-of-thought and not calibrated probabilities. Qwen output is narrowed to typed
schemas and deterministic guards can force review, but those controls do not make
the extracted data factually correct. Use synthetic data for judging. Do not upload
real invoices containing personal, banking, tax, or confidential vendor data to the
public demo.

## Verification

The security behavior is exercised by:

```bash
npm run test:pentest
npm run test:unit
npm run test:docs
npm run coverage
npm run readiness
npm audit
npm audit --omit=dev
```

The final claim boundaries and exact implementation/test references are in
[`docs/CLAIM_EVIDENCE_MATRIX.md`](docs/CLAIM_EVIDENCE_MATRIX.md). Deployment controls
and the release proof procedure are in
[`deploy/DEPLOY_STATE.md`](deploy/DEPLOY_STATE.md) and
[`demo/BUILD_RECORDING.md`](demo/BUILD_RECORDING.md).

## Reporting a vulnerability

Do not open a public issue containing an exploit, credential, real invoice, or live
customer data. Use GitHub private vulnerability reporting if it is enabled for the
repository; otherwise contact the entrant privately through the hackathon/Devpost
channel. Include the affected commit, route or component, minimal reproduction,
impact, and whether any secret or real data may have been exposed.
