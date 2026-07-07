# Archon Autopilot — a human-gated accounts-payable agent (Qwen · Track 4)

Archon Autopilot is a **human-gated accounts-payable (AP) agent**. For each
incoming vendor invoice it runs a **bounded multi-step ReAct loop** over **Qwen
function-calling**: the agent autonomously **recalls the vendor's history**,
**validates**, **checks for a duplicate**, and **computes the amount variance** —
each a read/analyze step with no side-effect — and only then proposes **one**
terminal AP action. **Nothing executes until a human approves the exact arguments**
(the human-in-the-loop gate). It runs the AP workflow from a messy incoming invoice
to a *proposed* action automatically, then stops and waits for a person. It
recommends; it never auto-executes.

> **Scope, stated honestly.** The decision engine is a **genuine bounded ReAct
> loop** (observe → decide → act → observe): the read/analyze tools and the
> memory grounding are **real**. The terminal execution **sinks are simulated
> in-memory adapters** (ledger / payment-rail / SMTP) behind real interfaces — no
> ERP, bank, or mail server is contacted. **Live Qwen is wired** (real `qwen-plus`
> function-calling + `text-embedding-v4`); the whole loop is **verified offline via
> deterministic Fakes** so it runs in CI with no key. Decision quality is
> **measured** — see [Decision-quality eval](#decision-quality-eval) and
> [`EVAL.md`](EVAL.md).

It is the **Track-4 (Autopilot Agent)** entry for the Global AI Hackathon Series
with Qwen Cloud, and it is the **top layer on top of our Track-1 [Archon
MemoryAgent](../qwen-memoryagent)**: the autopilot uses a persistent, queryable
**pgvector memory** as its foundation, so every decision is grounded in what the
agent has learned about a vendor across sessions, and every executed outcome is
written back so the agent gets smarter over time.

> **Positioning:** universal financial-intelligence terms only. `tax` / `tax_id`
> are generic accounting fields, not tied to any national scheme or authority.

---

## The AP workflow (a bounded multi-step ReAct loop)

1. **Intake** — `POST /intake` with an incoming vendor invoice (structured JSON,
   but fields may be missing, mistyped, or ambiguous — real emails/PDFs are messy).
   The invoice is normalized (alias keys, string amounts, EU number formats,
   inferred totals), recording every coercion.
2. **Observe → decide → act → observe (the loop)** — `qwen-plus` is given the
   invoice + every observation gathered so far + the tool catalog, and repeatedly
   chooses the **next tool**. The **autonomous read/analyze tools** run *inside* the
   loop with **no side-effect**, so the agent genuinely reasons over several
   observations before it acts (e.g. recall history → see the prior amount → compute
   the variance → conclude it is anomalous → flag it). It always recalls the
   **MemoryAgent** foundation for this vendor and validates before deciding.
3. **Terminal action → PENDING** — once the model has enough evidence it chooses
   exactly **one terminal, side-effecting action**. The loop **stops** and persists
   the proposal **plus the full step trace** as a **PENDING** work item. Nothing
   executes. Loop guards (a max-steps cap + no-progress detection) fall back to a
   safe `flag_for_review` if it cannot reach a confident action, logging why.
4. **Human-in-the-loop checkpoint** — a human approves, amends, or rejects the
   proposal. This "recommend, never auto-execute" gate is the core Track-4 story;
   the `/pending` payload and the approval UI show the **whole reasoning trace**, so
   a person sees *how* the agent decided, not just the final action.
5. **Execute + remember** — on approval the chosen tool runs for real (simulated
   adapters that post the journal entry / record the payment / "send" the vendor
   reply / raise a review) and the outcome is **written back to memory**.

### Two tool tiers — this is what makes the loop both multi-step AND safe

**Autonomous read/analyze tools — execute INSIDE the loop, no human gate** (no
external side-effect, so the agent can chain several of them):

| Tool | What it does | Rule |
|---|---|---|
| `recall_vendor_history` | pgvector recall of the vendor's prior invoices; surfaces raw **facts** (prior refs, amounts, dates, the amount ratio) — it decides nothing | — |
| `validate_invoice` | structural cross-checks: amount sanity, required fields, tax reconciliation, line-item integrity | **R1–R4** |
| `check_duplicate` | the memory-grounded duplicate finding (needs recall first) | **R5** |
| `compute_variance_vs_history` | the memory-grounded amount-anomaly finding (needs recall first) | **R6** |
| `request_more_context` | record that more information is needed | — |

**Terminal, side-effecting actions — HUMAN-GATED** (choosing one STOPS the loop and
persists a PENDING proposal; nothing runs until a human approves):

| Tool | When the model picks it | Executed side-effect (simulated adapter) |
|---|---|---|
| `draft_journal_entry` | Clean, validated invoice from a **new** vendor | Posts a balanced debit-expense / credit-AP entry to the ledger |
| `draft_payment` | Clean invoice from a **known, recurring** vendor, amount in range | Records a scheduled payment on the payment rail |
| `draft_vendor_reply` | Required fields missing or the invoice does not reconcile | "Sends" a clarification request to the vendor (Fake email sink) |
| `flag_for_review` | Confirmed **duplicate** or **anomalous amount** | Escalates the invoice to a human specialist |

Each tool is a real OpenAI-compatible **function schema** handed to Qwen. On the
terminal action the model self-reports a `reasoning` and a `confidence`; the loop
lifts those out of the tool arguments so the **domain args a human approves are
exactly the args that execute** (the HITL integrity guarantee). The R1–R6 rule set
is split across the analyze tools by data dependency: R1–R4 need no memory, while
R5/R6 need the history `recall_vendor_history` fetches first.

Both tiers are formalized as a first-class, introspectable **custom-skills catalog**
— see [MCP integration & custom skills](#mcp-integration--custom-skills).

---

## Architecture

```mermaid
flowchart TD
    C[Incoming vendor invoice<br/>possibly messy / ambiguous]

    subgraph SURF [Two client surfaces · ONE injectable agent]
      direction LR
      HTTP[HTTP + Approval UI<br/>POST /intake · GET /pending<br/>/approve · /amend · /reject · /skills]
      MCP[MCP server · stdio<br/>intake_invoice · list_pending<br/>approve · amend · reject<br/>recall_vendor · list_skills]
    end

    C --> HTTP
    C --> MCP
    HTTP -->|intake| N[Normalize + Extract]
    MCP -->|intake| N

    subgraph LOOP [Bounded multi-step ReAct loop · qwen-plus function-calling]
      direction TB
      D{{Qwen picks the<br/>next tool}}
      D -->|autonomous read/analyze<br/>NO side-effect| T[recall_vendor_history ·<br/>validate_invoice · check_duplicate ·<br/>compute_variance_vs_history]
      T -->|append observation to the trace| D
      D -->|guard: max-steps / no-progress| G[fallback → flag_for_review]
    end

    N --> D
    D -->|TERMINAL action + args + reasoning + confidence<br/>+ full step trace| P[(PENDING work item<br/>approval queue)]
    G --> P

    subgraph HITL [Human-in-the-loop approval gate · same over HTTP + MCP]
      P -->|list_pending · GET /pending<br/>incl. the reasoning trace| Q[Approval queue]
      Q -->|approve · POST /approve/:id| A[Approve]
      Q -->|amend · POST /amend/:id| M[Amend then approve]
      Q -->|reject · POST /reject/:id| X[Reject - discard]
    end

    A --> E[Execute tool for real<br/>simulated adapter]
    M --> E
    E --> W[Write outcome back to memory]
    X --> W

    T -. cosine recall .-> MEM[(pgvector memory<br/>agent_memory)]
    W -. remember .-> MEM
    D -. qwen-plus .-> QWEN[Alibaba Cloud Model Studio / DashScope]
    T -. text-embedding-v4 .-> QWEN

    style SURF fill:#f3e8ff,stroke:#8250df
    style LOOP fill:#eef7ee,stroke:#2ea043
    style HITL fill:#fff3cd,stroke:#d39e00
    style MEM fill:#d1ecf1,stroke:#0c5460
    style QWEN fill:#e2e3f3,stroke:#383d7c
```

**Stack (consistent with Track 1):** TypeScript · Node ≥20 (ESM) · Fastify 5 ·
the `openai` SDK against Alibaba Cloud Model Studio / DashScope (`qwen-plus` for
reasoning + **function-calling**, `text-embedding-v4` for memory) · `pg` +
pgvector for persistent memory and the approval queue.

---

## Track-4 pillars it hits

- **Ambiguous input** — invoices arrive messy; `normalize.ts` coerces alias keys,
  string amounts (`"€ 2.500,00"`), bad dates, and missing fields into a clean
  record, recording every inference; validation flags what it cannot fix.
- **Tool-use (multi-step agentic loop)** — a real function-calling tool set across
  two tiers; `qwen-plus` runs a bounded ReAct loop, chaining autonomous read/analyze
  tools (recall → validate → check_duplicate / compute_variance) before choosing one
  terminal action. The **same** `tool_calls`-parsing code path runs online (real
  Qwen) and offline (a canned `FakeQwenChatClient` that scripts a genuine multi-step
  trajectory at the client seam), so the integration is genuinely exercised in CI.
- **Human-in-the-loop** — nothing executes during the loop (the autonomous tools
  never touch a side-effect sink) or at intake. Proposals wait in a durable approval
  queue *with their full reasoning trace*; approve / amend / reject are explicit
  human acts, and the amended args are exactly what runs.
- **Production-readiness** — injectable dependencies, an offline-first design
  (zero credentials, zero spend in CI), the full testing pyramid, gitleaks +
  dep-audit in CI, swagger docs, a Dockerfile + compose, and a deploy note for
  Alibaba Cloud ECS / Function Compute + ApsaraDB RDS for PostgreSQL (pgvector).

---

## How it layers on the Track-1 MemoryAgent

The Track-1 [Archon MemoryAgent](../qwen-memoryagent) is a persistent, queryable,
cross-session memory built on Qwen + pgvector. Archon Autopilot **reuses that
foundation directly**: the same `Embedder` seam (real `text-embedding-v4` vs. an
offline `FakeEmbedder`), the same pgvector `MemoryStore` pattern (real vs.
in-memory), and the same "auto-select real Qwen vs. deterministic Fakes by
environment" design. Where the MemoryAgent *answers questions* from memory, the
Autopilot *acts* on memory: it recalls a vendor's history to ground a decision,
then remembers the outcome so the next invoice is judged with more context. Track
1 is the memory; Track 4 is the human-gated agent that reasons over it and acts
only once a person approves.

---

## Quickstart

```bash
npm install

# 1) Fully offline — no key, no database. Drives four invoices through the whole
#    loop (journal entry, payment, vendor reply, flagged duplicate).
npm run demo

# 2) The test suite (unit + the offline HTTP integration slice). Green on a bare
#    clone; the pgvector DB tests skip automatically when DATABASE_URL is unset.
npm test

# 3) Run the API (offline Fakes when DASHSCOPE_API_KEY is unset; in-memory stores
#    when DATABASE_URL is unset). Swagger UI at http://localhost:9000/docs
npm start
```

With a database + real Qwen:

```bash
cp .env.example .env         # set DASHSCOPE_API_KEY + DATABASE_URL
docker compose up -d db      # a local pgvector container
npm run db:schema            # create agent_memory + ap_workitems
npm start
```

Drive the loop by hand:

```bash
# Intake a messy invoice → a PENDING proposal (nothing executes)
curl -s -X POST localhost:9000/intake -H 'content-type: application/json' \
  -d '{"invoice":{"supplier":"Contoso Ltd","amount":"€ 1.200,00","invoice_number":"CO-42","tax_id":"TX-1","subtotal":1000,"tax":200,"total":1200}}'

curl -s localhost:9000/pending                 # the approval queue
curl -s -X POST localhost:9000/approve/<id>    # execute for real
```

---

## Live

**Archon Autopilot is deployed and live on Alibaba Cloud**, over HTTPS:

- **Approval UI:** **https://autopilot.43.106.13.19.sslip.io/** — the browser
  approval queue (review each Qwen-proposed action + its reasoning + arguments, then
  approve / amend / reject). Also at `/ui`.
- **Health:** https://autopilot.43.106.13.19.sslip.io/health
- **API docs:** https://autopilot.43.106.13.19.sslip.io/docs

It runs on the **same Alibaba Cloud ECS box** as the Track-1 MemoryAgent, **reusing
that box's pgvector** in its own isolated `autopilot` database. The backend container
listens on `9000` and is published to host port `9100`; a TLS-terminating reverse
proxy in front maps the `sslip.io` hostname to the box and serves it over HTTPS
(`sslip.io` resolves `autopilot.43.106.13.19.sslip.io` → `43.106.13.19`, so a real
certificate can be issued for the host).

Reproduce / redeploy it with one command on the box — [`deploy/redeploy.sh`](deploy/redeploy.sh)
is idempotent, schema-first, fail-closed, and runs a health + intake/pending smoke:

```bash
ssh -i <key.pem> root@43.106.13.19
cd /root/autopilot && git pull
bash deploy/redeploy.sh
```

It joins the MemoryAgent's docker network, reuses its pgvector container in a
separate `autopilot` database, builds + serves the backend (container `9000` → host
`9100`), and proves the round-trip. Full runbook, the reuse-pgvector decision, and the
one security-group rule are in [`deploy/DEPLOY_STATE.md`](deploy/DEPLOY_STATE.md).

---

## The approval UI

`GET /` (and `/ui`) serves a single, dependency-free static HTML+JS page from the
**same Fastify backend** — no framework, no build step, no CDN. It offers:

- **Upload + real-time process view** — upload a `.json` invoice (or paste one) and
  click **Process**. The page opens `POST /intake/stream` and renders **each reasoning
  step live as it arrives** (recall → validate → check duplicate → variance), each
  fading in, under a "processing…" header — then shows the proposed action. The
  agent's work is visible *as it happens*, not just the final answer.
- **Pending queue** — for each proposal: the vendor, amount, the Qwen-proposed tool +
  reasoning + confidence, a **collapsible** "How the agent decided" reasoning trace
  (click the chevron to expand — the queue stays compact by default), the editable
  action arguments, the validation findings, and the recalled vendor history. Each
  item wires **Approve** (`POST /approve/:id`), **Amend & approve** (edit the
  arguments inline → `POST /amend/:id`), and **Reject** (`POST /reject/:id`).
- **Decided tab** — answers "I approved one, where did it go?": a list from
  `GET /decided` of every approved / amended / rejected item with its outcome and
  timestamp. An amended item shows the **prev → new args diff** (the amend audit
  trail).
- **Charts** — two inline-SVG bar charts: pending **clean vs flagged** (clean = every
  validation rule passed), and decided **approved / amended / rejected**.

A success toast and an automatic refresh follow each action. It is same-origin, so it
needs no configuration.

---

## Endpoints

| Method + path | Purpose |
|---|---|
| `GET /` · `GET /ui` | The human approval UI (static page served by this backend): upload/paste an invoice, watch it process live, work the queue, and review the decided history + charts. |
| `GET /health` | Liveness + the live embedder / decision-model ids. No DB, no key. |
| `POST /intake` | Ingest a vendor invoice → normalize → run the multi-step ReAct loop (recall → validate → check duplicate / compute variance) → a **PENDING** proposed action + its full step trace. Nothing executes. **Rate-limited (see below).** |
| `POST /intake/stream` | Same pipeline as `/intake`, but **streams each reasoning step live** as Server-Sent Events (`event: step` as it happens, then `event: proposal` + `event: done`). Backs the UI's real-time "watch the agent work" upload view. Nothing executes. **Rate-limited.** |
| `POST /intake/document` | Upload a **REAL invoice document** (PDF / PNG / JPG, `multipart/form-data`, field `file`) → **Qwen-VL vision extraction** (`qwen-vl-max`) → the same multi-step loop, **streamed** (`event: extracting` → `event: extracted` → `event: step` → `event: proposal` → `event: done`). A PDF is rasterized to page images with poppler (`pdftoppm`); a PNG/JPG passes through. Nothing executes. **Rate-limited** (shares the same daily budget). |
| `GET /sample-document` | The bundled sample invoice ([`demo/sample-invoice.png`](demo/sample-invoice.png)) — a real image the UI's **"Use sample document"** button uploads so the whole vision path is one-click reproducible. |
| `GET /pending` | The human approval queue (proposals awaiting a decision), each including its reasoning trace. |
| `GET /decided` | The **decided history** — every approved / amended / rejected item, newest first, with its outcome, decision timestamp, and (for an amended item) the prev → new amend audit trail. Read-only: decided items never re-execute. |
| `POST /approve/:id` | A human approves → the chosen tool executes for real; the outcome is written back to memory. |
| `POST /amend/:id` | A human edits the proposed domain args, then approves → the **amended** args are exactly what execute. Body: `{ args, reason? }`. |
| `POST /reject/:id` | A human discards the proposal → nothing executes. The rejection is remembered. Body: `{ reason? }`. |
| `GET /skills` | The **custom Qwen skill catalog** — every function schema the decider chooses from, annotated with tier / gate / rule (mirrors the MCP `list_skills` tool). |
| `GET /docs` · `GET /openapi.json` | Interactive Swagger UI + the raw OpenAPI 3 spec. |

**Approval-gate semantics:** an unknown work-item id → `404`; an already-decided
item (approved/rejected) → `409` (it can never be re-executed).

### Open demo + upload rate limit

The live demo is **intentionally open — no login, no auth**, so a judge can test it
freely (upload an invoice, watch it process, approve/amend/reject). This is a
deliberate, rules-compliant choice: the app must be judge-testable end to end. There
is no sign-in wall by design.

To keep an open, unauthenticated endpoint from running up the model bill, **invoice
uploads are rate-limited to 10/day** (per UTC day, resetting at 00:00 UTC) across
`POST /intake`, `POST /intake/stream`, **and `POST /intake/document`** (the three
share one budget). **Upload is rate-limited to 10/day to
protect the Qwen API budget.** The limiter lives in
[`src/ap/rate-limit.ts`](src/ap/rate-limit.ts) (`DailyRateLimiter`, cap configurable
via `UPLOAD_DAILY_LIMIT`); it is checked **after** payload/file validation, so an
invalid request or an unsupported/oversize document never burns budget, and an
over-limit upload returns `429` with a clear message. Validation, the approval gate, and every read endpoint (`/pending`,
`/decided`, `/skills`, `/health`) are **not** limited.

### Real document upload → Qwen-VL vision extraction

A judge (or a real user) uploads an **actual invoice file**, not JSON. The pipeline
lives in [`src/qwen/vision.ts`](src/qwen/vision.ts) and slots in **before** the
existing normalizer + loop — nothing about the decision path changes, only the input
source is new:

1. **PDF → page images.** A PDF is rasterized to PNG(s) with **poppler's `pdftoppm`**
   (150 dpi, first `MAX_PDF_PAGES` pages). poppler is a rock-solid, self-contained
   system binary — chosen over a native-canvas npm dependency so `npm ci` / `npm
   audit` stay clean and the build is reproducible; it is installed in the Docker
   image via `apt-get install poppler-utils`. A PNG/JPG upload passes through directly.
2. **Qwen-VL extraction.** The page image(s) go to **`qwen-vl-max`** (override with
   `VISION_MODEL`) over the same OpenAI-compatible DashScope surface the rest of the
   app uses, with an **injection-hardened** prompt (any imperative text inside the
   document is treated as data, never an instruction) → a canonical raw-invoice object.
3. **Same loop.** That object is handed to the existing `normalizeInvoice` + the
   multi-step ReAct loop and **streamed** so the UI shows *extracting… → the live loop
   steps → the proposal*. The human approval gate is unchanged.

**Offline / CI:** a deterministic `FakeExtractionClient` returns a fixed invoice (the
one printed on the bundled `demo/sample-invoice.png`) with **no key, no network, and
no poppler**, so `npm test` exercises the whole *document → loop* slice. Real
`qwen-vl-max` is used only when `DASHSCOPE_API_KEY` is set — the same env-based
auto-selection as the decider and embedder.

---

## MCP integration & custom skills

Two capabilities let external agents and tools drive Archon Autopilot through
first-class, standard interfaces — the sophisticated-QwenCloud-usage the
**Technical Depth & Engineering** criterion calls for (custom skills · MCP
integrations).

### 1 · MCP server — drive the human-gated agent from any MCP client

`src/mcp/server.ts` is a real **Model Context Protocol** server
(`@modelcontextprotocol/sdk`) that **wraps the same injectable `AutopilotAgent`**
the HTTP routes drive — one decision loop, one memory, one approval queue, exposed
over a second surface. Both surfaces are wired from the same `resolveDeps()` helper
(`src/deps.ts`), so they can never drift.

It exposes seven MCP **tools**:

| MCP tool | What it does | Gate |
|---|---|---|
| `intake_invoice` | Run the multi-step ReAct loop → the proposed terminal action **+ the full step trace**, persisted **PENDING**. Nothing executes. | — |
| `list_pending` | The human approval queue, each item with its reasoning trace. | read-only |
| `approve` | Approve a PENDING item by id → its terminal skill executes for real. | **human-gated** |
| `amend` | Edit the proposed domain args, then approve → the amended args are exactly what execute. | **human-gated** |
| `reject` | Discard a proposal → nothing executes; the rejection is remembered. | **human-gated** |
| `recall_vendor` | Recall a vendor's history from persistent memory (prior invoices, actions, insights). | read-only |
| `list_skills` | Introspect the custom Qwen skill catalog (below). | read-only |

**The human-in-the-loop gate stays ironclad over MCP.** `intake_invoice` never
executes anything — it only proposes. `approve` requires an *explicit* call naming
the work-item id; nothing auto-executes. And a decided item **can never
re-execute**: a second `approve`/`amend`/`reject` returns an MCP **error result**
(`isError: true`), not a false success — the gate is *observable* over the wire,
not merely structural. This is enforced by reusing the agent's `requirePending`
guard, not re-implemented in the MCP layer.

**Run it (primary transport = stdio):**

```bash
npm run mcp        # launches the stdio MCP server (offline Fakes with no key;
                   # real qwen-plus + pgvector when DASHSCOPE_API_KEY / DATABASE_URL are set)
```

An MCP client **spawns** this as a subprocess and speaks JSON-RPC over
stdin/stdout (stdout is the transport — the server logs only to stderr). A typical
client config entry:

```json
{
  "mcpServers": {
    "archon-autopilot": {
      "command": "npm",
      "args": ["run", "mcp"],
      "cwd": "/root/autopilot"
    }
  }
}
```

> **stdio ≠ the HTTP port.** The public HTTP + Approval-UI surface is
> `https://autopilot.43.106.13.19.sslip.io` (see [Live](#live)); the MCP server is a
> **locally spawned stdio process**, not a host:port. To reach the same live agent's MCP
> surface on the box, spawn it there over SSH — e.g.
> `ssh root@43.106.13.19 'cd /root/autopilot && npm run mcp'` — so the MCP client's
> stdin/stdout is piped to the process. Both surfaces then drive the same pgvector
> memory + approval queue.

### 2 · Custom-skills catalog — the AP tools as a formalized skill layer

The function-calling tools the `qwen-plus` decider chooses from **are custom Qwen
skills**. `src/skills/catalog.ts` formalizes them into a first-class,
**introspectable catalog** — a typed registry **derived from the live function
schemas** (`analysisToolDefs()` + `toolDefs()`), so it can never drift from what the
model actually sees. Each skill carries its contract:

- **tier** — `autonomous` (runs inside the loop, no side-effect) vs `terminal`
  (stops the loop; proposes a side-effecting action);
- **gate** — `autonomous` (side-effect-free, ungated) vs `human-gated` (executes
  only after a person approves the exact args);
- **rules** — which validation rule(s) **R1–R6** the skill owns;
- **parameters** — the exact JSON-Schema handed to Qwen.

The catalog is introspectable both ways: **`GET /skills`** (HTTP) and the
**`list_skills`** MCP tool return the same `{ kind: "custom-skills", count, skills }`
payload.

| Skill | Tier | Gate | Rule |
|---|---|---|---|
| `recall_vendor_history` | autonomous | autonomous | — |
| `validate_invoice` | autonomous | autonomous | R1–R4 |
| `check_duplicate` | autonomous | autonomous | R5 |
| `compute_variance_vs_history` | autonomous | autonomous | R6 |
| `request_more_context` | autonomous | autonomous | — |
| `draft_journal_entry` | terminal | **human-gated** | — |
| `draft_payment` | terminal | **human-gated** | — |
| `draft_vendor_reply` | terminal | **human-gated** | — |
| `flag_for_review` | terminal | **human-gated** | — |

```bash
curl -s localhost:9000/skills | jq '.count, .skills[].name'   # introspect over HTTP
```

---

## Testing & CI

The suite is the full pyramid, offline-first:

- **Unit** — normalizer, R1–R6 validation, the terminal tool schemas + execute
  stubs, the autonomous read/analyze tools (`analysis-tools.test.ts`), the
  multi-step ReAct loop (`loop.test.ts` — the genuine multi-step trajectory, the
  real `tool_calls` parse path via a canned client and the `FakeQwenChatClient`, and
  the max-steps + no-progress guard fallbacks), the workflow state machine +
  approval gate (including the "≥2 autonomous steps, nothing side-effecting fires"
  invariant), the HTTP shell, the **custom-skills catalog** (`skills.test.ts` — the
  derived catalog matches the live schemas, no drift), and the **MCP tool dispatch**
  (`mcp.test.ts` — intake→pending→approve round-trip through the MCP surface, plus
  the gate observably enforced: a re-approved item returns `isError`).
- **Integration** — the **mandatory** offline slice drives `intake → pending →
  approve → executed` over HTTP with in-memory injection (no DB, no key); a real MCP
  **`Client ↔ Server`** round-trip over an in-memory transport
  (`mcp-transport.test.ts` — full protocol wiring, gate preserved); plus a real
  pgvector store round-trip that runs against the CI service container and **skips
  automatically when `DATABASE_URL` is unset**.
- **End-to-end (browser)** — a **Playwright** tier (`tests/e2e/upload-ux.spec.ts`, 4
  specs) drives the REAL served approval UI in headless Chromium against a locally
  started server with the offline Fakes: file-select → extraction → the reviewed
  invoice, clicking **Process** → the live SSE step stream → a PENDING proposal, the
  paste-JSON path, and the static surfaces (guided tour, sample buttons, decided tab,
  charts, empty state). These catch the browser-only upload-UX regressions (a dead
  file handler, a missing filename, a hidden step stream) that the node:test pyramid
  cannot see. It runs as its **own CI job** (a browser can't be measured under `c8`).
- **Coverage** — the full unit + integration pyramid runs under **c8** with an **80%
  floor** (statements / branches / functions / lines) on `src/`, gated in CI.

CI (`.github/workflows/ci.yml`): **gitleaks** (pinned v8.18.4) → **dep-audit**
(`npm audit`, fails on high/critical) → **typecheck** → **build** (`tsc`) →
**test** → **demo smoke** → **decision-quality eval gate**, with a parallel
**coverage** gate and a dedicated **Playwright e2e** job — all with no
`DASHSCOPE_API_KEY`, so the whole agent runs on the deterministic Fakes.

---

## Decision-quality eval

The eval turns "the agent proposes actions" into a **measured number**. A labelled
set of **22 AP scenarios** (`eval/dataset.ts`) — clean new-vendor, clean recurring
vendor, missing/unreconciled fields, suspected duplicate, amount anomaly,
ambiguous/messy input, and signal-precedence collisions — each carries the tool a
human AP clerk would deem correct (**business ground truth**, never traced from the
Fake's policy). The runner drives the **real multi-step loop** (normalize → recall
vendor history → validate R1–R4 → check_duplicate R5 / compute_variance R6 as the
evidence warrants → terminal action) and grades **tool-choice accuracy**. Because
every scenario now runs the loop, it also reports **loop autonomy** — how many
autonomous steps ran before the terminal action:

```bash
npm run eval            # drive every scenario, print the table + accuracy N/M
npm run eval -- --gate  # CI gate: fail if accuracy < the floor
```

- **Offline (deterministic Fakes, gated in CI):** **21 / 22 (95.5%)** tool-choice
  accuracy, with **every one of the 22 scenarios taking ≥2 autonomous read/analyze
  steps** (avg 2.3) before the terminal action — a **policy / regression** guard
  over the real multi-step pipeline. The single miss (`s22`) is a **documented,
  deliberately-surfaced limitation**, not a hidden failure: a no-parseable-total
  invoice is surfaced as an R1 observation but the deterministic policy has no
  routing branch for it, so it falls through instead of drafting a vendor query. The
  eval reports it rather than labelling around it.
- **Online (real `qwen-plus`, run with a key):** the actual **decision-quality**
  number — the model choosing freely against the same labels. Set
  `DASHSCOPE_API_KEY` and re-run `npm run eval`; the header self-labels the run
  `ONLINE` and prints the live model ids.

Method, honesty caveats, and the offline/online split: [`EVAL.md`](EVAL.md).

---

## Current scope and follow-ups

Stated plainly (see also the Scope note up top):

- **Terminal sinks are simulated adapters.** `draft_journal_entry` / `draft_payment`
  / `draft_vendor_reply` / `flag_for_review` record what *would* happen to
  inspectable in-memory Fakes behind real interfaces; the `Sinks` interfaces are the
  drop-in seam for real ledger / payment-rail / SMTP adapters. No ERP, bank, or mail
  server is contacted. **The loop and the autonomous read/analyze tools + memory
  grounding are real** — only the terminal side-effects are simulated.
- **Live on Alibaba Cloud.** The app is deployed on an Alibaba Cloud **ECS** box over
  HTTPS at **https://autopilot.43.106.13.19.sslip.io** — real Qwen (`qwen-plus` +
  `text-embedding-v4`) on Alibaba Cloud Model Studio, backed by pgvector on the box.
  One-command reproduce/redeploy via [`deploy/redeploy.sh`](deploy/redeploy.sh); see
  [`deploy/DEPLOY_STATE.md`](deploy/DEPLOY_STATE.md) and [`deploy/DEPLOY_NOTE.md`](deploy/DEPLOY_NOTE.md).
- **Deferred:** managed **ApsaraDB RDS for PostgreSQL** / **Function Compute** as an
  alternative to the ECS + on-box pgvector topology; and the real Sinks adapters above.

## License

MIT — see [LICENSE](LICENSE).
