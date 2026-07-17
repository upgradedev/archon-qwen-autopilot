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
python -m py_compile demo/media-tools/compose_real_motion_video.py demo/media-tools/build-real-motion-submission.py demo/media-tools/add_rights_safe_narration.py
node demo/media-tools/record-live-motion.cjs --self-test
python demo/media-tools/compose_real_motion_video.py --self-test
```

The self-tests create only ignored, unmistakably labelled fixture artifacts below
`.artifacts/final-video/`. They verify a real browser recording, 1920×1080 pixels,
zero recorder audio streams, frame diversity, H.264/30 fps composition, the verified
silent intermediate, SRT bounds, evidence hashes and independent post-build re-verification.
The production narration pass additionally requires 9/9 audible cue windows, bounded
peak/RMS/activity, exact SRT text, an unchanged visual bitstream and a hash-locked
public-domain-source voice.

## Final production run

The exact deployed Autopilot runtime is already locked:

```powershell
$sha = '030950e9b1e2353ee64f422ad050feb9733745bc'

node demo/media-tools/record-live-motion.cjs `
  --expected-sha $sha `
  --capture-review demo/gallery/CAPTURE_REVIEW.json

python demo/media-tools/build-real-motion-submission.py `
  --expected-sha $sha `
  --replace

python demo/media-tools/add_rights_safe_narration.py `
  --piper-python .artifacts/tts/venv/Scripts/python.exe `
  --replace

python demo/media-tools/add_rights_safe_narration.py --verify-only
```

The recorder binds the exact `CAPTURE_REVIEW` bytes and requires its decision canary
to report `qwen-plus`, start with `recall_vendor_history`, include
`validate_invoice`, and contain only the five side-effect-free read/analyze tools.
It records the exact relevant subset chosen in that run and independently applies
the same policy to the visible public preview. The process view must also show
“isolated preview—nothing persisted” and the explicit absence of
approve/amend/reject controls. No durable reviewer item is created.
The final builder also requires `CAPTURE_REVIEW` to hash-bind all six renderer PNGs
and `judge-architecture.jpg`, copies those validated bytes into a unique session-owned
snapshot, and points the caption renderer only at that snapshot. It rechecks the
snapshot after rendering and the canonical evidence set after composition, so a
concurrent pathname change cannot enter the shipped pixels or final manifest.
It builds an action-aware highlight no longer than the canonical nine-second overlay.
The selector retains an entry/click segment, an explicit streamed-evidence/completed-
proposal segment, and the final four-second human-boundary hold, coalescing overlaps
without dropping any required action. The compositor refuses
any highlight longer than its 00:19–00:28 window and records that the entire live input
was consumed; diversity alone cannot satisfy this boundary gate.

Final judge-facing artifacts:

- `demo/final-media/autopilot-demo.mp4`
- `demo/final-media/autopilot-demo.en.srt`
- `demo/final-media/autopilot-demo.real-motion.json`
- `demo/final-media/autopilot-demo.qa.json`
- `demo/final-media/autopilot-youtube-thumbnail.png`
- `demo/media-tools/narration-script.json`
- `demo/media-tools/narration-voice.lock.json`

The MP4 has one locally synthesized narration stream and no music, microphone or
captured system audio. Caption text and burned captions come from the same canonical
nine-cue JSON; `speechText` may differ only by the guarded `Archon`/`Qwen`/`Alibaba`
phonetic aliases. The voice is `en_US-norman-medium` at pinned revision
`82999b670b06c78cabeb830d535b63a31cd0ca22`; its bundled model card identifies
public-domain LibriVox recordings and training from scratch. The tracked lock binds
the model, config, card and revision hashes; the engine/model cache remains ignored
inside `.artifacts/`. The final video, subtitles, manifest, QA and thumbnail hashes
must pass the narrated `--verify-only` immediately before upload.
