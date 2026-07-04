# Archon Autopilot — a human-gated accounts-payable agent

*Project story for the Global AI Hackathon Series with Qwen Cloud — Autopilot Agent
track (Track 4). It layers on our Track-1 [Archon MemoryAgent](../../qwen-memoryagent).
Method, the measured decision-quality number, and honest caveats live in
[EVAL.md](../EVAL.md).*

## Inspiration

Accounts payable is where a small business quietly loses money and time. Invoices
arrive as messy emails and PDFs, in different layouts, with fields missing or
mistyped. Someone has to read each one, remember whether this vendor is new or
recurring, notice that *this* invoice looks suspiciously like one already paid last
month, check that the numbers even add up — and only then decide: post it, pay it,
query the vendor, or escalate. It is repetitive, it needs memory, and the cost of a
wrong call is real money out the door (a double payment) or a supplier left waiting.

The obvious pitch is "automate it away." We think that pitch is *wrong*, and
dangerously so. You cannot hand a language model your bank rail and let it pay
invoices unattended — one hallucinated amount or missed duplicate and it has spent
money you can't claw back. But the *reasoning* — reading a messy invoice, recalling
the vendor, weighing the findings, and proposing the right next action — is exactly
what a model is good at.

So the guiding question became: *how do you get the leverage of an agent that reasons
and acts, without ever giving up human control of the money?* The answer is a
**human-in-the-loop gate** — the agent does all the reading, remembering, and
proposing; a person approves the exact action before anything happens.

## What it does

**Archon Autopilot** is a **human-gated accounts-payable agent**. For each incoming
vendor invoice it runs the AP workflow end to end — up to, but not through, the
point of consequence:

1. **Intake + normalize** — a messy invoice (`POST /intake`) is coerced into a clean
   record: alias keys (`supplier`/`payee` → vendor), string amounts (`"€ 2.500,00"`,
   EU decimals, `"USD 900"`), bad dates, inferred totals — every coercion recorded,
   never silently dropped.
2. **Validate** — six cross-checks (R1 amount sanity, R2 required fields, R3 tax
   reconciliation, R4 line-item integrity, R5 duplicate, R6 amount anomaly).
3. **Recall** — it queries its **persistent pgvector memory** (the Track-1
   MemoryAgent foundation) for this vendor's history: seen before? usual amount? a
   likely duplicate of a prior invoice?
4. **Decide via Qwen function-calling** — `qwen-plus` is handed a real tool set and
   **chooses exactly one** action — `draft_journal_entry`, `draft_payment`,
   `draft_vendor_reply`, or `flag_for_review` — filling its arguments and
   self-reporting a reasoning + confidence.
5. **The gate** — the proposal is persisted as **PENDING**. **Nothing executes.** A
   human sees the queue (`GET /pending`) and **approves**, **amends** (edits the
   args, then approves), or **rejects**.
6. **Execute + remember** — on approval the chosen tool runs, and the outcome is
   **written back to memory**, so the next invoice from that vendor is judged with
   more context.

The headline is the loop between steps 3 and 6: the agent **recalls** to decide, and
**remembers** the outcome — so a vendor seen once as a new-vendor journal entry is,
next month, recognised as recurring and proposed for straight-through payment. It
gets better at *your* vendors over time.

**What it is, stated honestly:** the decider is **single-shot** (one tool call per
invoice, not a multi-step plan/act/observe loop). The execution **sinks are
in-memory stubs** — they record what *would* post to a ledger / payment rail / SMTP,
with the interfaces in place for real adapters; no ERP or bank is contacted. Live
Qwen is wired; the whole loop is verified offline via deterministic Fakes.

## How we built it

The service is **TypeScript on Fastify** (Node ≥20, ESM), the same stack as Track 1,
with a target deployment on **Alibaba Cloud** (ECS or Function Compute custom
container + ApsaraDB RDS for PostgreSQL / pgvector). Qwen is called through the
OpenAI-compatible DashScope endpoint: `qwen-plus` for the function-calling decision,
`text-embedding-v4` for memory.

### One decider, one seam

There is a **single** `QwenDecider`. It builds the prompt, calls the
chat-completions **tool-calling** API, and parses the `tool_calls` response into a
`ProposedAction`. Offline versus online differs by exactly one thing: which client
sits behind the seam — the real `openai` client to `qwen-plus`, or a
`FakeQwenChatClient` that returns a canned assistant message carrying a `tool_calls`
entry *in the exact shape DashScope returns*. So the real tool-call **parse path is
exercised in CI**, with no key. That was a deliberate choice: the integration we
most want to trust is the one CI can't skip.

### The human-in-the-loop integrity guarantee

Each tool's schema carries two meta-fields the model self-reports — `reasoning` and
`confidence`. The decider **lifts these out** of the tool arguments into the
proposal envelope, so the **domain arguments a human approves are exactly the
arguments that execute**. Amend merges the human's edits onto those domain args
before execution. A decided item can never be re-executed (approve/reject → `409`).
The gate isn't a slide; it's enforced in the state machine and tested.

### Memory as the foundation, not a bolt-on

