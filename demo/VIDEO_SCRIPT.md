# Exceptional submission video — 9 judge-first beats

Target: **2:35–2:50**, hard maximum `2:59`. The renderer may use short micro-cuts
inside a beat, but the story has nine ideas only. Every screenshot/capture must come
from the exact deployed runtime through the canonical gate started at the clean public
capture-source HEAD; obsolete pre-auth UI captures were removed and are not permitted
as renderer inputs or gallery evidence.

| Beat | Target | What judges see | Narration job |
|---|---:|---|---|
| 1 · Stakes | 0:00–0:13 | Messy invoice → duplicate/overbill risk → money boundary | “Automate evidence gathering, never unattended payment.” State Track 4 immediately. |
| 2 · Product boundary | 0:13–0:28 | 16:9 architecture from 0:13–0:19; genuine public-preview interaction inset from 0:19–0:28 | Establish the independent AP orchestration boundary, then visibly prove the isolated live Qwen preview: relevant read/analyze steps, completed non-durable proposal, and no approve/amend/reject controls. Reviewer-durable PENDING, atomic claims, uncertain-outcome recovery, and restart-safe JSONL remain visible in the architecture. Vendor memory is one read-only input. |
| 3 · Original synthetic invoice→PENDING | 0:28–0:52 | Final UI: upload/extract, then streamed recall→validate→relevant duplicate/variance/context checks | Use the live hostname and actual model IDs. Label the invoice synthetic; show the exact relevant tool/observation subset plus concise rationale—not “full reasoning.” Nothing executes. |
| 4 · Exact human control | 0:52–1:11 | Authenticated reviewer amends exact args; Decided view shows before→after diff and ledger result | Make the invariant visual: approved args equal executed args; the atomic claim blocks concurrent replay; JSONL is restart-safe. SMTP has a stable intent ID but not recipient-level exactly once; uncertain execution is never auto-retried. |
| 5 · Correction changes behavior | 1:11–1:34 | Guided synthetic challenge: baseline €3,000 → amend €5,000 to €3,000 → re-bill/control comparison | Hero innovation: re-bill €5,000 → `flag_for_review`; negative control €3,000 → `draft_payment`. Same live routes, no preloaded answer. |
| 6 · Evidence, not hype | 1:34–1:53 | Workflow metrics + frozen eval artifacts | State exactly: 22/22 tuned developer-labelled offline regression; a fixed 12-case synthetic workflow model with modeled—not observed—review time/checkpoints; 16 original hash-locked vision fixtures. No candidate model was promoted. |
| 7 · Structural safety | 1:53–2:14 | Injection invoice, surfaced warning, model/MCP catalog with execution verbs crossed out | The model and four-tool MCP surface cannot approve/amend/reject/pay. Injection can influence a proposal, never autonomously execute. Human gate remains. |
| 8 · Alibaba/Qwen proof | 2:14–2:34 | Hash-bound safe crop of the genuine shared ECS host + Autopilot-specific exact-SHA binding, `/health`, `/ready`, one actual decider canary and one vision extraction | Label the shared-host context honestly and bind Autopilot through its deployed runtime SHA, hash-bound compact Cloud Assistant sentinel, and fresh runtime canaries. Label `DEPLOYED RUNTIME SHA` separately from `CAPTURE-SOURCE HEAD`; link the later `FINAL SUBMITTED HEAD` outside this pre-commit proof. Show `qwen-plus` and `qwen-vl-max`; no candidate model was promoted. |
| 9 · Close | 2:34–2:48 | Live URL, repo, MIT, Track 4, four evidence numbers | “Bounded where judgment helps; deterministic and human-controlled where money moves.” |

## Claim lock

- Never call the 22 cases human/expert ground truth, held-out, or live-model accuracy.
- Never headline three repetitions as 66 independent samples.
- Never say confidence/rationale is re-derived or calibrated.
- Never say prompt injection is universally neutralized; say autonomous execution is
  structurally blocked and recognized patterns are surfaced.
- Payment/review adapters remain simulated. SMTP and append-only JSONL journal sinks
  are configurable real transports behind approval.
- Do not mention or link another submission as a product foundation.
- Do not call historical release `321b6c5…` the final deployment after later runtime
  changes. Record and show the exact deployed runtime SHA.

## Build and acceptance

Canonical rights-safe real-motion publication path:

```bash
node demo/media-tools/record-live-motion.cjs --expected-sha 030950e9b1e2353ee64f422ad050feb9733745bc --capture-review demo/gallery/CAPTURE_REVIEW.json --replace
python demo/media-tools/build-real-motion-submission.py --expected-sha 030950e9b1e2353ee64f422ad050feb9733745bc --replace
python demo/media-tools/compose_real_motion_video.py --verify-only
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 demo/final-media/autopilot-demo.mp4
```

The builder internally locks `CAPTION_ONLY=true`: exactly 168 seconds at 30 fps,
burned per-beat captions, a measured nine-cue English SRT, and locally generated
digital silence. It invokes no TTS and uses no third-party music. The final MP4,
SRT, real-motion manifest and independent QA record are promoted only after the
1920×1080, H.264/AAC, stream-count, readability, genuine-motion and `<175s` gates
pass; existing reviewed finals are never overwritten without explicit `--replace`.

Scratch stays under ignored `.artifacts/`. Selected sanitized frames/video stay under
tracked `demo/final-media/`. The renderer has exactly nine beats and aborts if any
required sanitized capture is missing; it never falls back outside the explicitly
promoted `demo/final-media/` inputs.
The build enforces a 175-second publication safety limit. Reject the render if any captured
token, stale queue, old UI, outdated claim, blank frame, unreadable burned caption,
unexpected audio, or duration ≥175 seconds remains.
