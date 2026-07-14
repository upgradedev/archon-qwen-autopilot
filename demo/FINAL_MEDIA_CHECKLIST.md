# Final media + submission checklist

All automatable engineering checks are green. What remains requires a human browser,
recording voice, public hosting, or publication account. Never show the reviewer token,
`.env`, terminal history containing credentials, cloud keys, or a real vendor address.

## 1 · Capture these fresh screenshots

Use a clean browser profile at 1440×900 or larger, 100% zoom, no bookmarks/personal
tabs, and a seeded demo-only tenant. Crop tightly but leave the live HTTPS hostname
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
- [ ] **Injection visibility:** recognized attack banner + located match while the
  proposal remains PENDING. Avoid wording that claims universal detection.
- [ ] **Duplicate safety:** second intake of the same business invoice routed to
  `flag_for_review`.
- [ ] **Engineering proof:** terminal crop of the exact final summary (240 pass, 6
  DB-gated skips; 25/25 Playwright; 30/30 adversarial; readiness 22/0/3).
- [ ] **Architecture:** use `docs/architecture.png` directly at full resolution; do not
  screenshot the README thumbnail.
- [ ] **Alibaba proof:** live `/ready` response after final redeploy, with no secret
  values; keep the existing Alibaba proof recording only if it matches the final app.

Store selected images under `demo/final-media/` with descriptive names and verify no
metadata or pixels reveal credentials.

## 2 · Refresh the <3-minute video

The current 21-beat structure is strong. Refresh only the facts that changed and the
screens that must prove the final build.

- [ ] Beat 12 says **two real configurable sinks**: SMTP vendor reply + restart-safe,
  durable JSONL ledger; payment/review remain simulated.
- [ ] Beat 14 says **22/22 offline policy eval, average 2.5 autonomous steps** and does
  not present that deterministic number as live-Qwen accuracy.
- [ ] Auth is visible as a human boundary, but the private token is never visible.
- [ ] Show at least one live Qwen trace, one PENDING card, one human amendment, one
  recognized injection warning, and one duplicate result.
- [ ] MCP beat says **four proposal/read-only tools** and explicitly shows that
  approve/amend/reject/recover are absent; authenticated HTTP/UI is the only decision
  surface.
- [ ] Show the architecture long enough to read the public-intake/Bearer-reviewer and
  PENDING→human-gate→real-sinks flow.
- [ ] End card contains project name, Track 4, public repository, live HTTPS URL, Qwen
  models, MIT license, and the strongest measured evidence.
- [ ] Rebuild from `scripts/make_frames.py` / `scripts/build_video.py`; confirm generated
  narration and scene text contain `2.5` and “two configurable sinks.”
- [ ] Watch the rendered MP4 from beginning to end with headphones; no clipped audio,
  unreadable overlays, blank frames, stale numbers, token flashes, or silent ending.
- [ ] Verify duration with `ffprobe` and keep a safety margin below **180 seconds**.
- [ ] Host on a public, judges-accessible page (YouTube unlisted is acceptable if
  public-by-link); test playback signed out/incognito with captions enabled.
- [ ] Replace the repository draft MP4 only after the final render is approved, then
  use the hosted URL—not a repository blob—as the Devpost video URL.

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
