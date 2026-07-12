# Judge guide — Archon Autopilot in five minutes

A click-by-click path through the live agent, with each step mapped to the judging
criterion it evidences. Everything below works on the **live demo** and on a bare
local clone (offline Fakes — no key, no database). Nothing here moves real money: the
terminal sinks are simulated adapters behind real interfaces (see the README's Scope
note).

- **Live Approval UI:** https://autopilot.43.106.13.19.sslip.io/
- **Local:** `npm install && npm start` → http://localhost:9000/ (Swagger at `/docs`)

The whole path is one screen. Follow it top to bottom.

---

## 1 · Upload a real invoice and watch the agent think

1. Open the Approval UI. Click **"Use sample document"** (top of the upload panel).
   This uploads the bundled `demo/sample-invoice.png` — a real image, not JSON.
2. The page shows **extracting…**, then renders the **extracted invoice** for review.
   Live, this ran `qwen-vl-max` vision extraction on Alibaba Cloud Model Studio;
   offline, a deterministic extractor returns the same invoice with no key.
3. Click **"Process invoice"**. Now watch the **reasoning steps stream in live** (Server-Sent
   Events), one per line as they happen:
   `recall_vendor_history → validate_invoice → check_duplicate / compute_variance`.
   You are watching a **bounded multi-step ReAct loop** over `qwen-plus`
   function-calling — the agent gathers evidence with side-effect-free tools before it
   proposes anything.

> **Maps to → Technical Depth & Engineering (30%).** A genuine multi-step
> function-calling loop, streamed. The same `tool_calls`-parse path runs online and
> offline, so it is exercised in CI with no credentials.

---

## 2 · Read the proposal — and how it was reached

4. The loop stops at **exactly one terminal action** and the item appears in the
   **Pending** queue as a `PENDING` proposal. Nothing has executed.
5. Each card shows the **proposed tool**, the model's **reasoning** and **confidence**,
   and (if the confidence is low) a **"low confidence — review carefully"** nudge.
6. Click the chevron on **"How the agent decided"** to expand the **full step trace** —
   every observation the agent saw, in order. A person sees *how* it decided, not just
   the verdict.

> **Maps to → Human-in-the-loop (Track-4 core) + Presentation (15%).** The decision is
> transparent and auditable before anyone approves it.

---

## 3 · Amend the arguments — the human approves *exactly* what runs

7. In **"Action arguments — edit to amend"**, change a value (e.g. lower the `amount`).
8. Click **"Amend & approve"**. The **amended** args are exactly what execute — the
   human approves precisely what runs (the HITL integrity guarantee). The model's tool
   catalog never contained an `approve`/`pay` tool, so no injected instruction in the
   invoice could have reached this side-effect; only your click does.

> **Maps to → Innovation & AI Creativity (30%) + Technical Depth.** The gate is
> *structural*, not a prompt rule. And a downward amount amendment here is **written
> back and read on this vendor's next invoice** — the approval gate is also a training
> signal (measured before/after in [`../EVAL.md`](../EVAL.md); reproduce with
> `npm run eval:corrections`).

---

## 4 · Confirm where it went

9. Open the **Decided** tab. Your item is there with its **outcome**, timestamp, and —
   because you amended it — the **prev → new args diff** (the amend audit trail). A
   decided item can never re-execute.

> **Maps to → Problem Value & Impact (25%).** This is the AP clerk's real workflow —
> triage, correct, approve, audit — automated up to the decision and stopped for a
> human.

---

## 5 · Drive the same agent over MCP

The identical agent + gate is exposed as a **Model Context Protocol** server (stdio),
wired from the same dependencies as the HTTP surface — one decision loop, one memory,
one approval queue.

```bash
npm run mcp        # launches the stdio MCP server (offline Fakes with no key)
```

An MCP client spawns this and speaks JSON-RPC over stdin/stdout. Its **seven tools**
are `intake_invoice`, `list_pending`, `approve`, `amend`, `reject`, `recall_vendor`,
`list_skills`. Drive `intake_invoice → list_pending → approve` and you will see the
**same gate hold over the wire**: `intake` only proposes; a decided item re-approved
returns an MCP **error result**, not a false success.

> **Maps to → Technical Depth & Engineering (30%).** Sophisticated Qwen Cloud usage on
> two surfaces over one shared core, plus a derived, introspectable custom-skills
> catalog (`GET /skills` and the `list_skills` MCP tool return the same payload).

---

## 30-second version (no clicking)

```bash
npm install
npm run demo              # drives four invoices end to end through the whole loop
npm run eval             # the measured decision-quality number (22/22 offline)
npm run eval:corrections # the learning-from-corrections before/after delta
npm test                 # the full offline pyramid — no key, no database
```

Everything runs offline with deterministic Fakes, so a judge can reproduce every
number on a bare clone with zero credentials and zero spend.
