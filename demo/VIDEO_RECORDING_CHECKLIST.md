# Final video recording run sheet

Use this short run sheet at recording time. The exhaustive artifact/publication list
remains [`FINAL_MEDIA_CHECKLIST.md`](FINAL_MEDIA_CHECKLIST.md); exact release and model
proof is defined by [`BUILD_RECORDING.md`](BUILD_RECORDING.md); narration and timing
are locked in [`VIDEO_SCRIPT.md`](VIDEO_SCRIPT.md).

## Stop/go gate before opening the recorder

- [ ] Exact application release and immutable CI are proven according to
  `BUILD_RECORDING.md`; the public hostname alone is not accepted as provenance.
- [ ] `/health`, `/ready`, private `/ready/deep`, decision canary, and vision canary
  all pass on the final deployment.
- [ ] Final labels are `qwen-plus` · `qwen-vl-max` · `text-embedding-v4`, unless a
  same-release `promotion-pass` artifact authorizes a different candidate label.
- [ ] A clean browser profile is at least 1440×900, 100% zoom, with personal tabs,
  bookmarks, autofill, extensions, notifications, and password-manager overlays off.
- [ ] Only synthetic vendors/invoices are present. Stale PENDING demo rows have been
  rejected/removed and the new vendor prefix is unique to this take.
- [ ] The reviewer token field uses password masking and will be cropped or blurred.
  The token, `.env`, terminal history, request headers, cloud IDs, and real addresses
  are outside the capture region.
- [ ] The five sanitized renderer inputs exist under `demo/final-media/` with their
  exact required names and have passed metadata/pixel review.
- [ ] Voice, fonts, architecture art, logos, music, and footage have public-use rights.

If any box fails, stop. Do not compensate with narration or an old capture.

## One-take judge story

Keep the final cut below 175 seconds. Record extra handles around each scene, but do
not add a tenth idea.

1. **Stakes / Track 4:** invoice ambiguity, duplicate/overbill risk, human money
   boundary.
2. **Architecture:** public PREVIEW differs from reviewer PENDING; Qwen proposes and
   the authenticated human decides.
3. **Live document → PENDING:** show actual vision ID, streamed recall/validate/
   duplicate/variance observations, concise rationale, exact proposal, no execution.
4. **Exact human control:** amend typed arguments, approve, then show proposed→approved
   diff and the configured JSONL outcome. State atomic claim and explicit uncertain
   recovery.
5. **Correction signal:** €3,000 baseline → human-corrected €5,000 overbill → €5,000
   re-bill review, with €3,000 negative control still a payment proposal.
6. **Evidence:** `22/22` tuned developer-labelled deterministic regression, average
   `2.4` autonomous evidence steps (53/22, rounded), separate hash-bound live
   protocols, 16 original
   synthetic vision fixtures. Do not call any of these held-out or expert ground truth.
7. **Structural safety:** recognized warning, item still PENDING, model and four-tool
   MCP catalogs without approve/amend/reject/recover/pay/execute capability.
8. **Alibaba/Qwen proof:** exact application SHA, green CI, sanitized Alibaba context,
   health/readiness/deep readiness, exercised decision + vision IDs.
9. **Close:** live URL, public repo, MIT, Track 4, and the line “Bounded where judgment
   helps; deterministic and human-controlled where money moves.”

## Claim traps to catch during the take

- [ ] Say “tool/observation trace and concise model rationale,” never full reasoning
  or hidden chain-of-thought.
- [ ] Say “structurally blocks autonomous execution,” never detects/stops every prompt
  injection.
- [ ] Say “SMTP transport acceptance,” never delivered mailbox or recipient exactly
  once.
- [ ] Say “restart-safe JSONL ref dedupe,” not ERP or bank integration.
- [ ] Say payment/review proposals are simulated.
- [ ] Say public intake is non-durable preview; only valid reviewer/operator intake
  reaches durable PENDING.
- [ ] Show live A/B numbers only from a clean same-release artifact. A failed or
  incomplete promotion attempt is not a model-quality score.
- [ ] Do not call model confidence calibrated.
- [ ] Do not show another submission's hostname, repository, architecture, or cloud
  proof.

## Required renderer inputs

All selected assets must be sanitized and stored inside this repository:

```text
demo/final-media/judge-architecture.jpg
demo/final-media/autopilot-live-intake-pending.png
demo/final-media/autopilot-human-amend-diff.png
demo/final-media/autopilot-correction-learning.png
demo/final-media/autopilot-security-pending.png
demo/final-media/autopilot-alibaba-proof.png
```

Untouched masters belong only in ignored `demo/private-originals/`; working raw takes
belong in ignored `demo/.private-captures/` or `.artifacts/`. Do not overwrite a
reviewed final with a raw capture.

## Render and mechanical acceptance

From the exact submission checkout, use verified final labels:

```powershell
$env:PUBLIC_APP_URL='https://autopilot.43.106.13.19.sslip.io'
$env:VIDEO_MODEL_LABEL='qwen-plus · qwen-vl-max · text-embedding-v4'
$env:VOICE_RIGHTS_ATTESTED='true'
# Required only if the label contains qwen3.7:
# $env:VIDEO_PROMOTION_EVIDENCE='eval/results/<same-release-promotion-pass>.json'
python scripts/build_video.py
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 demo/final-media/autopilot-demo.mp4
```

- [ ] Renderer reports exactly `9 beats`; final is 1920×1080 H.264/AAC and `<175s`.
- [ ] Watch once with headphones and once muted with captions/overlays. There is no
  blank lead-in, clipped word, silent ending, desync, unreadable crop, or stale label.
- [ ] Scrub frame-by-frame around token entry, terminal/API proof, browser transitions,
  and end card. No secret or private identifier flashes for a single frame.
- [ ] Test the MP4 on a second device, then upload to YouTube, Vimeo, or Youku as
  **Public**. Test signed-out playback, captions, 1080p, and duration below 3:00.
- [ ] Use the public hosted URL in Devpost; do not use a GitHub blob or Actions artifact.
- [ ] Keep the reviewed MP4 at `demo/final-media/autopilot-demo.mp4` and all project
  scratch inside the repository.

## Final human sign-off

- [ ] A person who did not perform the edit can explain product, innovation, safety
  boundary, and evidence after one watch.
- [ ] Every visible number/model/SHA is supported by the exact release proof.
- [ ] Every submitted link works signed out and remains available through
  **2026-08-11 2:00 PM PDT**.
- [ ] Final video, screenshots, public post, and Devpost confirmation are copied into
  their designated repo-contained locations or recorded by URL in the submission
  account; no irreplaceable artifact exists only outside the project.
