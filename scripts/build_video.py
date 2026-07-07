#!/usr/bin/env python3
"""Build the narrated Archon Autopilot demo — PER-BEAT audio-locked assembly.

This is the v2 orchestrator that fixes the audio/video de-sync. Instead of
synthesizing one long voiceover and then UNIFORMLY stretching a fixed visual
timeline to match it (which never landed the "Step N" reveals on the spoken words),
it builds the video BEAT-BY-BEAT:

  1. Each beat carries its own narration line (scripts/make_frames.build_beats).
  2. Synthesize that line to its own clip (ElevenLabs when XI_API_KEY is set — same
     voice/model as the CI workflow — else the free edge-tts fallback; one consistent
     voice for the whole video).
  3. Decode the clip to WAV, MEASURE its real duration, snap (duration + tail) to a
     whole number of frames, and pad the audio with silence to exactly that length.
  4. The per-beat VIDEO duration == that same frame-quantized length. So audio and
     video for every beat are built from the SAME number, frame-aligned, with zero
     cumulative drift — the "Step four" line is spoken exactly while step 4 appears.
  5. Concatenate the padded audio segments (== the concatenated visual spans) and mux
     from t=0. Final duration == sum(durations) == voiceover length, within one frame.

Env:
  XI_API_KEY            ElevenLabs key (optional; falls back to edge-tts)
  VOICE_ID / MODEL_ID   ElevenLabs voice + model (defaults match the workflow)
  EDGE_VOICE            edge-tts voice (default en-US-GuyNeural)
  TAIL_SECONDS          fixed tail of silence per beat (default 0.30)
  FPS                   output framerate (default 30)
  OUTPUT                final mp4 (default demo/video/final/archon-autopilot-demo.mp4)
  WORKDIR               scratch dir (default a temp dir)
  FFMPEG / FFPROBE      binaries
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import make_frames  # noqa: E402

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
FPS = int(os.environ.get("FPS", "30"))
TAIL = float(os.environ.get("TAIL_SECONDS", "0.30"))
VOICE_ID = os.environ.get("VOICE_ID") or "pNInz6obpgDQGcFmaJgB"
MODEL_ID = os.environ.get("MODEL_ID") or "eleven_multilingual_v2"
EDGE_VOICE = os.environ.get("EDGE_VOICE", "en-US-GuyNeural")


def run(cmd, **kw):
    r = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kw)
    if r.returncode != 0:
        sys.stderr.write("CMD FAILED: " + " ".join(map(str, cmd)) + "\n")
        sys.stderr.write(r.stderr.decode(errors="replace") + "\n")
        raise SystemExit(1)
    return r.stdout.decode(errors="replace")


def probe_duration(path):
    out = run([FFPROBE, "-v", "error", "-show_entries", "format=duration",
               "-of", "default=nw=1:nk=1", path])
    return float(out.strip())


# --------------------------------------------------------------------------- #
# TTS engines (one consistent voice for the whole video)
# --------------------------------------------------------------------------- #
def synth_elevenlabs(text, out_mp3, key, retries=3):
    url = (f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
           f"?output_format=mp3_44100_128")
    body = json.dumps({
        "text": text,
        "model_id": MODEL_ID,
        "voice_settings": {"stability": 0.45, "similarity_boost": 0.8,
                           "use_speaker_boost": True},
    }).encode("utf-8")
    last = None
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, data=body, headers={
                "xi-api-key": key, "Content-Type": "application/json",
                "Accept": "audio/mpeg"})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
            if len(data) < 3000:
                raise RuntimeError(f"tiny audio ({len(data)} bytes)")
            with open(out_mp3, "wb") as f:
                f.write(data)
            return
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"ElevenLabs failed after {retries} tries: {last}")


def synth_edge(text, out_mp3):
    run([sys.executable, "-m", "edge_tts", "--voice", EDGE_VOICE,
         "--text", text, "--write-media", out_mp3])
    if not os.path.exists(out_mp3) or os.path.getsize(out_mp3) < 2000:
        raise RuntimeError("edge-tts produced no usable audio")


def synth_all(beats, workdir):
    """Return (engine, [seg_mp3 paths]). One voice for the whole video: try
    ElevenLabs for every beat; if ANY beat can't be synthesized, fall back to
    edge-tts for ALL beats so the voice never switches mid-video."""
    key = os.environ.get("XI_API_KEY") or os.environ.get("ELEVEN_LABS_KEY")
    if key:
        try:
            segs = []
            for i, b in enumerate(beats):
                p = os.path.join(workdir, f"seg_{i:03d}.mp3")
                synth_elevenlabs(b.narration, p, key)
                segs.append(p)
                print(f"[tts] elevenlabs beat {i:02d} {b.id}")
            return "elevenlabs", segs
        except Exception as e:  # noqa: BLE001
            print(f"[tts] ElevenLabs unavailable ({e}) — falling back to edge-tts for ALL beats")
    segs = []
    for i, b in enumerate(beats):
        p = os.path.join(workdir, f"seg_{i:03d}.mp3")
        synth_edge(b.narration, p)
        segs.append(p)
        print(f"[tts] edge-tts beat {i:02d} {b.id}")
    return "edge-tts", segs


# --------------------------------------------------------------------------- #
# Audio: decode -> measure -> frame-snap -> pad -> concat
# --------------------------------------------------------------------------- #
def build_audio(beats, seg_mp3s, workdir):
    padded, durations = [], []
    for i, (b, mp3) in enumerate(zip(beats, seg_mp3s)):
        wav = os.path.join(workdir, f"seg_{i:03d}.wav")
        run([FFMPEG, "-y", "-i", mp3, "-ac", "1", "-ar", "44100", "-f", "wav", wav])
        d = probe_duration(wav)
        frames = max(1, round((d + TAIL) * FPS))
        dur = frames / FPS  # exact k/fps
        pad = os.path.join(workdir, f"pad_{i:03d}.wav")
        # apad extends with silence; -t trims to exactly `dur` seconds.
        run([FFMPEG, "-y", "-i", wav, "-af", "apad", "-t", f"{dur:.6f}",
             "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", "-f", "wav", pad])
        padded.append(pad)
        durations.append(dur)
        print(f"[audio] beat {i:02d} {b.id:<14} narration={d:6.3f}s  scene={dur:6.3f}s")

    listf = os.path.join(workdir, "audio_concat.txt")
    with open(listf, "w", encoding="utf-8") as f:
        for p in padded:
            f.write(f"file '{p}'\n")
    voice_wav = os.path.join(workdir, "voiceover.wav")
    run([FFMPEG, "-y", "-f", "concat", "-safe", "0", "-i", listf,
         "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", voice_wav])
    return voice_wav, durations


def main():
    assets = os.environ.get("ASSETS_DIR", os.path.join(HERE, "demo", "video", "assets"))
    output = os.environ.get("OUTPUT",
                            os.path.join(HERE, "demo", "video", "final",
                                         "archon-autopilot-demo.mp4"))
    workdir = os.environ.get("WORKDIR") or tempfile.mkdtemp(prefix="autopilot_build_")
    os.makedirs(workdir, exist_ok=True)
    os.makedirs(os.path.dirname(output), exist_ok=True)

    beats = make_frames.build_beats(assets)
    print(f"[build] {len(beats)} beats, tail={TAIL}s, fps={FPS}, workdir={workdir}")

    engine, seg_mp3s = synth_all(beats, workdir)
    voice_wav, durations = build_audio(beats, seg_mp3s, workdir)

    # durations.json + narration.txt (regenerated from the beats = single source of truth)
    with open(os.path.join(workdir, "durations.json"), "w", encoding="utf-8") as f:
        json.dump(durations, f)
    narration_txt = os.path.join(HERE, "demo", "video", "narration.txt")
    with open(narration_txt, "w", encoding="utf-8") as f:
        f.write("\n\n".join(b.narration for b in beats) + "\n")

    # Render per-beat scenes with the SAME durations, then mux from t=0.
    scenes = os.path.join(os.getcwd(), "scenes.mp4")
    make_frames.render_scenes(beats, durations, scenes, fps=FPS, ffmpeg=FFMPEG)
    run([FFMPEG, "-y", "-i", scenes, "-i", voice_wav,
         "-map", "0:v:0", "-map", "1:a:0",
         "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", output])

    # voiceover.mp3 artifact (for the workflow upload), emitted at CWD.
    voice_mp3 = os.environ.get("VOICE_MP3", os.path.join(os.getcwd(), "voiceover.mp3"))
    run([FFMPEG, "-y", "-i", voice_wav, "-c:a", "libmp3lame", "-q:a", "2", voice_mp3])

    # ---- Global sync guard: video == audio == sum(durations) within one frame ----
    total = sum(durations)
    vdur = probe_duration(output)
    adur = probe_duration(voice_wav)
    frame = 1.0 / FPS
    print(f"[guard] engine={engine} beats={len(beats)} "
          f"sum(durations)={total:.3f}s video={vdur:.3f}s audio={adur:.3f}s")
    assert abs(vdur - total) <= frame + 0.05, f"video {vdur} vs sum {total}"
    assert abs(adur - total) <= frame + 0.05, f"audio {adur} vs sum {total}"
    assert vdur <= 180.0, f"video {vdur}s exceeds the 3:00 ceiling"
    print(f"[ok] {output}  duration={vdur:.3f}s ({engine})  <= 180s, frame-aligned")

    # Emit the per-beat windows so a caller can verify step-vs-spoken sync.
    starts, t = [], 0.0
    windows = []
    for b, dur in zip(beats, durations):
        windows.append({"id": b.id, "start": round(t, 3),
                        "end": round(t + dur, 3), "dur": round(dur, 3)})
        t += dur
    with open(os.path.join(workdir, "windows.json"), "w", encoding="utf-8") as f:
        json.dump(windows, f, indent=2)
    print("[windows] " + os.path.join(workdir, "windows.json"))
    return 0


if __name__ == "__main__":
    sys.exit(main())
