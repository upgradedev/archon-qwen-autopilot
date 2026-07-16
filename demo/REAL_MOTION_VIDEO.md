# Final real-motion submission video

This is the publication candidate path. It keeps the existing nine claim-locked,
caption-led beats, preserves the architecture for the first six seconds of the
00:13–00:28 product-boundary beat, and then places **genuine live browser
interaction** at 00:19–00:28. The footage shows the real isolated public preview:
Qwen streams the relevant side-effect-free evidence steps, the proposal is explicitly
non-durable, and no approve/amend/reject control exists. Nothing is uploaded or
published here.

Production capture is intentionally blocked until the exact deployment and
`demo/gallery/CAPTURE_REVIEW.json` both pass. The recorder never reads a reviewer
credential and requires the visible reviewer token field to remain blank.

## Deterministic offline acceptance

Run from the repository root before touching the live service:

```powershell
node --check demo/media-tools/record-live-motion.cjs
python -m py_compile demo/media-tools/compose_real_motion_video.py demo/media-tools/build-real-motion-submission.py
node demo/media-tools/record-live-motion.cjs --self-test
python demo/media-tools/compose_real_motion_video.py --self-test
```

The self-tests create only ignored, unmistakably labelled fixture artifacts below
`.artifacts/final-video/`. They verify a real browser recording, 1920×1080 pixels,
zero recorder audio streams, frame diversity, H.264/30 fps composition, decoded
digital silence, SRT bounds, evidence hashes and independent post-build re-verification.

## Final production run

The exact deployed Autopilot runtime is already locked:

```powershell
$sha = '203f159df25f825a0b994a2f8a4d2c0892b45390'

node demo/media-tools/record-live-motion.cjs `
  --expected-sha $sha `
  --capture-review demo/gallery/CAPTURE_REVIEW.json

python demo/media-tools/build-real-motion-submission.py `
  --expected-sha $sha `
  --replace

python demo/media-tools/compose_real_motion_video.py --verify-only
```

The recorder binds the exact `CAPTURE_REVIEW` bytes and requires its decision canary
to report `qwen-plus`, start with `recall_vendor_history`, include
`validate_invoice`, and contain only the five side-effect-free read/analyze tools.
It records the exact relevant subset chosen in that run and independently applies
the same policy to the visible public preview. The process view must also show
“isolated preview—nothing persisted” and the explicit absence of
approve/amend/reject controls. No durable reviewer item is created.
It builds an action-aware highlight no longer than the canonical nine-second overlay:
an action-centered segment (one-second pre-roll through 1.25-second post-click) retains
the synthetic entry/click, while the final four raw seconds retain the completed proposal
and human-boundary hold. The compositor refuses
any highlight longer than its 00:19–00:28 window and records that the entire live input
was consumed; diversity alone cannot satisfy this boundary gate.

Final judge-facing artifacts:

- `demo/final-media/autopilot-demo.mp4`
- `demo/final-media/autopilot-demo.en.srt`
- `demo/final-media/autopilot-demo.real-motion.json`
- `demo/final-media/autopilot-demo.qa.json`
- `demo/final-media/autopilot-youtube-thumbnail.png`

The MP4 has one locally generated silent AAC compatibility stream—no voice, TTS,
music or captured microphone/system audio. The final video, subtitles, manifest, QA
and thumbnail hashes must pass `--verify-only` immediately before upload.
