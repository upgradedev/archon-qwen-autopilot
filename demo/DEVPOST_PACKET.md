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
| `[ACTIVE_REVIEWER_TOKEN]` | Only a confirmed non-public judges-only testing field or organizer-approved secure channel |
| `[OPTIONAL_ACCESS_CONTACT]` | Only a confirmed non-public judges-only testing field; otherwise omit and use an organizer-approved secure channel |
| Exact deployed runtime SHA `030950e9b1e2353ee64f422ad050feb9733745bc` | Sanitized Alibaba proof + runtime release record; already resolved and must not be relabelled |
| `[CAPTURE_SOURCE_HEAD]` | `CAPTURE_REVIEW.json` + sanitized Alibaba proof; resolve from the clean public `origin/main` used for capture |
| `[FINAL_SUBMISSION_SHA]` | Final link/CI verification record |
| `[FINAL_CI_RUN_URL]` | Engineering-proof caption or supporting link |
| `[FINAL_CODEQL_AND_IMAGE_SCAN_URLS]` | Engineering-proof caption or supporting link |

Do not press **Submit project** after completing the draft. Stop on the final review
page so a human can inspect every field and consent to the rules.

## 1 · Project identity

**Project name**

> Archon Autopilot — Human-Gated AP Agent

**Tagline / elevator pitch**

> Qwen reads invoices, recalls vendor history, and proposes an auditable action—then a structural human gate keeps money under human control.

**Track**

> Track 4 — Autopilot Agent

**Primary category / problem**

> Accounts payable · finance operations · human-in-the-loop workflow automation

**Technologies / built with**

> Qwen Cloud, qwen-plus, qwen-vl-max, text-embedding-v4, DashScope OpenAI-compatible API, TypeScript, Node.js, Fastify, PostgreSQL, pgvector, Model Context Protocol (MCP), Docker, Alibaba Cloud ECS

Keep this field product-only. Playwright, CodeQL, Syft, and Grype are retained
engineering evidence described in the testing/security sections; they are not product
technologies or Devpost **Built with** tags.

## 2 · Required public links and files

| Devpost requirement | Exact value |
|---|---|
| Public source repository | https://github.com/upgradedev/archon-qwen-autopilot |
| Open-source license | https://github.com/upgradedev/archon-qwen-autopilot/blob/main/LICENSE |
| Working project | https://autopilot.43.106.13.19.sslip.io |
| Alibaba/Qwen code proof | https://github.com/upgradedev/archon-qwen-autopilot/blob/main/src/qwen/client.ts |
| Architecture diagram link | https://github.com/upgradedev/archon-qwen-autopilot/blob/main/docs/judge-architecture.svg |
| Architecture gallery upload | `demo/final-media/judge-architecture.jpg` |
| Organizer deck (strict-union artifact) | If the organizer's separate Qwen flow requests a PPT/PDF, use `demo/deck/archon-autopilot-qwen-cloud-hackathon-deck.pptx` and the matching `.pdf` only after exact-release screenshots, layout review and hash verification; never upload a placeholder build. |
| Devpost project thumbnail | `demo/thumbnail.png` (1500×1000, 3:2) |
| Editable thumbnail source | `demo/thumbnail.svg` |
| Public demo video | `[PUBLIC_VIDEO_URL]` |
| Optional public build-journey post | `[PUBLIC_BLOG_OR_SOCIAL_URL]` |

At final draft time, add immutable evidence links for the exact submission commit:
`[FINAL_CI_RUN_URL]` and `[FINAL_CODEQL_AND_IMAGE_SCAN_URLS]`. A run for an earlier
commit is supporting history, not evidence for the final submission SHA.

## 3 · Short description

Use this only if Devpost exposes a separate short-summary field:

> Archon Autopilot turns an invoice into an auditable, memory-grounded proposal through a bounded Qwen function-calling loop. It handles ambiguous documents, recalls vendor history first, validates the finance fields, selects only the duplicate, variance, or context checks relevant to that invoice, and stops at a durable PENDING item. Only an authenticated human can approve, amend, reject, or recover an action; the model and four-tool MCP surface have no execution authority. Human corrections become evidence for later decisions, so a re-billed amount that was previously corrected down is escalated while a compliant control is not.

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

> The backend runs on Alibaba Cloud ECS behind public HTTPS. The linked client file demonstrates the DashScope-compatible Qwen base URL and model instantiation required by the rules. The sanitized gallery proof and public video separately show the recorded deployed runtime SHA, public health/readiness, an exercised embedding deep probe, a qwen-plus intake-to-PENDING canary, and a qwen-vl-max document extraction. Configuration alone is not presented as exercised-model evidence.

**What was built during the submission period**

> Not applicable — this is a new competition-period Track-4 product started 2026-07-04, after the 2026-05-26 submission-period start. It carries forward the Archon name and limited shared plumbing patterns from the separate MemoryAgent foundation (provider client, pgvector, health, and deployment conventions), not that entry's judged self-audit/resolution core. During the window we built the AP normalizer and validator, bounded Qwen tool loop, durable PENDING/approval state machine, correction feedback, AP sinks, narrower MCP/custom-skill surfaces, document intake, adversarial/evaluation suites, CI, submission artifacts, and Alibaba deployment. The two entries have separate repositories, demos, narratives, and track-specific functionality; shared context is disclosed rather than claimed as newly authored evidence.

