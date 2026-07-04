# Decision-quality eval — does the autopilot choose the right action?

A tool-using agent is only as good as the *actions it chooses*. This eval turns
"the agent proposes an action per invoice" into a **measured number** you can
reproduce: on a frozen, labelled set of accounts-payable scenarios, does the
decider pick the tool a human AP clerk would? It is the decision-making analogue of
the Track-1 MemoryAgent's retrieval benchmark — an objective grade on our own
output, gated in CI.

## TL;DR

On a labelled set of **22 AP scenarios** (`eval/dataset.ts`), the eval drives the
**real decider path** — normalize the (possibly messy) invoice → validate R1–R6 →
recall the vendor's history from persistent memory → **Qwen function-calling** — and
grades the **proposed tool** against the business-correct label.

| Mode | Model seam | Tool-choice accuracy | What the number means |
|---|---|---:|---|
| **Offline** (CI, gated) | deterministic Fakes | **21 / 22 (95.5%)** | policy / regression guard over the real intake pipeline |
| **Online** (with a key) | real `qwen-plus` | *captured live* | the actual decision quality of the model choosing freely |

```bash
npm run eval            # drive every scenario, print the table + accuracy N/M
npm run eval -- --gate  # CI gate: fail if tool-choice accuracy < 90%
```

Arg-sanity (does the proposed action execute cleanly against the stub sinks) is
reported alongside — **22 / 22** — but **not gated**, because the model may
legitimately omit an argument the tool's `execute()` back-fills from the invoice.

## Why this is a real eval and not a tautology

The honest objection to grading an agent that has a deterministic offline mode is:
*aren't you just testing that the Fake matches the labels?* Here is the precise
answer.

The pipeline under test is **real, non-trivial logic**:

```
raw invoice → normalize (alias keys, "€ 2.500,00", EU decimals, inferred totals)
            → validate  (R1 amount sanity · R2 required fields · R3 tax reconcile · R4 line items)
            → recall    (embed + cosine ANN over persistent memory, filtered by vendor)
            → detect    (R5 duplicate · R6 amount anomaly — memory-grounded)
            → computeSignals → Qwen function-calling → one tool
```

Everything up to `computeSignals` is genuine work, and the eval grades that whole
path against a **semantic label**. When scenario `s10` (`{ amount: "€ 2.500,00",
… }`, no vendor, no reference) must resolve to `draft_vendor_reply`, we are
verifying that messy-input normalization + structural validation actually produce
`missing_fields=true` and route correctly — a chain that can regress.

Only the **final `signals → tool` link** is deterministic under the offline Fake
(`fake-chat.ts` mirrors the decision precedence). So:

- **Offline is a policy / regression guard**, not a decision-quality claim. It
  proves the real pipeline still turns each situation into the intended signals and
  the intended safe action. It is deterministic, so it never flakes.
- **Online is the decision-quality number.** With a key, `qwen-plus` reads the full
  invoice + findings + recalled history and **chooses freely** — no signal-to-tool
  lookup. Grading *that* against the same labels measures whether the model makes the
  call a human would. That is the number the live run captures.

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

## The one miss, reported not hidden (`s22`)

Offline accuracy is **21 / 22**, not a suspicious 22 / 22, and the miss is
instructive. `s22` is an invoice whose amount cannot be parsed (`amount: "see
attached"`, no subtotal/tax) — **no payable total** (validation rule R1 fails). A
human clerk would query the vendor (`draft_vendor_reply`). The deterministic policy
misses it: `computeSignals` only branches on missing-required-fields, reconcile,
duplicate, and anomaly — it has **no signal for R1** — so the invoice falls through
to `draft_journal_entry`.

We keep this scenario, labelled with the business-correct action, and **let it
fail** offline, because:

1. It proves the eval has teeth — it *can* fail, so a green run means something.
2. It is a concrete, honest limitation of the deterministic floor and a clear
   candidate improvement (add an R1 signal).
3. It is exactly the kind of context-reading judgement we expect **live `qwen-plus`
   to get right** where the fixed policy does not — a case where the LLM should beat
   the deterministic floor. The live run will show whether it does.

This mirrors the Track-1 benchmark's honesty about its single grounding miss: we
report the number that falls out, not the one we'd like.

## The CI gate (what we actually enforce)

CI runs `npm run eval -- --gate` on every push, with **no `DASHSCOPE_API_KEY`**, so
the deterministic Fakes drive it. The gate is set to the **measured** floor, not an
aspiration:

> **tool-choice accuracy ≥ 90%** (measured: 95.5%).

The floor sits at the measured value less the one documented known-limitation, so CI
catches a *real* regression in the intake→signals→tool pipeline without pretending
the deterministic policy is perfect. We deliberately **do not gate arg-sanity** (the
Fake omits some args by design) and **do not gate the online number** (it needs a
key and costs spend; it is captured and reported, not enforced).

## Reproduce

```bash
npm ci
npm run eval            # offline: replays the deterministic pipeline, prints 21/22
npm run eval -- --gate  # offline CI gate: accuracy ≥ 90%
# live decision-quality number (needs a DashScope key, a few cents):
cp .env.example .env    # set DASHSCOPE_API_KEY
DASHSCOPE_API_KEY=sk-... npm run eval   # header self-labels ONLINE; grades real qwen-plus
```

**Scope, owned:** 22 scenarios on a frozen labelled set — a small, honest eval,
exactly like the Track-1 retrieval benchmark's 15 queries. It measures *this*
decider on *these* situations; it is not a general decision-quality claim. The
offline grade is reproducible with zero credentials and zero spend; the online grade
is a single keyed run over the same labels.
