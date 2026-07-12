# Decision-quality eval — does the autopilot choose the right action?

A tool-using agent is only as good as the *actions it chooses*. This eval turns
"the agent proposes an action per invoice" into a **measured number** you can
reproduce: on a frozen, labelled set of accounts-payable scenarios, does the
decider pick the tool a human AP clerk would? It is the decision-making analogue of
the Track-1 MemoryAgent's retrieval benchmark — an objective grade on our own
output, gated in CI.

## TL;DR

On a labelled set of **22 AP scenarios** (`eval/dataset.ts`), the eval drives the
**real multi-step ReAct loop** — normalize the (possibly messy) invoice → recall the
vendor's history from persistent memory → validate R1–R4 → confirm a duplicate (R5) /
compute the amount variance (R6) as the evidence warrants → **Qwen function-calling**
picks the next tool each step — and grades the **proposed terminal tool** against the
business-correct label.

| Mode | Model seam | Tool-choice accuracy | What the number means |
|---|---|---:|---|
| **Offline** (CI, gated) | deterministic Fakes | **22 / 22 (100.0%)** | policy / regression guard over the real multi-step pipeline |
| **Online** (with a key) | real `qwen-plus` | *run with a key to capture* | the actual decision quality of the model choosing freely |

```bash
npm run eval            # drive every scenario, print the table + accuracy N/M
npm run eval -- --gate  # CI gate: fail if tool-choice accuracy < 90%
```

> **What the offline 22/22 is — and is not.** The offline number is produced by the
> **deterministic Fakes**, so it is a **policy / regression guard** over the real
> multi-step pipeline, not a decision-quality claim about the model. The
> **decision-quality** number is the **online** row — real `qwen-plus` choosing freely
> against the same labels. That online run needs a DashScope key and a few cents of
> spend, so it is **not bundled into this repo's number**; run `DASHSCOPE_API_KEY=sk-…
> npm run eval` to capture it (the header self-labels the run `ONLINE`). We keep the
> two numbers separate on purpose rather than presenting the Fake's result as the
> model's.

Because every scenario now runs the loop, the eval also reports **loop autonomy**:
**all 22 scenarios take ≥2 autonomous read/analyze steps** (avg 2.3) before any
terminal, human-gated action — the multi-step reasoning is measured, not asserted.
Arg-sanity (does the proposed action execute cleanly against the simulated sinks) is
reported alongside — **22 / 22** — but **not gated**, because the model may
legitimately omit an argument the tool's `execute()` back-fills from the invoice.

## Why this is a real eval and not a tautology

The honest objection to grading an agent that has a deterministic offline mode is:
*aren't you just testing that the Fake matches the labels?* Here is the precise
answer.

The pipeline under test is **real, non-trivial logic**:

```
raw invoice → normalize (alias keys, "€ 2.500,00", EU decimals, inferred totals)
            → LOOP, one tool per step (Qwen function-calling):
                recall_vendor_history        (embed + cosine ANN over memory, filtered by vendor; surfaces facts)
                validate_invoice             (R1 amount sanity · R2 required fields · R3 tax reconcile · R4 line items)
                check_duplicate              (R5 duplicate — memory-grounded)
                compute_variance_vs_history  (R6 amount anomaly — memory-grounded)
              → one TERMINAL action
