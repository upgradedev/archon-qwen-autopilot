# Load tier — k6

The **load / performance tier** of the Archon Autopilot testing pyramid
(unit → integration → e2e → **load**). It drives the live HTTP service under
ramping concurrency and holds per-endpoint latency + error-rate SLOs.

`load/workflow-load.js` targets the **main workflow endpoint** `POST /intake`
(the human-gated AP loop — normalize → recall → validate → Qwen-decide → a
**PENDING** proposal) mixed with two cheap reads, `GET /health` and
`GET /pending`. Nothing executes at intake — it only proposes — so the load run
never moves money and never fires a side-effect.

## Run

```bash
# Smoke (1 VU, ~30s) against a local server on :9000
K6_REVIEWER_TOKEN="$REVIEWER_TOKEN" npm run load

# Point at any base URL
BASE_URL=http://host:9000 K6_REVIEWER_TOKEN="$REVIEWER_TOKEN" npm run load

# Add the ramping-vus scenario (0 → 20 → 50 → 0)
K6_REVIEWER_TOKEN="$REVIEWER_TOKEN" RUN_RAMP=true npm run load

# Raise the share of iterations that POST /intake (default 0.3)
K6_REVIEWER_TOKEN="$REVIEWER_TOKEN" INTAKE_RATIO=0.5 RUN_RAMP=true npm run load
```

Requires the [k6](https://k6.io) binary on `PATH` (a single native binary — **not**
an npm dependency) and `K6_REVIEWER_TOKEN`. The token is sent only in the
Authorization header; it is never written to the summary.

### Recommended: run against the OFFLINE server

Boot the server with no `DASHSCOPE_API_KEY` (→ the deterministic Fakes) so every
`/intake` stays offline and invokes no model provider. Raise all four
workflow-admission caps
and the three coarse HTTP caps within their finite code bounds so the loop is
actually exercised under load rather than measuring the abuse controls:

```bash
export REVIEWER_TOKEN="local_load_only_reviewer_token_at_least_32_chars"
DASHSCOPE_API_KEY= DATABASE_URL= \
UPLOAD_DAILY_LIMIT=1000000 UPLOAD_GLOBAL_DAILY_LIMIT=1000000 \
REVIEWER_UPLOAD_DAILY_LIMIT=1000000 REVIEWER_UPLOAD_GLOBAL_DAILY_LIMIT=1000000 \
HTTP_REQUESTS_PER_MINUTE=10000 REVIEWER_HTTP_REQUESTS_PER_MINUTE=20000 \
HTTP_GLOBAL_REQUESTS_PER_MINUTE=100000 PORT=9000 npm start &
BASE_URL=http://localhost:9000 K6_REVIEWER_TOKEN="$REVIEWER_TOKEN" \
REQUIRE_INTAKE_ACCEPTED=true RUN_RAMP=true npm run load
```

## The daily rate limiter is expected under load

`POST /intake` is capped per UTC day (`DailyRateLimiter`, default **20/day**).
Under concurrency that cap is reached almost immediately, so a **`429` is a
correct, expected response — not a failure.** The script treats `200` (a queued
PENDING proposal) and `429` (the cap) as the two valid outcomes and tracks them
separately (`intake_accepted` / `intake_rate_limited`); only a `5xx` or an
unexpected status fails the `intake_valid_response` threshold. Pointing
`BASE_URL` at the capped public demo will therefore show many `429`s by design —
raise `UPLOAD_DAILY_LIMIT` on the target to load the loop itself.

## SLOs (thresholds)

| Metric | Threshold |
|---|---|
| `http_req_duration{endpoint:health}` | p95 < 500 ms, p99 < 800 ms |
| `http_req_duration{endpoint:pending}` | p95 < 800 ms, p99 < 1200 ms |
| `http_req_duration{endpoint:intake}` | p95 < 2500 ms, p99 < 4000 ms |
| `checks` | > 99% pass |
| `intake_valid_response` | > 99% are `200` or `429` (never `5xx`) |
| `intake_accepted` in isolated hosted mode | > 99% are `200/PENDING` |
| `http_req_failed` in isolated hosted mode | < 1% |

## CI

This is a **manual, opt-in** target — deliberately **not** part of the push/PR
gate (it needs the k6 binary and a running server). It runs only via
`.github/workflows/load-test.yml` (`workflow_dispatch`), which boots the offline
server with bounded test-only caps and runs the smoke + ramp against it. It sets
`REQUIRE_INTAKE_ACCEPTED=true`, so a run that merely reaches a `429` guard fails
instead of masquerading as workflow-capacity evidence. The workflow uploads
`.artifacts/load-test/load-summary.json` as an artifact. The summary formatter is
repository-local; the load run executes no remote JavaScript modules. For an
external `base_url`, configure the repository secret `LOAD_TEST_REVIEWER_TOKEN`;
the workflow fails closed when that credential is absent or invalid.

The latest immutable hosted result and its precise claim boundary are recorded in
[`RESULTS_2026-07-15.md`](RESULTS_2026-07-15.md).
