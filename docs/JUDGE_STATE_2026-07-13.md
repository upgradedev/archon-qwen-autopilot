# Judge State — 2026-07-13

> **Purpose.** A durable snapshot of where Archon Autopilot stands against the
> Qwen (Alibaba Cloud) Hackathon judging bar, after the 2026-07-12/13 judgment
> pass and the three harmonization PRs it produced (#28, #29, #30). It records
> the current judged score per rubric criterion, the discrepancies those PRs
> fixed, and the ranked, still-open path to push the score **above the target
> bar (> 9.5 / 10)**.
>
> **Out of scope here (already done / user-owned submission mechanics).** The
> **demo video** is re-rendered and current, and the **blog / project story** are
> written and ready to submit — neither is a gap and neither is listed as an
> action below. Publishing to Devpost and the live-hosting console clicks are the
> user's submission step, not an engineering gap.

## 1 · Challenge + target

| | |
|---|---|
| **Challenge** | Alibaba Cloud / Qwen Hackathon — **Track 4 (Autopilot)** |
| **Deadline** | **2026-07-20, 2 PM PDT** |
| **Rubric** | Technical Depth & Engineering **30%** · Innovation & AI Creativity **30%** · Problem Value & Impact **25%** · Presentation & Documentation **15%** |
| **Target bar to exceed** | **> 9.5 / 10** |
| **Current judged score** | **~8.7 / 10** — lifted by the merged PRs #28–#30 (see §3) |

## 2 · Current judge score — per criterion

| Criterion (weight) | Score | Why |
|---|---|---|
| **Technical Depth & Engineering (30%)** | **9** | Bounded multi-step ReAct loop over `qwen-plus` function-calling (the agent picks its own next read/analyze tool each step: recall history → validate → check duplicate → compute variance, avg 2.3 autonomous steps before proposing one action); `qwen-vl-max` document vision on the intake path; a 7-tool MCP server + a 9-skill custom-skill catalog (5 autonomous / 4 human-gated); 186 `node:test` + 25 Playwright tests at 97.73% coverage (CI, with DB). |
| **Innovation & AI Creativity (30%)** | **8.5–9** | The human-in-the-loop money gate carries a **structural** tool-attack defense: the model-facing tool catalog contains only *proposing* tools, so the model literally cannot name `approve` / `amend` / `reject` / `pay`. A prompt-injection buried in an untrusted invoice — or in poisoned recalled memory — is therefore **inert by construction**, not by a filter. Plus the approval gate doubles as a **training signal**: human corrections at the gate are written back to pgvector as vendor memory for future recall. |
| **Problem Value & Impact (25%)** | **8–8.5** | Accounts-payable, end to end (messy incoming invoice → normalize → validate → triage → a *proposed* action — the real daily work of an AP clerk). Strong, but the one **real** terminal action (SMTP email) is currently **coded + tested**, not yet **demonstrated landing** on the live box — the biggest single lift available here (see §4). |
| **Presentation & Documentation (15%)** | **9** | README leads with the four differentiators; EVAL.md, demo BLOG and PROJECT_STORY all state a consistent **22/22**; the demo video is re-rendered (21 beats); an offline `docs-consistency` CI job pins README claims to the code. Devpost/hosting is the user's submission step. |

**Weighted center** lands at **~8.7**, consistent with the headline above.

## 3 · Discrepancies fixed this session (merged PRs)

All three verified merged to `main` on 2026-07-12.

| PR | Title | What it fixed |
|---|---|---|
| **[#28](https://github.com/upgradedev/archon-qwen-autopilot/pull/28)** | *reconcile eval number to truthful 22/22, correct test badge, lead README with differentiators* | Reconciled the eval to a truthful **22/22**, corrected the test badge, and re-led the README with the four differentiators. |
| **[#29](https://github.com/upgradedev/archon-qwen-autopilot/pull/29)** | *real SMTP email sink behind the human gate + poisoned-memory injection guarantee* | Added a **real SMTP email sink** (`src/ap/smtp-sink.ts`, nodemailer) reached only from the human-approval chokepoint. Delivery is **awaited**, so a failed send *propagates* to `approve()`/`amend()` and the work item stays **pending** for retry rather than being marked approved with no email sent. Added a **poisoned-memory injection test** (`tests/security/injection-poisoned-memory.test.ts`) proving the structural defense holds even when the attack is *recalled* from long-term memory. |
| **[#30](https://github.com/upgradedev/archon-qwen-autopilot/pull/30)** | *harmonize demo/docs to 22/22 + real-SMTP & poisoned-memory proofs; re-render 21-beat video* | Harmonized demo + docs to **22/22**, documented the real-SMTP and poisoned-memory proofs, and re-rendered the 21-beat video. |

**Net effect:** the eval is **22/22 everywhere**, and the prior **21/22-vs-22/22
self-contradiction is fully resolved** — no `21/22` remains in any tracked file
(only in local worktree scratch, which is not part of the repo).

## 4 · Path to exceed the target (> 9.5) — ranked

Excludes the video and the blog/post (both done — see the top note). Each item
is tagged **[CODE/buildable]** (this repo can ship it) or **[USER-only]** (needs
credentials / a deploy the agent cannot perform).

1. **[USER-only] Send ONE real email through the human gate on the live box** —
   *highest leverage.* This converts the SMTP sink from "coded + tested" into
   **demonstrated, not simulated** — a real terminal action a judge can watch
   land. It is the single biggest lift for the **Problem Value & Impact (25%)**
   axis. It is a short **dependency chain**, not a standalone step:
   1. **[USER-only] Redeploy the live box** so the SMTP-capable build (post-#29)
      is actually served. The live `deploy/DEPLOY_STATE.md` predates #29 (no
      `SMTP_*` env, no mail surface in its endpoint list), so the current live
      container does **not** yet serve the SMTP adapter — run `deploy/redeploy.sh`
      with the latest code.
   2. **[USER-only] Set the `SMTP_*` creds** in `/root/autopilot/.env`
      (`SMTP_HOST` · `SMTP_PORT` · `SMTP_SECURE` · `SMTP_USER` · `SMTP_PASS` ·
      `SMTP_FROM`) so `SmtpEmailSink.fromEnv()` builds a REAL transport.
   3. **[USER-only] Approve one `draft_vendor_reply`** in the live approval UI and
      confirm the email is delivered (the sink logs `delivered … (id …)`).
2. **[CODE/buildable] Add a 2nd real terminal sink** behind the same human gate —
   e.g. a ledger / payment-adapter that performs a genuine (sandbox) side-effect
   on approval. Broadens the "real actions, not simulations" story and
   strengthens both **Problem Value** and **Technical Depth**. Buildable in-repo
   with a Fake→Real seam identical to `SmtpEmailSink` (mode chosen by env), so
   the offline path stays a clean no-op.

> The redeploy in item 1(a) is also the gating prerequisite for any live demo of
> the current code — worth doing regardless of the email step.

## 5 · Verified-harmonized (no action needed)

- **Eval is 22/22 everywhere** — README, EVAL.md, demo BLOG, and PROJECT_STORY
  all agree; the 21/22-vs-22/22 contradiction is gone from every tracked file.
- **Test badge corrected** — README badge reads **186 node:test + 25 Playwright**,
  coverage **97.73% (CI, with DB)**.
- **README leads with the four differentiators** — ReAct loop over Qwen
  function-calling; `qwen-vl-max` intake vision; structural tool-attack defense at
  the money gate; the AP domain end to end.
- **Structural-defense proofs documented** — both the real-SMTP sink (awaited,
  fail-leaves-pending) and the poisoned-memory injection guarantee are in code and
  described in the docs; the `docs-consistency` CI job pins the security invariant
  (terminal actions excluded from the model catalog) to the code.
