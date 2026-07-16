# Final media + submission checklist

The public-main engineering gates and exact-current-source release proof are green;
the media/publication steps below remain human-gated. Never show the reviewer token,
`.env`, terminal history containing credentials, cloud keys, or a real vendor address.

Run [`BUILD_RECORDING.md`](BUILD_RECORDING.md) first, then follow the canonical
real-motion pipeline in [`REAL_MOTION_VIDEO.md`](REAL_MOTION_VIDEO.md) and the concise
operator sheet in [`VIDEO_RECORDING_CHECKLIST.md`](VIDEO_RECORDING_CHECKLIST.md).
Exact application release
`203f159df25f825a0b994a2f8a4d2c0892b45390` passed project-contained attempt 23 on
2026-07-16, including the singleton runtime-env contract, staging/final readiness,
real-Qwen PENDING canary, and zero-residue cleanup. Bind all final media to that
evidence. A later documentation/media-only submission HEAD may differ, but the
deployed application SHA and submission SHA must be labelled separately.
Recheck the [official rules](https://qwencloud-hackathon.devpost.com/rules) immediately
before submission; this pack was reconciled to them on 2026-07-16.

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
- [ ] **Agent trace:** a PENDING proposal with “How the agent decided” expanded so
  the exact relevant read/analyze subset selected in that run is legible. It must
  start with recall, include validation, and contain no terminal/decision tool;
  duplicate and variance remain visible in the architecture/catalog and appear in
  the trace only when the evidence warrants them.
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
- [ ] **Alibaba proof:** provide a fresh genuine console PNG from the shared Alibaba
  ECS host under ignored `demo/.private-captures/`; the capture tool must apply the
  tracked safe-crop profile and bind both hashes in `CAPTURE_REVIEW.json`. Bind that
  host context to Autopilot-specific exact-deploy markers, public network-free
  `/health` + `/ready`, authenticated/metered `/ready/deep`, one actual decider
  canary, and one document extraction. Keep token, account, instance, address, and
  resource identifiers out of every promoted pixel.

Store untouched private masters under ignored `demo/private-originals/`, working
captures under ignored `demo/.private-captures/`, and build scratch under ignored
`.artifacts/`. Store selected sanitized finals under tracked `demo/final-media/` with
descriptive names. Strip metadata and verify no pixels reveal credentials. Never use
OS temp folders for project media.

## 2 · Refresh the <3-minute video

Follow the nine judge-first beats in [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md). No final
MP4 is tracked yet; the obsolete `demo/video/assets/ui_*.png` captures were removed
because they predated the final authenticated UI and were not approved evidence.
After rendering, use [`VIDEO_PUBLICATION_PACKET.md`](VIDEO_PUBLICATION_PACKET.md) for
the public title, bounded description, measured chapters, captions, thumbnail, and
signed-out publication checks.

- [ ] Show **two real configurable sinks**: SMTP vendor reply + restart-safe,
  durable JSONL ledger; payment/review remain simulated.
- [ ] Say **22/22 tuned developer-labelled offline regression**, never live-Qwen
  accuracy. The video uses the committed fixed 12-case modeled workflow evidence and
  16 vision fixtures; no candidate was promoted, and no historical/raw-Qwen keyed
  comparison is a submission claim.
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
- [ ] Require tracked `demo/gallery/CAPTURE_REVIEW.json` to say `status: passed`,
  identify the exact deployed application SHA and public source HEAD at capture,
  record the exercised models/workflows, set both `pendingCleanupZero=true` flags with
  zero matching PENDING capture residue (rejected audit history remains), and match
  every uploaded PNG's hash, dimensions, RGB
  mode, and empty metadata-key list. A missing/stale manifest blocks publication.
- [ ] Run `record-live-motion.cjs` against the public isolated preview, then
  `build-real-motion-submission.py` with exact SHA
  `203f159df25f825a0b994a2f8a4d2c0892b45390` and `--replace`. The one-command
  builder creates a rights-safe caption-only base internally and reads only the
  explicitly promoted captures under `demo/final-media/`.
- [ ] If the label contains `qwen3.7`, set `VIDEO_PROMOTION_EVIDENCE` to the exact
  repo-contained counterbalanced artifact and confirm it says `promotion-pass`.
- [ ] Require the real-motion builder's internal `CAPTION_ONLY=true` base: fixed
  168-second/30-fps beat windows, burned captions, measured English SRT, and locally
  generated digital silence—no TTS or third-party music.
- [ ] Watch the rendered MP4 from beginning to end with headphones and muted. In
  caption-only mode, require intentional silence and no unexpected sound; in
  narrated mode, require no clipped audio, silent ending, or drift. In either mode,
  reject unreadable overlays, blank frames, stale numbers, or token flashes.
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
- [ ] Retain and verify `autopilot-demo.en.srt`,
  `autopilot-demo.real-motion.json`, and `autopilot-demo.qa.json`; run
  `python demo/media-tools/compose_real_motion_video.py --verify-only` and require
  the recorded MP4/SRT/thumbnail/evidence hashes, nine cues, rights profile, genuine
  frame diversity, 1080p stream contract, and `<175s` duration to match.

## 3 · Publish one supplied post

- [ ] Prefer the full [`BLOG.md`](BLOG.md) route and follow
  [`BLOG_PUBLICATION_CHECKLIST.md`](BLOG_PUBLICATION_CHECKLIST.md) for the optional
  bonus judged on thoroughness and potential impact.
- [ ] Follow the operator-only [`POST_PUBLICATION_CHECKLIST.md`](POST_PUBLICATION_CHECKLIST.md),
  then copy only one fenced public draft from [`POST_DRAFTS.md`](POST_DRAFTS.md).
- [ ] Attach the hero, trace, and architecture images (no secrets).
- [ ] Keep the exact scope: offline policy eval, two configurable real transports,
  simulated payment/review, pattern-based advisory scanner.
- [ ] Publish from the intended account and save the public URL.
- [ ] Open the URL incognito and verify images, line breaks, links, and alt text.

## 4 · Assemble Devpost

- [ ] Open [`DEVPOST_PACKET.md`](DEVPOST_PACKET.md) and resolve only its human-owned
  placeholders directly in the draft/publication accounts.
- [ ] Upload the original 1500×1000 `demo/thumbnail.png` and inspect Devpost's small
  card/grid crop; the title, Qwen workflow, and Human Gate must stay legible.
- [ ] Select **Track 4 — Autopilot Agent**.
- [ ] Keep **Built with** product-only: Qwen/model APIs, application runtime,
  persistence, MCP, Docker, and Alibaba Cloud belong there; Playwright, CodeQL, Syft,
  and Grype belong in engineering evidence, not tags.
- [ ] Paste [`SUBMISSION.md`](SUBMISSION.md) / [`PROJECT_STORY.md`](PROJECT_STORY.md)
  into the matching fields and remove Markdown that Devpost does not render.
- [ ] Add the public GitHub repository and confirm the MIT license is visible.
- [ ] Confirm GitHub identifies the repository as **Public** and detects **MIT** in
  the repository About/header area, as required by the rules.
- [ ] Add the live Alibaba HTTPS URL, architecture image, Alibaba/Qwen code proof, and
  final public video URL.
- [ ] If a separate Qwen submission flow requests PPT/PDF, attach the reviewed final
  `demo/deck/archon-autopilot-qwen-cloud-hackathon-deck.pptx` and matching PDF; never
  upload a placeholder build.
- [ ] Put the reviewer Bearer token only in a field confirmed non-public and
  judges-only. If visibility is uncertain, omit it and use an organizer-approved
  secure channel; inspect the saved public preview logged out and rotate on exposure.
- [ ] Add the optional public post URL.
- [ ] Test every link and the full judge flow in a signed-out/incognito window.
- [ ] Re-hash the uploaded gallery files against `demo/gallery/CAPTURE_REVIEW.json`;
  do not accept a capture run that exited nonzero or required manual partial-file repair.
- [ ] Complete [`RIGHTS_ELIGIBILITY_SIGNOFF.md`](RIGHTS_ELIGIBILITY_SIGNOFF.md) as the
  entrant or authorized representative; do not commit personal data or signatures.
- [ ] Keep the live app, TLS, active private reviewer credential, judge reserve,
  database, and Qwen quota free and available through the end of judging:
  **2026-08-11 2:00 PM PDT**.
- [ ] Save the complete draft before **2026-07-20 2:00 PM PDT**
  (**2026-07-21 00:00 Europe/Athens**), then stop on the final review page.
- [ ] **Do not press Submit project without the entrant's explicit final approval.**

## Final claim lock

Before publishing, search all visible copy and narration. Remove every legacy
test/coverage/step figure, outdated transport description, and universal
injection-detection claim. The authoritative wording is
[`../docs/CLAIM_EVIDENCE_MATRIX.md`](../docs/CLAIM_EVIDENCE_MATRIX.md).