```

Every step up to the terminal action is genuine work, and the eval grades that whole
multi-step path against a **semantic label**. When scenario `s10` (`{ amount:
"€ 2.500,00", … }`, no vendor, no reference) must resolve to `draft_vendor_reply`, we
are verifying that messy-input normalization + the `validate_invoice` step actually
produce `missing_fields=true` and route correctly — a chain that can regress.

Only the **final `evidence → next tool` choice** is deterministic under the offline
Fake (`fake-chat.ts` reads the accumulated `EVIDENCE:` snapshot and mirrors the
decision precedence). So:

- **Offline is a policy / regression guard**, not a decision-quality claim. It
  proves the real loop still gathers the intended evidence and takes the intended
  safe action. It is deterministic, so it never flakes.
- **Online is the decision-quality number.** With a key, `qwen-plus` reads the full
  invoice + accumulated observations + recalled history and **chooses freely** — no
  fixed evidence-to-tool lookup. Grading *that* against the same labels measures
  whether the model makes the call a human would. That is the number the live run
  captures.

**The labelling discipline that makes this legitimate:** every `expected` is set by
asking *"what should an AP clerk do here?"* — the business ground truth — and is
**never** back-derived from `fake-chat.ts`. The precedence scenarios (below) are the
load-bearing proof, because they grade the *order* of safety checks, a real property
independent of any one implementation.

## The dataset (22 scenarios, 8 categories)

`eval/dataset.ts`. Each scenario optionally seeds prior invoices (intaken through
the same pipeline, so the vendor's history lands in persistent memory the way a
real cross-session agent would recall it), then intakes the invoice under decision.

| Category | n | Business-correct action | Why |
|---|---:|---|---|
| `clean_new_vendor` | 2 | `draft_journal_entry` | well-formed invoice, vendor not seen before → accrue the liability |
| `clean_recurring_vendor` | 3 | `draft_payment` | clean invoice from a known, in-range vendor → straight-through pay |
| `missing_fields` | 3 | `draft_vendor_reply` | vendor / reference / tax_id absent → cannot pay safely; query first |
| `unreconciled` | 2 | `draft_vendor_reply` | figures present but subtotal+tax or line items don't reconcile |
| `suspected_duplicate` | 2 | `flag_for_review` | same vendor+reference, or same vendor+amount+date as a prior → don't double-pay |
| `amount_anomaly` | 2 | `flag_for_review` | total many times the vendor's usual → confirm before posting |
| `ambiguous_messy` | 4 | *(varies)* | heavily aliased / string-amount / foreign-currency / garbled inputs |
| `precedence` | 4 | *(the safer one)* | two signals collide; the safety-preserving action must win |

### The precedence scenarios (the non-circular core)

These grade the **order** of the safety checks — the property most worth protecting
against regression, and the one a naive re-implementation gets wrong:

- **`s17` duplicate AND missing tax_id →** `flag_for_review`. Duplicate risk
  outranks the missing field: you never pay twice, and the missing field is moot if
  it's a double-bill.
- **`s18` known vendor BUT missing tax_id →** `draft_vendor_reply`. A recurring
  vendor does *not* earn straight-through payment when a required field is absent —
  query first.
- **`s19` known vendor BUT anomalous amount →** `flag_for_review`. Anomaly outranks
  straight-through payment.
- **`s20` known vendor, clean, BUT figures don't reconcile →** `draft_vendor_reply`.

## The resolved limitation (`s22`)

Previously, offline accuracy was **21 / 22** because scenario `s22` (an invoice whose amount cannot be parsed: `amount: "see attached"`, no subtotal/tax) fell through to `draft_journal_entry`. Although `validate_invoice` correctly surfaced the R1 FAIL (no payable total) in the trace, the deterministic offline Fake did not have a routing branch for `no_total`.

We have now **resolved this routing limitation**. The offline Fake policy explicitly checks the `no_total` evidence flag and routes it to `draft_vendor_reply` (query the vendor), achieving a clean **22 / 22 (100.0%)** offline policy accuracy. This bridges the gap between the offline policy and the live LLM's expected reasoning.

## The CI gate (what we actually enforce)

CI runs `npm run eval -- --gate` on every push, with **no `DASHSCOPE_API_KEY`**, so
the deterministic Fakes drive it. The gate is set to the **measured** floor, not an
aspiration:

> **tool-choice accuracy ≥ 90%** (measured: 100.0%).

The floor sits well below the measured value, so CI
catches a *real* regression in the multi-step recall→validate→check→act loop without pretending
the deterministic policy is perfect. We deliberately **do not gate arg-sanity** (the
Fake omits some args by design) and **do not gate the online number** (it needs a
key and costs spend; it is captured and reported, not enforced).

## Learning from corrections

The eval above grades a single invoice in isolation. A separate, complementary
measurement answers a different question: **does a human correction at the approval
gate actually change the NEXT decision for that vendor?** (This is what makes the
"the agent gets smarter" claim true rather than write-only.)

```bash
npm run eval:corrections   # offline, zero spend
```

It reports a **behavioural delta, not an accuracy number** — and this is a
deliberate honesty choice. The eval's whole credibility rests on labels being
business ground truth, never back-derived from our policy; so rather than invent a
label for these scenarios and grade against it, we **run the same decision invoice
twice and report what the agent proposes each time**, differing *only* in whether the
human correction happened:

| Scenario | Before (no correction) | After (with correction) | Δ |
|---|---|---|---|
| Vendor amended down 5000→3000, next invoice **re-bills 5000** | `draft_payment` | `flag_for_review` | **changed** |
| Same correction, next invoice **bills the corrected 3000** (control) | `draft_payment` | `draft_payment` | unchanged |

**The measured result:** the correction signal flips `draft_payment → flag_for_review`
on the genuine re-bill (**1/1**), and leaves a **compliant** invoice — one that bills
the corrected amount — as `draft_payment` (the signal is amount-scoped: it fires only
when a later invoice bills materially above the corrected amount, so it is not a
blanket "escalate this vendor forever"). If the effect were smaller we would report it
smaller; here it is a clean, isolated flip on the one case that warrants it.

**Why the escalation is legitimate, not circular.** The `flag_for_review` here is
independently justifiable: re-billing an amount a human already corrected *down* for
a vendor is a concrete error an AP clerk catches — the label survives *without*
reference to the fact that we built a correction-reader. It is a **conservative,
recency/amount-scoped** policy (only when the new invoice bills materially above the
corrected amount), not "escalate this vendor forever after one correction".

**What is exercised.** The measurement (and its CI-gated twin,
`tests/integration/learning-from-corrections.test.ts`) drives the **real**
`agent.amend()` / `agent.reject()` → memory-writeback → `recall_vendor_history` path
— nothing is hand-injected — so it proves the whole feedback loop, not just a flag.
Offline this is deterministic (the `FakeQwenChatClient` branches on the
`rebills_corrected` evidence flag); online, `qwen-plus` reads the same recalled
correction in natural language and chooses freely.

**Scope, owned.** Two scenarios (a genuine re-bill + a negative control) — a small,
honest demonstration that the approval gate's feedback is *read and changes
behaviour*, not a general online-learning claim.

## Reproduce

```bash
npm ci
npm run eval            # offline: replays the deterministic pipeline, prints 22/22
npm run eval -- --gate  # offline CI gate: accuracy ≥ 90%
# live decision-quality number (needs a DashScope key, a few cents):
cp .env.example .env    # set DASHSCOPE_API_KEY
DASHSCOPE_API_KEY=sk-... npm run eval   # header self-labels ONLINE; grades real qwen-plus
```

> **Live-run cost note.** Each scenario now runs the multi-step loop (several
> qwen-plus calls — one per step — plus any seed intakes), so a live eval makes
> ~3× the API calls the old single-shot path did. Still cents overall, but budget
> for it. The offline gate is free (zero credentials, zero spend).

## MCP integration & custom skills — the same graded agent, a second surface

The number above grades the **agent**, not a transport. The agent is now reachable
two ways — the HTTP routes and an **MCP server** (`src/mcp/server.ts`,
`@modelcontextprotocol/sdk`) — both wired from the same `resolveDeps()` helper to the
**same injectable `AutopilotAgent`**. So `intake_invoice` over MCP runs the *identical*
multi-step loop this eval measures; there is no second decision path to grade.

What the eval's discipline is complemented by, on the MCP side, is a **behavioural**
guarantee proven by tests rather than a scored number:

- **Round-trip through the real MCP surface** — `tests/integration/mcp-transport.test.ts`
  stands up a real MCP `Client ↔ Server` over an in-memory transport and drives
  `intake_invoice → list_pending → approve`, fully offline.
- **The human-in-the-loop gate is preserved — and observable — over MCP.** `intake`
  executes nothing (sinks empty, status `pending`); `approve` needs an explicit call
  naming the id; a decided item can never re-execute — a second `approve`/`amend`/`reject`
  returns an MCP `isError` result, asserted in `tests/unit/mcp.test.ts`.
- **Custom-skills catalog is faithful** — `tests/unit/skills.test.ts` proves the
  `GET /skills` / `list_skills` catalog is derived from the live function schemas
  (every skill once, correct tier/gate/rule, parameters equal to what Qwen sees), so
  it cannot drift from the tools the graded loop actually uses.

These run in the offline suite (`npm test`) with no key and no DB — same zero-spend
discipline as the gated eval. Connection + config details: the
[MCP integration & custom skills](README.md#mcp-integration--custom-skills) section
of the README.

**Scope, owned:** 22 scenarios on a frozen labelled set — a small, honest eval,
exactly like the Track-1 retrieval benchmark's 15 queries. It measures *this*
decider on *these* situations; it is not a general decision-quality claim. The
offline grade is reproducible with zero credentials and zero spend; the online grade
is a single keyed run over the same labels.
