# Sanitized final media only

Tracked Devpost-ready screenshots belong here after metadata/secret review. Untouched
private masters belong in ignored `demo/private-originals/`; working captures and
build scratch belong in ignored `demo/.private-captures/` or `.artifacts/`.
Obsolete pre-auth UI captures were removed; only explicitly promoted files in this
directory can become gallery evidence.

Final expected artifacts:

- `judge-architecture.jpg` — sanitized 1600×900 judge-facing architecture
  raster generated from `../../docs/judge-architecture.svg`; it distinguishes
  isolated public PREVIEW from durable reviewer PENDING and does not claim
  recipient-level exactly-once SMTP delivery.
- `autopilot-live-intake-pending.png` — final reviewer flow, Qwen tool/observation
  trace and durable PENDING proposal.
- `autopilot-human-amend-diff.png` — proposed→approved argument diff and decided result.
- `autopilot-correction-learning.png` — €5,000 re-bill and €3,000 control comparison.
- `autopilot-security-pending.png` — recognized hostile-input warning while the item
  remains PENDING behind the structural decision boundary.
- `autopilot-alibaba-proof.png` — sanitized app-specific deployment identity, public
  network-free `/health` + `/ready`, reviewer-authenticated/metered `/ready/deep`,
  actual decision/vision canaries and verified live model IDs; no credentials or
  administrative identifiers.
- `autopilot-demo.mp4` — reviewed nine-beat render below the 175-second publication
  safety limit. The hosted
  Public video URL, not this repository file, is used in Devpost.

## Reproducible authored-asset pass

The canonical thumbnail and architecture raster are maintained together:

```powershell
node scripts/render-submission-assets.mjs --write
node scripts/render-submission-assets.mjs --check
```

The script uses the lockfile-selected Playwright Chromium to render
`demo/thumbnail.svg` at exactly 1500×1000. It then removes EXIF/XMP/ICC/IPTC/comment
JPEG segments from `judge-architecture.jpg` without recompressing or changing its
entropy-coded image data. `--check` fails if the PNG differs from its SVG render or
the JPG still contains a removable metadata segment. If Chromium is not provisioned,
install the lockfile-selected browser with `PLAYWRIGHT_BROWSERS_PATH` pointed at an
ignored project-local `.artifacts/ms-playwright` directory; do not store submission
masters in that scratch directory.

These files do not exist until the **new exact-current-source** post-deploy capture
pass; never substitute historical release media or media from another entry.
