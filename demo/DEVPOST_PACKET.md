# Archon Autopilot — Devpost draft packet

This file is the field-by-field assembly sheet for the Qwen Cloud Hackathon entry.
It is deliberately safe to commit: **never put the reviewer token, private contact
details, cloud identifiers, or unpublished account URLs in this file.** Paste those
values directly into the appropriate Devpost field at draft time.

Official-rules snapshot: 2026-07-16. Recheck the
[official rules](https://qwencloud-hackathon.devpost.com/rules) immediately before
submission. The hard deadline is **2026-07-20 2:00 PM PDT**
(**2026-07-21 00:00 Europe/Athens**). Judges may rely only on the description,
images, and video, so none of those surfaces may assume that a judge will run the app.

## Human-owned values that must remain unresolved in Git

Resolve these in the Devpost draft and publication accounts, not by inventing values:

| Value | Where it belongs |
|---|---|
| `[PUBLIC_VIDEO_URL]` | Devpost video field after signed-out playback succeeds |
| `[PUBLIC_BLOG_OR_SOCIAL_URL]` | Optional blog/social field after signed-out review |
| `[ACTIVE_REVIEWER_TOKEN]` | Devpost private testing instructions only |
| `[ACCESS_CONTACT]` | Devpost private testing instructions only |
| `[FINAL_DEPLOYED_APP_SHA]` | Sanitized Alibaba proof + final release record |
| `[FINAL_SUBMISSION_SHA]` | Final link/CI verification record |
| `[FINAL_CI_RUN_URL]` | Engineering-proof caption or supporting link |
| `[FINAL_CODEQL_AND_IMAGE_SCAN_URLS]` | Engineering-proof caption or supporting link |

Do not press **Submit project** after completing the draft. Stop on the final review
page so a human can inspect every field and consent to the rules.

## 1 · Project identity

**Project name**

> Archon Autopilot

**Tagline / elevator pitch**

> A correction-aware Qwen accounts-payable agent that gathers evidence and proposes actions, while a structural human gate keeps every money-moving decision under human control.

**Track**

> Track 4 — Autopilot Agent

**Primary category / problem**

> Accounts payable · finance operations · human-in-the-loop workflow automation

**Technologies / built with**

> Qwen Cloud, qwen-plus, qwen-vl-max, text-embedding-v4, DashScope OpenAI-compatible API, TypeScript, Node.js, Fastify, PostgreSQL, pgvector, Model Context Protocol (MCP), Docker, Alibaba Cloud ECS, Playwright, CodeQL, Syft, Grype

## 2 · Required public links and files

| Devpost requirement | Exact value |
|---|---|
| Public source repository | https://github.com/upgradedev/archon-qwen-autopilot |
| Open-source license | https://github.com/upgradedev/archon-qwen-autopilot/blob/main/LICENSE |
| Working project | https://autopilot.43.106.13.19.sslip.io |
| Alibaba/Qwen code proof | https://github.com/upgradedev/archon-qwen-autopilot/blob/main/src/qwen/client.ts |
| Architecture diagram link | https://github.com/upgradedev/archon-qwen-autopilot/blob/main/docs/judge-architecture.svg |
| Architecture gallery upload | `demo/final-media/judge-architecture.jpg` |
| Devpost project thumbnail | `demo/thumbnail.png` (1500×1000, 3:2) |
| Editable thumbnail source | `demo/thumbnail.svg` |
| Public demo video | `[PUBLIC_VIDEO_URL]` |
| Optional public build-journey post | `[PUBLIC_BLOG_OR_SOCIAL_URL]` |

At final draft time, add immutable evidence links for the exact submission commit:
`[FINAL_CI_RUN_URL]` and `[FINAL_CODEQL_AND_IMAGE_SCAN_URLS]`. A run for an earlier
commit is supporting history, not evidence for the final submission SHA.

## 3 · Short description

Use this only if Devpost exposes a separate short-summary field:

> Archon Autopilot turns an invoice into an auditable, memory-grounded proposal through a bounded Qwen function-calling loop. It handles ambiguous documents, recalls vendor history, checks duplicates and amount variance, and stops at a durable PENDING item. Only an authenticated human can approve, amend, reject, or recover an action; the model and four-tool MCP surface have no execution authority. Human corrections become evidence for later decisions, so a re-billed amount that was previously corrected down is escalated while a compliant control is not.

## 4 · Main description / project story

- If the form has one rich **Description** field, paste the body below the divider in
  [`SUBMISSION.md`](SUBMISSION.md).
- If the form exposes the standard Devpost story sections, paste the matching English
  sections from [`PROJECT_STORY.md`](PROJECT_STORY.md): **Inspiration**, **What it
  does**, **How we built it**, **Challenges we ran into**, **Accomplishments that
  we're proud of**, **What we learned**, and **What's next**.
- Keep the first visible paragraph and the differentiator above the fold. Do not put
  CI totals before the product story.
- Preview the rendered result. Repair broken lists, code fences, and relative image
  links before saving the draft.

## 5 · Paste-ready Qwen and Alibaba answers

**How Qwen Cloud is used**

> `qwen-plus` drives a bounded multi-step function-calling loop over five side-effect-free read/analyze skills and four terminal proposal skills. `qwen-vl-max` extracts uploaded PDF, PNG, and JPEG invoices before they enter the same workflow. `text-embedding-v4` grounds duplicate and amount-anomaly checks in persistent pgvector vendor history. A local stdio MCP surface exposes exactly four proposal/read tools and no decision or execution capability. All three model paths use the DashScope OpenAI-compatible endpoint implemented in `src/qwen/client.ts` and `src/qwen/vision.ts`.

**Proof of Alibaba Cloud deployment — required code link**

> https://github.com/upgradedev/archon-qwen-autopilot/blob/main/src/qwen/client.ts

**Deployment explanation, if a text field is available**

> The backend runs on Alibaba Cloud ECS behind public HTTPS. The linked client file demonstrates the DashScope-compatible Qwen base URL and model instantiation required by the rules. The sanitized gallery proof and public video separately show the recorded deployed application SHA, public health/readiness, an exercised embedding deep probe, a qwen-plus intake-to-PENDING canary, and a qwen-vl-max document extraction. Configuration alone is not presented as exercised-model evidence.

**What was built during the submission period**

> The repository's first commit is `8a6359f` from 2026-07-04, after the 2026-05-26 submission-period start. The Track-4 application — bounded agent loop, approval state machine, correction feedback, MCP/custom-skill surfaces, pgvector grounding, document intake, real configurable SMTP/JSONL transports, tests, deployment, and submission artifacts — was materially built during the eligibility window.

**Multiple-entry uniqueness statement, if requested**

> This is a standalone Track-4 accounts-payable orchestration product. Its core is a business-workflow state machine: ambiguous invoice intake, bounded tool use, durable PENDING work, authenticated human decisions, exact-argument execution, uncertain-outcome recovery, and post-decision audit/feedback. Persistent vendor history is one read-only evidence adapter; it is not the product lifecycle or the submitted track objective.

## 6 · Project thumbnail

Upload [`thumbnail.png`](thumbnail.png) as the Devpost project thumbnail. Its editable
source is [`thumbnail.svg`](thumbnail.svg).

- Canvas: exactly **1500×1000** pixels (**3:2**).
- Card-size message: **invoice → Qwen reads → recalls history → proposes → human gate**.
- Alt text: **Archon Autopilot workflow showing an untrusted invoice flowing through
  Qwen document reading, persistent vendor-history recall, a pending action proposal,
  and an authenticated human gate.**
- Rights/provenance: an original in-repository vector composed only from authored SVG
  geometry, text, gradients, and a system-font stack. It embeds no third-party image,
  logo, font, script, or remote resource and contains no metric or performance claim.

The PNG dimensions and the SVG's self-contained structure are gated in
`tests/docs/docs-consistency.test.ts`. Do not replace either file with an externally
sourced design unless the rights sign-off and the dimension check are repeated.

## 7 · Gallery order, captions, and alt text

Upload only reviewed, sanitized final files. Recommended order:

1. `autopilot-live-intake-pending.png`
   - Caption: **A real invoice becomes one auditable PENDING proposal after Qwen
     recalls, validates, checks duplicates, and computes variance. Nothing executes.**
   - Alt: **Archon Autopilot reviewer screen showing invoice extraction, a Qwen
     tool-and-observation trace, and a durable pending proposal.**
2. `autopilot-human-amend-diff.png`
   - Caption: **The authenticated reviewer amends the exact domain arguments; the
     decided view preserves the proposed-to-approved diff and execution outcome.**
   - Alt: **Human approval screen showing editable proposal arguments and the audited
     before-and-after amendment.**
3. `autopilot-correction-learning.png`
   - Caption: **A €5,000 re-bill above a human-corrected €3,000 amount is escalated;
     the compliant €3,000 control remains a payment proposal. No model weights change.**
   - Alt: **Side-by-side correction test in which only the non-compliant re-bill is
     routed to review.**
4. `autopilot-security-pending.png`
   - Caption: **Recognized hostile input is surfaced, while structural tool separation
     keeps the proposal PENDING behind the human gate. Universal detection is not claimed.**
   - Alt: **Prompt-injection warning beside a pending proposal and a model tool list
     without approval or execution verbs.**
5. `judge-architecture.jpg`
   - Caption: **Qwen handles bounded judgment; only the authenticated human surface
     can cross from proposal to post-approval effects.**
   - Alt: **Architecture from untrusted invoice through Qwen vision and a bounded
     function-calling loop to preview or pending, a human gate, sinks, and feedback.**
6. `autopilot-alibaba-proof.png`
   - Caption: **Sanitized exact-release proof: Alibaba deployment context,
     health/readiness, deep embedding probe, and exercised decision and vision model IDs.**
   - Alt: **Composite showing the deployed application SHA, green CI, Alibaba Cloud
     context, readiness checks, and Qwen canary model identifiers without secrets.**

Never upload a screenshot until the filename, pixels, metadata, visible model IDs,
and visible SHA all pass the final-media review.

## 8 · Private testing instructions

Paste this block only into the tester-only/private instructions field. Replace the
two bracketed values directly in Devpost; do not save them in Git.

> **Live app:** https://autopilot.43.106.13.19.sslip.io/
>
> **Reviewer token:** `[ACTIVE_REVIEWER_TOKEN]`
>
> Enter the token in the UI's **Judge reviewer token** control. Do not append it to a URL. Public intake intentionally returns an isolated, non-durable, redacted PREVIEW; the valid reviewer credential unlocks the durable PENDING queue and human decision controls.
>
> **Recommended 90-second test:**
> 1. Open the live URL and enter the reviewer token.
> 2. Use the bundled synthetic sample invoice in the document panel; extract it and process it through the reviewer flow.
> 3. Open the resulting PENDING card and expand **How the agent decided** to inspect recall, validation, duplicate, and variance observations plus the concise model rationale.
> 4. Amend a safe editable argument or reject the synthetic item. Open **Decided** to inspect the proposed-to-approved diff and result.
> 5. Use the guided correction-learning panel to compare the €5,000 re-bill with the €3,000 control.
> 6. Remove or reject any remaining synthetic PENDING item; do not use real vendor data.
>
> **Scope:** payment and specialist-review adapters are simulated. SMTP vendor reply and the fsynced append-only JSONL journal are configurable post-approval transports; UI success does not claim recipient delivery or a bank/ERP integration. The `22/22` result is a tuned developer-labelled deterministic regression, not live-Qwen accuracy.
>
> **Access help:** `[ACCESS_CONTACT]`

Before saving, test these instructions in a signed-out browser with no cached token.
Keep the credential, database, TLS, Qwen quota, and judge reserve active free of charge
through **2026-08-11 2:00 PM PDT**.

## 9 · Video and optional blog fields

**Video URL:** `[PUBLIC_VIDEO_URL]`

Follow [`VIDEO_PUBLICATION_PACKET.md`](VIDEO_PUBLICATION_PACKET.md). Acceptance before
paste: publicly visible on YouTube, Vimeo, or Youku; no login or
access request; below three minutes; 1080p works signed out; captions work; no secret
appears for even one frame; all visible functionality matches the final deployment.

**Blog/social URL:** `[PUBLIC_BLOG_OR_SOCIAL_URL]`

The blog/social field is optional for entry eligibility but required for consideration
for the Blog Post bonus. Prefer the full build-journey article in [`BLOG.md`](BLOG.md)
over a short post because the bonus is judged on thoroughness and potential impact.

## 10 · Final draft-only stop gate

- [ ] Project name, tagline, Track 4, English description, and story render correctly.
- [ ] Repository is Public and Devpost/GitHub visibly detects MIT in the repository
  About/header area.
- [ ] Alibaba proof links directly to `src/qwen/client.ts`.
- [ ] Architecture is both uploaded and linked.
- [ ] `demo/thumbnail.png` is uploaded as the project thumbnail and remains legible in
  Devpost's card/grid preview without cropping the title, workflow, or Human Gate.
- [ ] Final video is public, signed-out accessible, and `<3:00`.
- [ ] Working app and private tester flow pass signed out.
- [ ] Gallery contains only fresh sanitized current-release captures.
- [ ] `[FINAL_DEPLOYED_APP_SHA]` and `[FINAL_SUBMISSION_SHA]` are labelled separately
  if docs/media commits follow the deployed application release.
- [ ] Exact final CI, CodeQL, and image/SBOM runs are green for the submission SHA.
- [ ] Blog/social URL works publicly if entered.
- [ ] No unresolved bracketed placeholder remains in any Devpost field.
- [ ] [`RIGHTS_ELIGIBILITY_SIGNOFF.md`](RIGHTS_ELIGIBILITY_SIGNOFF.md) is completed by
  the entrant or authorized representative.
- [ ] All links and media were reviewed once more on the Devpost preview page.
- [ ] The draft is saved.
- [ ] **STOP: do not press Submit project.**
