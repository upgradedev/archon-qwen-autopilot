# Documentation and release-artifact map

This index defines the audience and lifecycle of every tracked Markdown file. It is
the canonical answer to “why is this file here?” and prevents operator runbooks from
being mistaken for submission copy or historical evidence from being mistaken for
the current release state.

Unchecked boxes in an **operator runbook** are reusable fail-closed gates. They are
not a live project-status dashboard. Current public URLs and Devpost assembly values
live only in [`../demo/DEVPOST_PACKET.md`](../demo/DEVPOST_PACKET.md); the skeptical
repository snapshot lives in
[`../demo/JUDGE_REVIEW.md`](../demo/JUDGE_REVIEW.md).

## Judge-facing entry points

| File | Purpose |
|---|---|
| [`../README.md`](../README.md) | Product overview, architecture, quickstart, evidence, and rubric map. |
| [`JUDGE-GUIDE.md`](JUDGE-GUIDE.md) | Five-minute verification route for a judge. |
| [`CLAIM_EVIDENCE_MATRIX.md`](CLAIM_EVIDENCE_MATRIX.md) | Canonical claim-to-code/test/evidence boundaries. |
| [`../SECURITY.md`](../SECURITY.md) | Security policy, threat boundaries, and honest limitations. |
| [`../EVAL.md`](../EVAL.md) | Decision-evaluation protocol and interpretation. |
| [`IMPACT_STUDY.md`](IMPACT_STUDY.md) | Bounded synthetic workflow-impact method. |

## Technical evidence and operations

| File | Audience and lifecycle |
|---|---|
| [`MODEL_PROMOTION.md`](MODEL_PROMOTION.md) | Frozen, fail-closed model-promotion protocol; technical evidence. |
| [`SUPPLY_CHAIN.md`](SUPPLY_CHAIN.md) | Reproducible build, image, SBOM, and dependency controls. |
| [`../deploy/DEPLOY_STATE.md`](../deploy/DEPLOY_STATE.md) | Machine-oriented deployed-runtime identity and release evidence. |
| [`../deploy/DEPLOY_NOTE.md`](../deploy/DEPLOY_NOTE.md) | Human deployment/redeployment procedure. |
| [`../eval/results/README.md`](../eval/results/README.md) | Captured online-evaluation artifact contract. |
| [`../eval/vision/LICENSE.md`](../eval/vision/LICENSE.md) | Synthetic vision-fixture provenance and license. |
| [`../impact/RESULTS.md`](../impact/RESULTS.md) | Generated impact results; do not hand-edit. |
| [`../load/README.md`](../load/README.md) | Reproducible k6 load-tier procedure and boundaries. |
| [`../load/RESULTS_2026-07-15.md`](../load/RESULTS_2026-07-15.md) | Immutable hosted offline-ramp evidence. |

## Public submission-copy sources

These are paste/render sources. Internal instructions must not be copied into public
fields unless the file explicitly supplies a fenced public block.

| File | Destination |
|---|---|
| [`../demo/PROJECT_STORY.md`](../demo/PROJECT_STORY.md) | Devpost story sections. |
| [`../demo/SUBMISSION.md`](../demo/SUBMISSION.md) | Single-field Devpost description. |
| [`../demo/BLOG.md`](../demo/BLOG.md) | Long-form public build article. |
| [`../demo/POST_DRAFTS.md`](../demo/POST_DRAFTS.md) | Destination-specific fenced public snippets. |
| [`../demo/VIDEO_PUBLICATION_PACKET.md`](../demo/VIDEO_PUBLICATION_PACKET.md) | Public video title, description, chapters, and acceptance checks. |
| [`../demo/DEVPOST_PACKET.md`](../demo/DEVPOST_PACKET.md) | Canonical field map, public URLs, captions, and draft-only stop gate. |

## Internal release and rights runbooks

These files are intentionally tracked because they encode safety, reproducibility,
rights, or release gates. Their checklist state is not a public readiness claim.

| File | Purpose |
|---|---|
| [`../demo/JUDGE_REVIEW.md`](../demo/JUDGE_REVIEW.md) | Internal evidence-first release snapshot; never submission copy. |
| [`../demo/BUILD_RECORDING.md`](../demo/BUILD_RECORDING.md) | Exact release and Alibaba/Qwen proof runbook. |
| [`../demo/FINAL_MEDIA_CHECKLIST.md`](../demo/FINAL_MEDIA_CHECKLIST.md) | End-to-end media/submission gate. |
| [`../demo/VIDEO_RECORDING_CHECKLIST.md`](../demo/VIDEO_RECORDING_CHECKLIST.md) | Capture and playback acceptance run sheet. |
| [`../demo/VIDEO_SCRIPT.md`](../demo/VIDEO_SCRIPT.md) | Measured nine-beat edit plan. |
| [`../demo/REAL_MOTION_VIDEO.md`](../demo/REAL_MOTION_VIDEO.md) | Deterministic real-motion build and QA contract. |
| [`../demo/BLOG_PUBLICATION_CHECKLIST.md`](../demo/BLOG_PUBLICATION_CHECKLIST.md) | Long-form publication verification. |
| [`../demo/POST_PUBLICATION_CHECKLIST.md`](../demo/POST_PUBLICATION_CHECKLIST.md) | Operator-only public-post verification. |
| [`../demo/RIGHTS_ELIGIBILITY_SIGNOFF.md`](../demo/RIGHTS_ELIGIBILITY_SIGNOFF.md) | Entrant-owned legal/rights attestations; never store personal signatures. |

## Media-pipeline documentation

| File | Purpose |
|---|---|
| [`../demo/final-media/README.md`](../demo/final-media/README.md) | Canonical promoted media inventory and hash/QA boundaries. |
| [`../demo/gallery/GALLERY_MANIFEST.md`](../demo/gallery/GALLERY_MANIFEST.md) | Devpost gallery order, captions, dimensions, and hashes. |
| [`../demo/media-tools/README.md`](../demo/media-tools/README.md) | Capture, sanitization, promotion, and cleanup pipeline. |
| [`../demo/video/README.md`](../demo/video/README.md) | Still-used intermediate caption-base inputs; explicitly not submission evidence. |

## Canonical asset policy

- `docs/judge-architecture.svg` is the sole architecture source shown to judges;
  `demo/final-media/judge-architecture.jpg` is its metadata-sanitized upload raster.
- `demo/final-media/` contains only promoted, hash-reviewed final media.
- `demo/gallery/` contains the no-crop Devpost derivatives and their capture review.
- `demo/deck/` contains the reviewed PPTX/PDF organizer packet.
- `demo/video/` remains because the final compositor consumes its caption-base inputs;
  its README prevents those intermediates from being presented as evidence.
- `eval/`, `impact/`, and `load/` retain raw/generated artifacts required to reproduce
  claims. They are evidence, not duplicate marketing copy.

Legacy `docs/architecture.*` assets and the orphaned dated judge-state memo were
removed after repository-wide reference checks. The documentation fitness tests fail
if either legacy surface returns, if local Markdown links break, if public URLs drift,
or if avoidable price/spend rhetoric or numeric-currency storytelling re-enters the
public submission-copy sources.