**Multiple-entry uniqueness statement, if requested**

> This is a standalone Track-4 accounts-payable orchestration product. Its core is a business-workflow state machine: ambiguous invoice intake, bounded tool use, durable PENDING work, authenticated human decisions, exact-argument execution, uncertain-outcome recovery, and post-decision audit/feedback. Persistent vendor history is one read-only evidence adapter; it is not the product lifecycle or the submitted track objective. Shared Archon naming and limited provider/database/deployment plumbing are disclosed above; the MemoryAgent entry's self-audit/resolution core is not reused as this entry's judged functionality.

## 6 · Project thumbnail

Upload [`thumbnail.png`](thumbnail.png) as the Devpost project thumbnail. Its editable
source is [`thumbnail.svg`](thumbnail.svg). Rebuild and byte-check the canonical raster
with `node scripts/render-submission-assets.mjs --write` followed by `--check`.

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

1. `demo/gallery/autopilot-01-live-intake-pending.png` (1500×1000, no crop)
   - Caption: use the canonical, capture-safe wording in
     [`gallery/GALLERY_MANIFEST.md`](./gallery/GALLERY_MANIFEST.md): **On an original
     synthetic invoice, Qwen gathers evidence and the action stops at PENDING.**
   - Alt: **Archon Autopilot reviewer screen showing invoice extraction, a Qwen
     tool-and-observation trace, and a durable pending proposal.**
2. `demo/gallery/autopilot-02-human-amend-diff.png` (1500×1000, no crop)
   - Caption: **The authenticated reviewer amends the exact domain arguments; the
     decided view preserves the proposed-to-approved diff and execution outcome.**
   - Alt: **Human approval screen showing editable proposal arguments and the audited
     before-and-after amendment.**
3. `demo/gallery/autopilot-03-correction-learning.png` (1500×1000, no crop)
   - Caption: **A €5,000 re-bill above a human-corrected €3,000 amount is escalated;
     the compliant €3,000 control remains a payment proposal. No model weights change.**
   - Alt: **Side-by-side correction test in which only the non-compliant re-bill is
     routed to review.**
4. `demo/gallery/autopilot-04-security-pending.png` (1500×1000, no crop)
   - Caption: **Recognized hostile input is surfaced, while structural tool separation
     keeps the proposal PENDING behind the human gate. Universal detection is not claimed.**
   - Alt: **Prompt-injection warning beside a pending proposal and a model tool list
     without approval or execution verbs.**
5. `demo/gallery/autopilot-05-alibaba-qwen-proof.png` (1500×1000, no crop)
   - Caption: **Hash-bound safe crop from a genuine Alibaba ECS console capture,
     combined with exact-release identity, health/readiness, deep embedding probe,
     and exercised decision and vision model IDs.**
   - Alt: **Composite showing a sanitized genuine Alibaba ECS console crop, the
     deployed runtime SHA, green CI, readiness checks, and Qwen canary model
     identifiers without account, instance, address, resource, or credential data.**

Never upload a screenshot until the filename, pixels, metadata, visible model IDs,
and visible SHA all pass the final-media review.

Upload the canonical 16:9 `demo/final-media/judge-architecture.jpg` in Devpost's
separate required **Architecture Diagram** field, not as a substitute for one of the
no-crop 3:2 gallery files above.

## 8 · Testing instructions and credential channel

Paste the full block below only after the actual field is confirmed non-public and
judges-only. A label such as “Testing Instructions” is not proof of privacy. If that
visibility cannot be confirmed, omit the token and personal contact, keep the public
no-login preview path, and request an organizer-approved secure credential channel.
Replace bracketed values directly in Devpost; do not save them in Git.

> **Live app:** https://autopilot.43.106.13.19.sslip.io/
>
> **Reviewer token:** `[ACTIVE_REVIEWER_TOKEN]`
>
> Enter the token in the UI's **Judge reviewer token** control. Do not append it to a URL. Public intake intentionally returns an isolated, non-durable, redacted PREVIEW; the valid reviewer credential unlocks the durable PENDING queue and human decision controls.
>
> **Recommended 90-second test:**
> 1. Open the live URL and enter the reviewer token.
> 2. Use the bundled synthetic sample invoice in the document panel; extract it and process it through the reviewer flow.
> 3. Open the resulting PENDING card and expand **How the agent decided**. Verify that recall is first and validation is present; duplicate, variance, or context observations appear only when that invoice warrants them. Inspect the concise model rationale.
> 4. Amend a safe editable argument or reject the synthetic item. Open **Decided** to inspect the proposed-to-approved diff and result.
> 5. Use the guided correction-learning panel to compare the €5,000 re-bill with the €3,000 control.
> 6. Remove or reject any remaining synthetic PENDING item; do not use real vendor data.
>
> **Scope:** payment and specialist-review adapters are simulated. SMTP vendor reply and the fsynced append-only JSONL journal are configurable post-approval transports; UI success does not claim recipient delivery or a bank/ERP integration. The `22/22` result is a tuned developer-labelled deterministic regression, not live-Qwen accuracy.
>
> **Access help:** `[OPTIONAL_ACCESS_CONTACT — only in a confirmed non-public field]`