The autopilot reuses the Track-1 MemoryAgent directly: the same `Embedder` seam
(real `text-embedding-v4` vs. an offline `FakeEmbedder`), the same pgvector
`MemoryStore` (real vs. in-memory), the same "auto-select real Qwen vs. Fakes by
environment" design. Duplicate detection and amount-anomaly checks are
**memory-grounded** — they read prior invoices recalled for the vendor, not a
single-session cache.

### Offline-first, so it's testable

Every external dependency has an injectable seam. With no `DASHSCOPE_API_KEY`, the
deterministic `FakeQwenChatClient` + `FakeEmbedder` engage and the **whole loop —
intake → decide → approve → execute → remember — runs with zero credentials and zero
spend.** That is what lets the full test pyramid *and the decision-quality eval* run
in CI on every commit.

### We measured the decisions

The biggest risk in "an agent that chooses actions" is that no one checks whether the
choices are *good*. So we built an eval (`eval/`, [EVAL.md](../EVAL.md)): 22 labelled
AP scenarios, each carrying the tool a human clerk would pick, graded against the
**real decider path**. Offline (deterministic Fakes, gated in CI) it scores
**21 / 22 (95.5%)** as a policy/regression guard; online with a key it grades real
`qwen-plus` choosing freely — the actual decision-quality number.

## Challenges we ran into

- **Messy input is the whole front door.** Real invoices don't arrive clean.
  Getting `"€ 2.500,00"`, EU vs. US decimal conventions, `"USD 900"`, alias keys, and
  unparseable dates to normalize into a record validation can reason about — while
  *recording* every coercion for the reviewer — took the bulk of the normalizer.
- **Testing an LLM integration without an LLM in CI.** We wanted the actual
  `tool_calls` parse path covered offline. The fix was a Fake that returns the exact
  OpenAI-compatible tool-call shape at the client seam, so the same decider code
  parses canned and live responses identically. The integration is genuinely tested,
  not mocked away.
- **Making "human-in-the-loop" a guarantee, not a label.** It's easy to *say* a
  human approves; it's harder to prove the approved args are the executed args. We
  had to split the model's meta-fields out of the domain args and thread the amended
  args through execution so the two can't diverge.
- **Proving the decisions are good — honestly.** An offline eval over a deterministic
  policy risks being circular. We resolved it by labelling every scenario from
  *business* ground truth (never from the Fake), leaning the offline weight on
  precedence scenarios that grade the *order* of safety checks, and **keeping one
  scenario the deterministic policy fails** (a no-total invoice) rather than labelling
  around it — reporting 21/22, not a suspicious 22/22.

## Accomplishments that we're proud of

- **A real tool-using agent with a hard safety gate.** Qwen function-calling picks
  one of four AP actions per invoice; nothing touches the world until a human
  approves the exact args — and that guarantee is enforced and tested, not asserted.
- **A measured decision-quality eval.** 22 labelled scenarios graded on the real
  decider path — **21 / 22 (95.5%)** offline as a gated regression guard, with the
  online `qwen-plus` number captured live. We report the one miss and why.
- **The memory write-back loop, working end to end.** A vendor seen once is
  recognised next time; the new-vendor → recurring-vendor transition is demonstrable
  on screen and covered by tests.
- **Offline-first, reproducible with zero credentials.** The whole loop, the test
  pyramid, and the eval gate run in CI with no key and no spend, via deterministic
  Fakes — while the identical code runs live against Qwen + pgvector.
- **Honest scope.** Single-shot decider, stub sinks, small labelled eval — all stated
  plainly in the README, this story, and EVAL.md, so every claim that *is* strong is
  believable.

## What we learned

- **The valuable automation in AP is the reasoning, not the paying.** The moment you
  keep a human on the money, an agent that reads, recalls, and proposes is both safe
  *and* a genuine time-saver. "Human-gated" isn't a weaker product than "autonomous"
  — for money movement it's the *correct* one.
- **Memory is what makes an AP agent more than a classifier.** Duplicate detection
  and amount anomalies only exist because the agent recalls prior invoices. The
  write-back loop is what turns a one-shot decision into an agent that learns a
  vendor.
- **If you don't measure the decisions, you don't have an agent — you have a demo.**
  Building the eval changed the project: it forced business-truth labels, surfaced a
  real policy gap, and gave us a number to defend instead of a vibe.
- **Honesty is a feature.** Reporting 21/22 (not 22/22), naming the single-shot scope
  and the stub sinks, and separating the offline regression number from the online
  decision-quality number makes the whole submission more credible, not less.

## What's next for Archon Autopilot

- **Real sink adapters.** Swap the in-memory stubs for a ledger client, a payment
  rail, and an SMTP transport behind the existing `Sinks` interfaces — no workflow
  change.
- **A multi-step decider.** Move from single-shot to a bounded plan/act/observe loop
  (e.g. fetch a missing PO, then re-decide) while keeping the same approval gate.
- **Close the R1 gap the eval found.** Add a no-payable-total signal so a garbled
  invoice routes to a vendor query deterministically — then re-measure.
- **A web approval UI.** A queue over `/pending` + `/approve` + `/amend` + `/reject`
  so a non-technical reviewer works the gate directly.
- **The live decision-quality number, tracked.** Capture the online `qwen-plus` eval
  each release and watch it move as the prompt and tool set evolve.
