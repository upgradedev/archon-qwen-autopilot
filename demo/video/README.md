# Legacy video-builder inputs (not submission evidence)

This directory contains the reproducible narration/frame pipeline and historical
reference inputs. It contains **no approved final video**. Files under `assets/`
predate the final UI/security/evidence freeze and must not be presented to judges as
current screenshots or deployment proof.

The canonical shot list and claim lock are in
[`../VIDEO_SCRIPT.md`](../VIDEO_SCRIPT.md). Capture every live scene again from the
final deployed commit, store raw material only in ignored `demo/.private-captures/`
or `.artifacts/`, and place the reviewed sanitized render at:

```text
demo/final-media/autopilot-demo.mp4
```

Build locally only after the five sanitized live captures named in the final-media
checklist exist. The current renderer has exactly nine judge-first beats, requires
the final HTTPS URL and verified model IDs, and refuses every stale fallback. Use
Python 3.11, ffmpeg, and the reviewed hash-locked Pillow/edge-tts dependency graph
(or an authorized voice provider):

```bash
python -m pip install --require-hashes --only-binary=:all: -r demo/video/requirements.lock
python -m pip check
PUBLIC_APP_URL=https://FINAL-AUTOPILOT-HOST \
VIDEO_MODEL_LABEL='VERIFIED-DECIDER · VERIFIED-VISION' \
VOICE_RIGHTS_ATTESTED=true \
python scripts/build_video.py
```

`requirements.in` records the two reviewed direct versions; `requirements.lock`
pins every Python 3.11 transitive dependency and accepted distribution hash. Regenerate
the lock only as an explicit dependency-review change, never inside the render job.

Set `VIDEO_PROMOTION_EVIDENCE` to the repository-contained `promotion-pass` JSON
whenever `VIDEO_MODEL_LABEL` contains `qwen3.7`. Set the voice attestation only after
confirming public-use rights; otherwise use an owned human recording in the final edit.

Acceptance is human-owned: verify 1920×1080 H.264/AAC, captions, audio/video sync,
no blank lead-in, no credential or stale-count exposure, and duration below the
renderer’s 175-second publication safety limit. Then copy only the approved sanitized render into `demo/final-media/`,
publish it on a **Public**, unrestricted judges-accessible page, and use that hosted
URL in Devpost. See [`../FINAL_MEDIA_CHECKLIST.md`](../FINAL_MEDIA_CHECKLIST.md).
