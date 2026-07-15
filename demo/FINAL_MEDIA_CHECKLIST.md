# Final media + submission checklist

All automatable engineering checks are green. What remains requires a human browser,
recording voice, public hosting, or publication account. Never show the reviewer token,
`.env`, terminal history containing credentials, cloud keys, or a real vendor address.

## 1 · Capture these fresh screenshots

Use a clean browser profile at 1440×900 or larger, 100% zoom, no bookmarks/personal
tabs, and a uniquely prefixed synthetic demo vendor. Before capture, reject/remove
stale audit/demo PENDING items through authenticated reviewer actions so public spam
does not swamp the first queue view. Crop tightly but leave the live HTTPS hostname
visible in at least one shot.

- [ ] **Hero / overview:** upload panel + empty or seeded approval queue, with the
  reviewer token field blurred/empty.
- [ ] **Vision extraction:** bundled sample invoice beside the extracted structured
  fields, including source confidence and model id.
- [ ] **Agent trace:** a PENDING proposal with “How the agent decided” expanded so at
  least recall, validation, duplicate, and variance steps are legible.
- [ ] **Human gate:** proposed action and editable arguments with Approve / Amend /
  Reject visible; do not click until the recording is rolling.
- [ ] **Amend audit:** Decided view with proposed→approved argument diff and reviewer
  outcome.
- [ ] **Correction learning:** guided panel after all three explicit steps: €5,000
  re-bill → `flag_for_review`, €3,000 control → `draft_payment`.
- [ ] **Measured workflow evidence:** `/impact-metrics` panel, preserving its no-ROI disclaimer.
- [ ] **Injection visibility:** recognized attack banner + located match while the
  proposal remains PENDING. Avoid wording that claims universal detection.
- [ ] **Duplicate safety:** second intake of the same business invoice routed to
  `flag_for_review`.
- [ ] **Engineering proof:** terminal/Actions crop from the exact final submission
  commit showing Node + real-pgvector, Playwright, adversarial, readiness, coverage,
  secret-scan and dependency-audit outcomes. Never type totals from an older run.
- [ ] **Architecture:** use the 16:9 `docs/judge-architecture.svg` hero; keep the tall
  technical diagram only as secondary documentation.
- [ ] **Alibaba proof:** make a new Autopilot-only recording: ECS/deployment identity,
  public network-free `/health` + `/ready`, authenticated/metered `/ready/deep`, one
  actual decider canary and one document extraction. Keep the token hidden. Do not
  reuse a cross-entry proof clip.

Store raw/original captures only under ignored `demo/.private-captures/` or
`.artifacts/`. Store selected sanitized finals under tracked `demo/final-media/` with
descriptive names. Strip metadata and verify no pixels reveal credentials. Never use
OS temp folders for project media.

## 2 · Refresh the <3-minute video

Follow the nine judge-first beats in [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md). No final
MP4 is tracked yet; the obsolete `demo/video/assets/ui_*.png` captures were removed
because they predated the final authenticated UI and were not approved evidence.

- [ ] Show **two real configurable sinks**: SMTP vendor reply + restart-safe,
  durable JSONL ledger; payment/review remain simulated.
- [ ] Say **22/22 tuned developer-labelled offline regression**, never live-Qwen
  accuracy. Show keyed numbers only if clean committed three-run artifacts exist.
- [ ] Auth is visible as a human boundary, but the private token is never visible.
- [ ] Show at least one live Qwen trace, one PENDING card, one human amendment, one
  correction re-bill/control result, one recognized injection warning, and one duplicate result.
- [ ] MCP beat says **four proposal/read-only tools** and explicitly shows that
  approve/amend/reject/recover are absent; authenticated HTTP/UI is the only decision
  surface.
- [ ] Show the architecture long enough to read the public-intake/Bearer-reviewer and
  PENDING→human-gate→real-sinks flow.
- [ ] End card contains project name, Track 4, public repository, live HTTPS URL, Qwen
  models, MIT license, and the strongest measured evidence.
- [ ] Save the five required sanitized captures with these exact names:
  `autopilot-live-intake-pending.png`, `autopilot-human-amend-diff.png`,
  `autopilot-correction-learning.png`, `autopilot-security-pending.png`, and
  `autopilot-alibaba-proof.png` under `demo/final-media/`.
- [ ] Build with `PUBLIC_APP_URL` and `VIDEO_MODEL_LABEL` set to the verified final
  deployment/model IDs. The fail-closed nine-beat renderer must report `9 beats` and
  must read only the explicitly promoted captures under `demo/final-media/`.
- [ ] If the label contains `qwen3.7`, set `VIDEO_PROMOTION_EVIDENCE` to the exact
  repo-contained counterbalanced artifact and confirm it says `promotion-pass`.
- [ ] Set `VOICE_RIGHTS_ATTESTED=true` only after confirming that the chosen generated
  voice/service is licensed or otherwise authorized for this public competition use;
  otherwise record an owned human voiceover outside the TTS path.
- [ ] Watch the rendered MP4 from beginning to end with headphones; no clipped audio,
  unreadable overlays, blank frames, stale numbers, token flashes, or silent ending.
- [ ] Verify duration with `ffprobe`; the automated publication safety gate is
  **strictly below 175 seconds**, leaving margin below the contest's `<3:00` rule.
- [ ] Host on an accepted **YouTube, Vimeo, or Youku** page set to exact
  **Public visibility**, with no login or access request;
  test playback signed out/incognito with captions enabled and keep duration `<3:00`.
- [ ] Use only owned or properly licensed music, images, logos, fonts and footage.
  Confirm every competition/platform mark is permitted and retain license evidence;
  remove anything whose publication rights are unclear.
- [ ] Keep the reviewed render in `demo/final-media/`, then use its **Public hosted
  URL**—not a repository blob—as the Devpost video URL.

## 3 · Publish one supplied post

- [ ] Choose a draft from [`POST_DRAFTS.md`](POST_DRAFTS.md).
- [ ] Attach the hero, trace, and architecture images (no secrets).
- [ ] Keep the exact scope: offline policy eval, two configurable real transports,
  simulated payment/review, pattern-based advisory scanner.
- [ ] Publish from the intended account and save the public URL.
- [ ] Open the URL incognito and verify images, line breaks, links, and alt text.

## 4 · Assemble Devpost

- [ ] Select **Track 4 — Autopilot Agent**.
- [ ] Paste [`SUBMISSION.md`](SUBMISSION.md) / [`PROJECT_STORY.md`](PROJECT_STORY.md)
  into the matching fields and remove Markdown that Devpost does not render.
- [ ] Add the public GitHub repository and confirm the MIT license is visible.
- [ ] Add the live Alibaba HTTPS URL, architecture image, Alibaba/Qwen code proof, and
  final public video URL.
- [ ] Put the reviewer Bearer token only in Devpost's private testing instructions.
- [ ] Add the optional public post URL.
- [ ] Test every link and the full judge flow in a signed-out/incognito window.
- [ ] Submit before **2026-07-20 2:00 PM PDT** and save the confirmation screenshot.

## Final claim lock

Before publishing, search all visible copy and narration. Remove every legacy
test/coverage/step figure, outdated transport description, and universal
injection-detection claim. The authoritative wording is
[`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).
