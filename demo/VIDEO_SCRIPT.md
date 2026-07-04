# Archon Autopilot — demo video script

*Target length 3–5 minutes. Track-4 (Autopilot Agent), Global AI Hackathon Series
with Qwen Cloud. Honest framing throughout: a **human-gated** AP agent, live Qwen
wired, verified offline via Fakes, single-shot decider, stub sinks.*

Two capture options:
- **A (recommended, visual):** run the backend, then `demo/capture_demo.sh` — clean
  labelled output that walks the whole loop including the memory write-back.
- **B (no server):** `npm run demo` and `npm run eval` — the same loop + the measured
  eval, fully offline.

---

## 0:00–0:30 — The problem (talking head or slide)

> "Accounts payable is repetitive, it needs memory, and a wrong call costs real
> money — a double payment, or a supplier left waiting. The tempting fix is to fully
> automate it. That's the wrong fix: you can't let a language model pay invoices
> unattended. So we built **Archon Autopilot** — a *human-gated* AP agent. Qwen does
> all the reading, remembering, and deciding; a person approves the exact action
> before a cent moves."

On screen: the repo README title + the "Scope, stated honestly" note.

## 0:30–1:00 — Architecture (README diagram)

> "Every invoice is normalized, validated with six cross-checks, and matched against
> the vendor's history recalled from a persistent pgvector memory — our Track-1
> MemoryAgent. Then `qwen-plus`, via function-calling, chooses exactly one of four
> actions and fills its arguments. Nothing executes. It's persisted PENDING behind a
> human approval gate."

On screen: the Mermaid flow in `README.md` (intake → validate → recall → decide →
HITL gate → execute → remember). Point at the gate.

## 1:00–1:20 — Start the backend

```bash
npm start
```

> "No DashScope key needed for the walkthrough — with no key the deterministic Fakes
> engage, so the whole loop runs offline. The exact same code runs live against Qwen
> and pgvector; I'll show the live health line."

On screen: `curl localhost:9000/health` → the embedder + decider ids. Open
`http://localhost:9000/docs` briefly (Swagger UI).

## 1:20–3:00 — The full loop (run the capture script)

```bash
bash demo/capture_demo.sh
```

Narrate each labelled block as it prints:

1. **Intake a messy, NEW vendor.** "Alias keys, a `€ 1.200,00` string amount — the
   normalizer cleans it up. The decider proposes **draft_journal_entry**: a clean
   invoice from a vendor we've never seen. It's PENDING — nothing has executed."
2. **GET /pending.** "The human approval queue. This is the gate."
3. **Approve.** "A person approves. *Now* the tool runs — a balanced journal entry —
   and the outcome is written back to memory."
4. **Same vendor again, clean.** "Watch the decision change: the agent recalls the
   vendor from the last intake, so this time it proposes **draft_payment** — a
   recurring, known vendor. That transition, new-vendor → known-vendor, is the
   **memory write-back loop**, live."
5. **A duplicate of invoice 1.** "Same vendor and reference as one we already
   processed — recalled from memory. The agent **flags it for review**, and the human
   rejects it. No double payment."

> "That's the whole story: messy intake, Qwen proposes, human gate, execute,
> remember — and the agent got smarter about this vendor across three intakes."

## 3:00–4:00 — We measured the decisions

```bash
npm run eval
```

> "An agent that chooses actions is worthless if nobody checks the choices. So we
> built an eval: 22 labelled AP scenarios — clean, missing fields, duplicates,
> anomalies, messy input, and precedence collisions — each labelled with what a human
> clerk would do. It drives the real decider path and grades the proposed tool."

On screen: the eval table. Point at the summary line **21 / 22 (95.5%)**.

> "Offline, that's a gated regression guard. And notice **s22 fails** — an invoice
> with no parseable total. We *keep* that miss and document it, rather than a
> suspicious 22-out-of-22. With a DashScope key the same eval grades real `qwen-plus`
> choosing freely — that's the live decision-quality number."

*(If the live number is captured: show `DASHSCOPE_API_KEY=... npm run eval` header
self-labelling `ONLINE` and the online accuracy.)*

## 4:00–4:40 — Engineering + honesty

> "One decider, one seam: a Fake chat client returns the exact `tool_calls` shape
> DashScope returns, so the real parse path is tested in CI with no key. The args a
> human approves are exactly the args that execute. And we're honest about scope —
> the decider is single-shot, the execution sinks are in-memory stubs with the
> interfaces ready for real ledger, payment, and SMTP adapters. Live Qwen is wired;
> the offline path is deterministic Fakes."

On screen: CI green (gitleaks → dep-audit → typecheck → build → tests → demo → eval
gate), and the README "Current scope and follow-ups" section.

## 4:40–5:00 — Close

> "Archon Autopilot: the reasoning of an AP agent, with a human always on the money —
> and a measured number to prove the decisions are worth approving. Built on Qwen,
> layered on our Track-1 MemoryAgent, reproducible offline with zero credentials."

On screen: repo URL + MIT license.

---

### Shot list / B-roll checklist

- [ ] README title + "Scope, stated honestly" note
- [ ] Mermaid architecture diagram (the gate highlighted)
- [ ] `/health` line + Swagger `/docs`
- [ ] `capture_demo.sh` full run (the five labelled blocks)
- [ ] the new-vendor → known-vendor decision change (the money shot)
- [ ] `npm run eval` table with 21/22 and the s22 miss
- [ ] *(optional)* `ONLINE` eval header with the live qwen-plus number
- [ ] CI green with the eval gate step
