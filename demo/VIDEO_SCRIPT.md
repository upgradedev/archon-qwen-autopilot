# Exceptional submission video — 9 judge-first beats

Target: **2:35–2:50**, hard maximum `2:59`. The renderer may use short micro-cuts
inside a beat, but the story has nine ideas only. Every screenshot/capture must come
from the final deployed commit; obsolete pre-auth UI captures were removed and are
not permitted as renderer inputs or gallery evidence.

| Beat | Target | What judges see | Narration job |
|---|---:|---|---|
| 1 · Stakes | 0:00–0:13 | Messy invoice → duplicate/overbill risk → money boundary | “Automate evidence gathering, never unattended payment.” State Track 4 immediately. |
| 2 · Product boundary | 0:13–0:28 | New 16:9 architecture | Independent AP orchestration product: public isolated preview vs reviewer-durable PENDING, bounded Qwen tools, atomic claims, explicit uncertain-outcome recovery, and restart-safe JSONL. Vendor memory is one read-only input. |
| 3 · Original synthetic invoice→PENDING | 0:28–0:52 | Final UI: upload/extract, then streamed recall→validate→duplicate→variance | Use the live hostname and actual model IDs. Label the invoice synthetic; show tool/observation trace plus concise rationale—not “full reasoning.” Nothing executes. |
| 4 · Exact human control | 0:52–1:11 | Authenticated reviewer amends exact args; Decided view shows before→after diff and ledger result | Make the invariant visual: approved args equal executed args; the atomic claim blocks concurrent replay; JSONL is restart-safe. SMTP has a stable intent ID but not recipient-level exactly once; uncertain execution is never auto-retried. |
| 5 · Correction changes behavior | 1:11–1:34 | Guided synthetic challenge: baseline €3,000 → amend €5,000 to €3,000 → re-bill/control comparison | Hero innovation: re-bill €5,000 → `flag_for_review`; negative control €3,000 → `draft_payment`. Same live routes, no preloaded answer. |
| 6 · Evidence, not hype | 1:34–1:53 | Workflow metrics + frozen eval artifacts | State exactly: 22/22 tuned developer-labelled offline regression; separate three-run raw-Qwen protocol; 16 original hash-locked vision fixtures; show live numbers only if clean committed artifacts exist. |
| 7 · Structural safety | 1:53–2:14 | Injection invoice, surfaced warning, model/MCP catalog with execution verbs crossed out | The model and four-tool MCP surface cannot approve/amend/reject/pay. Injection can influence a proposal, never autonomously execute. Human gate remains. |
| 8 · Alibaba/Qwen proof | 2:14–2:34 | App-specific ECS identity, `/health`, `/ready`, one actual decider canary and one vision extraction | Capture only Autopilot proof from the newly exact-deployed application release. Label `DEPLOYED APP SHA` separately from a later docs/media-only `SUBMISSION HEAD`. Show `qwen-plus`/`qwen-vl-max`, or the versioned qwen3.7 candidate only after its frozen A/B promotion gate passes. |
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
  changes. Record and show the newly exact-deployed application SHA.

## Build and acceptance

Rights-safe publication default when voice/service rights are not explicitly
confirmed:

```bash
$env:PUBLIC_APP_URL='https://autopilot.43.106.13.19.sslip.io'
$env:VIDEO_MODEL_LABEL='qwen-plus · qwen-vl-max · text-embedding-v4'
$env:CAPTION_ONLY='true'
# Replace the baseline label and set VIDEO_PROMOTION_EVIDENCE to the repo-contained,
# same-release promotion-pass JSON only if the final model label contains qwen3.7.
python scripts/build_video.py
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 demo/final-media/autopilot-demo.mp4
```

`CAPTION_ONLY=true` locks the target windows above to exactly 168 seconds at 30 fps,
uses the already burned per-beat captions, emits a measured nine-cue English SRT,
and muxes locally generated digital silence. It invokes no TTS and uses no
third-party music. The final MP4, SRT and rights/timing/media manifest are promoted
only after the 1920×1080, H.264/AAC, stream-count, readability and `<175s` gates pass;
existing reviewed finals are never overwritten.

Narrated mode remains the default when `CAPTION_ONLY` is unset. Use it only after
confirming publication rights, with `VOICE_RIGHTS_ATTESTED=true`; its measured
per-beat audio-lock behavior is unchanged.

Scratch stays under ignored `.artifacts/`. Selected sanitized frames/video stay under
tracked `demo/final-media/`. The renderer has exactly nine beats and aborts if any
required sanitized capture is missing; it never falls back outside the explicitly
promoted `demo/final-media/` inputs.
The build enforces a 175-second publication safety limit. Reject the render if any captured
token, stale queue, old UI, outdated claim, blank frame, unreadable burned caption,
unexpected audio, or duration ≥175 seconds remains. In narrated mode, also reject
clipped narration or drift.
