# Demo video pipeline

A ~3-minute **narrated** demo of Archon Autopilot (Track 4), showing the live
multi-step ReAct loop, the human-in-the-loop approval gate, and the MCP + skills
surface — running live on Alibaba Cloud over HTTPS.

## Output

1920×1080, H.264 + AAC, narrated, under 3 min, no black lead-in (per-scene assembly,
captions burned in and auto-fit).

- `final/archon-autopilot-demo.mp4` — **the canonical deliverable, produced by the CI
  workflow with the ElevenLabs voice** (requires the `ELEVEN_LABS_KEY` repo secret).
- `final/archon-autopilot-demo.edgetts-fallback.mp4` — a committed **edge-tts** render
  (the free fallback voice), so a working narrated video exists even before the
  ElevenLabs key is added. Do not submit this one if the ElevenLabs render is available.

## How it is built (no screen recording)

1. **Real proof, committed as assets** (so the build is reproducible with no live box):
   - `assets/live_intake_journal.json` / `assets/live_intake_duplicate.json` — REAL
     `POST /intake` responses captured from the deployed box
     (`https://autopilot.43.106.13.19.sslip.io`) over HTTPS: the genuine multi-step
     qwen-plus trace (`recall_vendor_history → validate_invoice → check_duplicate →
     compute_variance_vs_history`) reaching a terminal `draft_journal_entry`, and the
     duplicate-detection path reaching a human-gated `flag_for_review`.
   - `assets/ui_overview.png` / `assets/ui_card.png` — real Playwright screenshots of
     the live approval UI (the PENDING queue + the "how the agent decided" trace).
2. **Narration** — `narration.txt`, synthesized to a voiceover by the CI workflow
   (ElevenLabs when `ELEVEN_LABS_KEY` is set, else the free edge-tts fallback — so it
   is always narrated).
3. **Frames** — `scripts/make_frames.py` renders the per-scene slideshow (PIL frames,
   burned auto-fit captions, no black lead-in), scaled to the voiceover length so the
   visuals track the narration.
4. **Mux** — ffmpeg muxes the voiceover from t=0 → `final/archon-autopilot-demo.mp4`.

## Regenerate

In CI (recommended): **Actions → "Generate Demo Video" → Run workflow**
(`.github/workflows/demo-video.yml`), or `gh workflow run demo-video.yml`.
For the ElevenLabs voice, set the repo secret `ELEVEN_LABS_KEY` (Text-to-Speech
scope); without it the workflow falls back to edge-tts.

Locally (Python 3.11 + ffmpeg):

```bash
python -m pip install "pillow>=10" "edge-tts>=7"
python -m edge_tts --voice en-US-GuyNeural --file demo/video/narration.txt --write-media vo.mp3
AUDIO=$(ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 vo.mp3)
TARGET_SECONDS=$(python -c "print(round($AUDIO+1.5,2))") OUTPUT=scenes.mp4 python scripts/make_frames.py
ffmpeg -y -i scenes.mp4 -i vo.mp3 -filter_complex "[1:a]apad[a]" -map 0:v:0 -map "[a]" \
  -c:v copy -c:a aac -b:a 192k -shortest demo/video/final/archon-autopilot-demo.mp4
```

## Refresh the live-capture assets (optional)

```bash
# real live traces
curl -s -X POST https://autopilot.43.106.13.19.sslip.io/intake -H 'content-type: application/json' \
  -d '{"invoice":{"supplier":"<new vendor>","invoice_number":"<ref>","tax_id":"TX-...","subtotal":..,"tax":..,"total":..,"date":"..","currency":"EUR"}}'
# real UI screenshots (needs Playwright + Chrome)
node scripts/capture_ui.cjs demo/video/assets
```