Before saving, inspect the resulting public preview logged out, then test the judge
flow in a signed-out browser with no cached token. If the token appears anywhere
public, rotate it before continuing. Keep the credential, database, TLS, Qwen quota,
and judge reserve active free of charge through **2026-08-11 2:00 PM PDT**.

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

### Actual Additional Info form map (verified 2026-07-16)

Values marked **human** must be confirmed by the entrant and entered directly; the
public repository intentionally does not guess or retain them.

| Actual Devpost field | Exact value / action |
|---|---|
| Submitter type | `[HUMAN CONFIRM: Individual / Team / Organization]` |
| Organization name | Leave blank only if the confirmed submitter type is Individual/Team and no organization applies. |
| Country of residence | `[HUMAN CONFIRM AND ENTER DIRECTLY]` — appears publicly in the gallery. |
| Newly built or previously existing | **New** — the distinct Track-4 repository starts 2026-07-04; retain the shared-plumbing disclosure. |
| Start date | **07-04-26** |
| Required pre-May-26/update explanation | Paste **What was built during the submission period** from section 5 verbatim. |
| Track | **Track 4: Autopilot Agent** |
| Code repository | <https://github.com/upgradedev/archon-qwen-autopilot> |
| Alibaba/Qwen code file | <https://github.com/upgradedev/archon-qwen-autopilot/blob/main/src/qwen/client.ts> |
| Architecture Diagram upload | [`final-media/judge-architecture.jpg`](./final-media/judge-architecture.jpg) |
| Alibaba Deployment Screenshot upload | [`gallery/autopilot-05-alibaba-qwen-proof.png`](./gallery/autopilot-05-alibaba-qwen-proof.png), only after tracked [`gallery/CAPTURE_REVIEW.json`](./gallery/CAPTURE_REVIEW.json) passes, proves zero matching PENDING capture residue (audit history remains), and its SHA-256 matches the upload. |
| Published Blog or Social Post | `[PUBLIC_BLOG_OR_SOCIAL_URL]`, only after signed-out verification. |
| AI tools leveraged | **Qwen Cloud models (qwen-plus, qwen-vl-max, text-embedding-v4), OpenAI Codex, and Anthropic Claude.** |
| Learning level | **Significant** |
| Age-of-majority attestation | `[HUMAN LEGAL ATTESTATION REQUIRED]` |
| Eligible-jurisdiction attestation | `[HUMAN LEGAL ATTESTATION REQUIRED]` |
| Sponsor/affiliate/government-employment attestation | `[HUMAN LEGAL ATTESTATION REQUIRED]` |
| Testing Instructions | Paste section 8. Add the token/contact only if the field is confirmed non-public and judges-only after exact-deploy canaries pass; otherwise retain the public preview path and use an organizer-approved secure channel. |

- [ ] Project name, tagline, Track 4, English description, and story render correctly.
- [ ] Repository is Public and Devpost/GitHub visibly detects MIT in the repository
  About/header area.
- [ ] Alibaba proof links directly to `src/qwen/client.ts`.
- [ ] Architecture is both uploaded and linked.
- [ ] Final PPTX/PDF deck reviewed and supplied if the organizer's separate Qwen flow requests it.
- [ ] `demo/thumbnail.png` is uploaded as the project thumbnail and remains legible in
  Devpost's card/grid preview without cropping the title, workflow, or Human Gate.
- [ ] Final video is public, signed-out accessible, and `<3:00`.
- [ ] Working app and private tester flow pass signed out.
- [ ] Gallery contains only fresh sanitized current-release captures.
- [ ] `demo/gallery/CAPTURE_REVIEW.json` is tracked, `status=passed`, binds the exact
  deployed runtime SHA and clean public capture-source HEAD, records
  `pendingCleanupZero=true` with
  zero matching **PENDING** capture residue (not zero audit history), and hashes every
  uploaded current-release PNG.
- [ ] Deployed runtime SHA `030950e9b1e2353ee64f422ad050feb9733745bc`,
  `[CAPTURE_SOURCE_HEAD]`, and `[FINAL_SUBMISSION_SHA]` are labelled separately. No
  later docs/media commit is described as the running runtime.
- [ ] Exact final CI, CodeQL, and image/SBOM runs are green for the submission SHA.
- [ ] Blog/social URL works publicly if entered.
- [ ] No unresolved bracketed placeholder remains in any Devpost field.
- [ ] [`RIGHTS_ELIGIBILITY_SIGNOFF.md`](RIGHTS_ELIGIBILITY_SIGNOFF.md) is completed by
  the entrant or authorized representative.
- [ ] All links and media were reviewed once more on the Devpost preview page.
- [ ] The draft is saved.
- [ ] **STOP: do not press Submit project.**
