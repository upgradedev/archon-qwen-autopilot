#!/usr/bin/env python3
"""Build the Archon Autopilot demo — narrated or rights-safe caption-only.

The narrated default is the v2 orchestrator that fixes audio/video de-sync. Instead of
synthesizing one long voiceover and then UNIFORMLY stretching a fixed visual
timeline to match it (which never landed the "Step N" reveals on the spoken words),
it builds the video BEAT-BY-BEAT:

  1. Each beat carries its own narration line (scripts/make_frames.build_beats).
  2. Synthesize that line to its own clip (ElevenLabs when XI_API_KEY is set — same
     voice/model as the CI workflow — else the explicitly rights-attested edge-tts
     fallback; one consistent
     voice for the whole video).
  3. Decode the clip to WAV, MEASURE its real duration, snap (duration + tail) to a
     whole number of frames, and pad the audio with silence to exactly that length.
  4. The per-beat VIDEO duration == that same frame-quantized length. So audio and
     video for every beat are built from the SAME number, frame-aligned, with zero
     cumulative drift — the "Step four" line is spoken exactly while step 4 appears.
  5. Concatenate the padded audio segments (== the concatenated visual spans) and mux
     from t=0. Final duration == sum(durations) == voiceover length, within one frame.

Env:
  CAPTION_ONLY         true selects the rights-safe 168-second publication path:
                       no TTS, no third-party music, fixed 30 fps beat windows,
                       burned captions plus an exact English SRT, and locally
                       generated digital silence. Default false keeps narrated mode.
  XI_API_KEY            ElevenLabs key (optional; falls back to edge-tts)
  VOICE_ID / MODEL_ID   ElevenLabs voice + model (defaults match the workflow)
  EDGE_VOICE            edge-tts voice (default en-US-GuyNeural)
  TAIL_SECONDS          fixed tail of silence per beat (default 0.30)
  FPS                   output framerate (default 30)
  ASSETS_DIR            sanitized captures (default demo/final-media)
  PUBLIC_APP_URL        final HTTPS Autopilot URL (required)
  VIDEO_MODEL_LABEL     verified decider + vision model label (required)
  VIDEO_PROMOTION_EVIDENCE  promotion-pass JSON when the label contains qwen3.7
  VOICE_RIGHTS_ATTESTED must be true for public-use TTS generation in narrated
                       mode; it is neither required nor consulted in caption-only mode
  OUTPUT                final mp4 (default demo/final-media/autopilot-demo.mp4)
  SRT_OUTPUT            exact measured-beat English subtitles
                        (default demo/final-media/autopilot-demo.en.srt)
  CAPTION_MANIFEST_OUTPUT  caption-only rights/timing/media manifest
                       (default demo/final-media/autopilot-demo.caption-only.json)
  WORKDIR               scratch dir inside the repository (default .artifacts/video-build)
  FFMPEG / FFPROBE      binaries
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import textwrap
import time
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(HERE, "scripts"))
import make_frames  # noqa: E402
from path_safety import repo_contained_path  # noqa: E402

FFMPEG = os.environ.get("FFMPEG", "ffmpeg")
FFPROBE = os.environ.get("FFPROBE", "ffprobe")
FPS = int(os.environ.get("FPS", "30"))
TAIL = float(os.environ.get("TAIL_SECONDS", "0.30"))
VOICE_ID = os.environ.get("VOICE_ID") or "pNInz6obpgDQGcFmaJgB"
MODEL_ID = os.environ.get("MODEL_ID") or "eleven_multilingual_v2"
EDGE_VOICE = os.environ.get("EDGE_VOICE", "en-US-GuyNeural")

CAPTION_ONLY_FPS = 30
CAPTION_ONLY_MAX_WPM = 175.0
CAPTION_ONLY_BEATS = (
    ("01-stakes", 13.0),
    ("02-boundary", 15.0),
    ("03-live-pending", 24.0),
    ("04-human-control", 19.0),
    ("05-learning", 23.0),
    ("06-evidence", 19.0),
    ("07-safety", 21.0),
    ("08-alibaba-proof", 20.0),
    ("09-close", 14.0),
)


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


def strict_env_flag(name: str) -> bool:
    value = os.environ.get(name, "").strip().lower()
    if value in ("", "false"):
        return False
    if value == "true":
        return True
    raise SystemExit(f"{name} must be exactly true or false")


def sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe_media(path: str) -> dict:
    payload = run([
        FFPROBE, "-v", "error", "-show_streams", "-show_format",
        "-of", "json", path,
    ])
    try:
        return json.loads(payload)
    except ValueError as exc:
        raise SystemExit(f"ffprobe returned invalid JSON for {path}") from exc


def srt_timestamp(seconds: float) -> str:
    """Format a non-negative measured timeline position as an SRT timestamp."""
    if not isinstance(seconds, (int, float)) or seconds < 0:
        raise ValueError(f"invalid SRT timestamp: {seconds!r}")
    millis = round(seconds * 1000)
    hours, millis = divmod(millis, 3_600_000)
    minutes, millis = divmod(millis, 60_000)
    secs, millis = divmod(millis, 1_000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{millis:03d}"


def write_measured_srt(beats, durations, output):
    """Write one exact English cue per final beat window.

    Narrated mode uses its measured, frame-quantized audio windows. Caption-only mode
    uses the fixed frame-count windows that also drive the rendered scenes. The full
    English text and the burned summary caption therefore share one Beat source of
    truth in either mode.
    """
    if len(beats) != len(durations):
        raise ValueError("SRT beat/duration count mismatch")
    output = repo_contained_path(output, "SRT_OUTPUT", HERE)
    os.makedirs(os.path.dirname(output), exist_ok=True)
    start = 0.0
    cues = []
    for index, (beat, duration) in enumerate(zip(beats, durations), start=1):
        if not isinstance(duration, (int, float)) or duration <= 0:
            raise ValueError(f"invalid duration for SRT beat {beat.id}: {duration!r}")
        end = start + duration
        # Wrapping affects display lines only; the cue keeps the exact beat window.
        text = "\n".join(textwrap.wrap(
            " ".join(beat.narration.split()),
            width=64,
            break_long_words=False,
            break_on_hyphens=False,
        ))
        cues.append(
            f"{index}\n{srt_timestamp(start)} --> {srt_timestamp(end)}\n{text}\n"
        )
        start = end
    with open(output, "w", encoding="utf-8", newline="\n") as subtitle_file:
        subtitle_file.write("\n".join(cues))
    return output


def caption_only_timing(beats):
    """Return the immutable 9-beat, 168-second caption-only timing contract."""
    if FPS != CAPTION_ONLY_FPS:
        raise SystemExit(
            f"CAPTION_ONLY=true requires FPS={CAPTION_ONLY_FPS}; got {FPS}"
        )
    actual_ids = [beat.id for beat in beats]
    expected_ids = [beat_id for beat_id, _ in CAPTION_ONLY_BEATS]
    if actual_ids != expected_ids:
        raise SystemExit(
            "caption-only beat IDs/order changed; update and re-review the fixed timing contract"
        )

    durations = []
    readability = []
    for beat, (_, duration) in zip(beats, CAPTION_ONLY_BEATS):
        frames = round(duration * FPS)
        snapped = frames / FPS
        if abs(snapped - duration) > 1e-9:
            raise SystemExit(f"caption-only beat {beat.id} is not frame-exact at {FPS} fps")
        words = len(beat.narration.split())
        words_per_minute = words * 60.0 / duration
        if words_per_minute > CAPTION_ONLY_MAX_WPM:
            raise SystemExit(
                f"caption-only beat {beat.id} is too dense: "
                f"{words_per_minute:.1f} WPM > {CAPTION_ONLY_MAX_WPM:.1f}"
            )
        durations.append(snapped)
        readability.append({
            "id": beat.id,
            "words": words,
            "words_per_minute": round(words_per_minute, 1),
        })

    total = sum(durations)
    if total >= 175.0:
        raise SystemExit(f"caption-only fixed timeline is {total:.3f}s; must remain <175s")
    return durations, readability


def build_caption_only_silence(total: float, workdir: str) -> str:
    """Generate an original local silent PCM source; no network, music, or TTS."""
    silence = os.path.join(workdir, "caption-only-silence.wav")
    run([
        FFMPEG, "-y", "-f", "lavfi", "-i",
        "anullsrc=channel_layout=stereo:sample_rate=48000",
        "-t", f"{total:.6f}", "-map_metadata", "-1",
        "-c:a", "pcm_s16le", "-f", "wav", silence,
    ])
    return silence


def verify_caption_only_media(path: str, expected_duration: float) -> dict:
    media = probe_media(path)
    streams = media.get("streams", [])
    video_streams = [stream for stream in streams if stream.get("codec_type") == "video"]
    audio_streams = [stream for stream in streams if stream.get("codec_type") == "audio"]
    if len(video_streams) != 1 or len(audio_streams) != 1:
        raise SystemExit("caption-only final must contain exactly one video and one audio stream")
    video = video_streams[0]
    audio = audio_streams[0]
    if (video.get("width"), video.get("height")) != (1920, 1080):
        raise SystemExit(
            f"caption-only final must be 1920x1080; got {video.get('width')}x{video.get('height')}"
        )
    if video.get("codec_name") != "h264" or video.get("pix_fmt") != "yuv420p":
        raise SystemExit(
            f"caption-only final must be H.264/yuv420p; got "
            f"{video.get('codec_name')}/{video.get('pix_fmt')}"
        )
    if (
        audio.get("codec_name") != "aac"
        or str(audio.get("sample_rate")) != "48000"
        or int(audio.get("channels", 0)) != 2
    ):
        raise SystemExit(
            "caption-only final must contain locally generated 48 kHz stereo AAC silence"
        )
    duration = float(media.get("format", {}).get("duration", 0.0))
    if abs(duration - expected_duration) > (1.0 / FPS) + 0.05:
        raise SystemExit(
            f"caption-only media duration {duration:.3f}s != fixed timeline {expected_duration:.3f}s"
        )
    if duration >= 175.0:
        raise SystemExit(f"caption-only media duration {duration:.3f}s must remain <175s")
    return {
        "duration_seconds": round(duration, 3),
        "video": {
            "codec": video.get("codec_name"),
            "width": video.get("width"),
            "height": video.get("height"),
            "pixel_format": video.get("pix_fmt"),
        },
        "audio": {
            "codec": audio.get("codec_name"),
            "sample_rate_hz": int(audio.get("sample_rate")),
            "channels": int(audio.get("channels")),
            "source": "locally generated digital silence (FFmpeg anullsrc)",
        },
    }


def verify_measured_srt(path: str, beat_count: int, total: float) -> None:
    with open(path, encoding="utf-8") as subtitle_file:
        payload = subtitle_file.read()
    if payload.count(" --> ") != beat_count:
        raise SystemExit(f"SRT must contain exactly {beat_count} cues")
    if not payload.startswith("1\n00:00:00,000 --> "):
        raise SystemExit("SRT must start at 00:00:00,000")
    if f" --> {srt_timestamp(total)}\n" not in payload:
        raise SystemExit("SRT final cue must end at the exact fixed timeline duration")


def publish_exclusive(artifacts) -> None:
    """Hard-link verified candidates without ever replacing a reviewed final."""
    for _, destination in artifacts:
        if os.path.lexists(destination):
            raise SystemExit(
                f"refusing to overwrite existing final artifact: "
                f"{os.path.relpath(destination, HERE)}"
            )
        os.makedirs(os.path.dirname(destination), exist_ok=True)

    created = []
    try:
        for source, destination in artifacts:
            os.link(source, destination)
            created.append(destination)
    except Exception:
        for destination in reversed(created):
            try:
                os.unlink(destination)
            except FileNotFoundError:
                pass
        raise


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
    caption_only = strict_env_flag("CAPTION_ONLY")
    if (
        not caption_only
        and os.environ.get("VOICE_RIGHTS_ATTESTED", "").strip().lower() != "true"
    ):
        raise SystemExit(
            "VOICE_RIGHTS_ATTESTED=true is required: confirm the selected voice/service "
            "is authorized for this public competition video, or set CAPTION_ONLY=true"
        )
    if FPS <= 0:
        raise SystemExit("FPS must be a positive integer")

    def inside_repo(value, label):
        return repo_contained_path(value, label, HERE)

    assets = inside_repo(
        os.environ.get("ASSETS_DIR", os.path.join(HERE, "demo", "final-media")),
        "ASSETS_DIR",
    )
    output = inside_repo(os.environ.get("OUTPUT",
                            os.path.join(HERE, "demo", "final-media",
                                         "autopilot-demo.mp4")), "OUTPUT")
    workdir = inside_repo(
        os.environ.get("WORKDIR") or os.path.join(HERE, ".artifacts", "video-build"),
        "WORKDIR",
    )
    srt_output = inside_repo(
        os.environ.get(
            "SRT_OUTPUT",
            os.path.join(HERE, "demo", "final-media", "autopilot-demo.en.srt"),
        ),
        "SRT_OUTPUT",
    )
    manifest_output = None
    if caption_only:
        manifest_output = inside_repo(
            os.environ.get(
                "CAPTION_MANIFEST_OUTPUT",
                os.path.join(
                    HERE, "demo", "final-media", "autopilot-demo.caption-only.json"
                ),
            ),
            "CAPTION_MANIFEST_OUTPUT",
        )
        for final_path in (output, srt_output, manifest_output):
            if os.path.lexists(final_path):
                raise SystemExit(
                    "caption-only publication is exclusive; remove or choose a new path "
                    f"after reviewing the existing artifact: {os.path.relpath(final_path, HERE)}"
                )

    os.makedirs(workdir, exist_ok=True)
    os.makedirs(os.path.dirname(output), exist_ok=True)

    beats = make_frames.build_beats(assets)
    mode = "caption-only" if caption_only else "narrated"
    print(
        f"[build] mode={mode} {len(beats)} beats, tail={TAIL}s, "
        f"fps={FPS}, workdir={workdir}"
    )

    caption_readability = []
    if caption_only:
        durations, caption_readability = caption_only_timing(beats)
        audio_wav = build_caption_only_silence(sum(durations), workdir)
        engine = "caption-only-silence"
        print(
            "[rights] CAPTION_ONLY=true · no TTS · no third-party music · "
            "locally generated digital silence"
        )
    else:
        engine, seg_mp3s = synth_all(beats, workdir)
        audio_wav, durations = build_audio(beats, seg_mp3s, workdir)

    # durations.json + narration.txt (regenerated from the beats = single source of truth)
    with open(os.path.join(workdir, "durations.json"), "w", encoding="utf-8") as f:
        json.dump(durations, f)
    narration_txt = inside_repo(
        (
            os.path.join(workdir, "narration.txt")
            if caption_only
            else os.path.join(HERE, "demo", "video", "narration.txt")
        ),
        "narration output",
    )
    with open(narration_txt, "w", encoding="utf-8") as f:
        f.write("\n\n".join(b.narration for b in beats) + "\n")

    # Render per-beat scenes with the SAME durations, then mux from t=0.
    scenes = os.path.join(workdir, "scenes.mp4")
    make_frames.render_scenes(beats, durations, scenes, fps=FPS, ffmpeg=FFMPEG)
    render_output = (
        os.path.join(workdir, "autopilot-demo.caption-only.candidate.mp4")
        if caption_only
        else output
    )
    mux_command = [FFMPEG, "-y", "-i", scenes, "-i", audio_wav,
                   "-map", "0:v:0", "-map", "1:a:0"]
    if caption_only:
        mux_command.extend(["-map_metadata", "-1"])
    mux_command.extend([
        "-c:v", "copy", "-c:a", "aac", "-b:a", "192k", "-shortest", render_output,
    ])
    run(mux_command)

    if not caption_only:
        # Narrated-mode artifact for the existing workflow upload. Caption-only mode
        # intentionally creates no voice file and never invokes a TTS engine.
        voice_mp3 = inside_repo(
            os.environ.get("VOICE_MP3", os.path.join(workdir, "voiceover.mp3")),
            "VOICE_MP3",
        )
        run([FFMPEG, "-y", "-i", audio_wav,
             "-c:a", "libmp3lame", "-q:a", "2", voice_mp3])

    # ---- Global sync guard: video == audio == sum(durations) within one frame ----
    total = sum(durations)
    vdur = probe_duration(render_output)
    adur = probe_duration(audio_wav)
    frame = 1.0 / FPS
    print(f"[guard] engine={engine} beats={len(beats)} "
          f"sum(durations)={total:.3f}s video={vdur:.3f}s audio={adur:.3f}s")
    if abs(vdur - total) > frame + 0.05:
        raise SystemExit(f"video {vdur} vs sum {total}")
    if abs(adur - total) > frame + 0.05:
        raise SystemExit(f"audio {adur} vs sum {total}")
    if vdur >= 175.0:
        raise SystemExit(f"video {vdur}s exceeds the 175s publication safety limit")

    # Emit the per-beat windows so a caller can verify step-vs-spoken sync.
    readability_by_id = {item["id"]: item for item in caption_readability}
    t = 0.0
    windows = []
    for b, dur in zip(beats, durations):
        window = {"id": b.id, "start": round(t, 3),
                  "end": round(t + dur, 3), "dur": round(dur, 3)}
        if caption_only:
            window.update(readability_by_id[b.id])
        windows.append(window)
        t += dur
    with open(os.path.join(workdir, "windows.json"), "w", encoding="utf-8") as f:
        json.dump(windows, f, indent=2, sort_keys=True)
        f.write("\n")
    print("[windows] " + os.path.join(workdir, "windows.json"))

    srt_candidate = (
        os.path.join(workdir, "autopilot-demo.caption-only.candidate.en.srt")
        if caption_only
        else srt_output
    )
    write_measured_srt(beats, durations, srt_candidate)
    verify_measured_srt(srt_candidate, len(beats), total)

    if caption_only:
        media = verify_caption_only_media(render_output, total)
        manifest_candidate = os.path.join(
            workdir, "autopilot-demo.caption-only.candidate.json"
        )
        manifest = {
            "schema_version": 1,
            "mode": "caption-only",
            "rights_profile": {
                "tts": False,
                "third_party_music": False,
                "audio": "locally generated digital silence (FFmpeg anullsrc)",
            },
            "beats": len(beats),
            "fps": FPS,
            "strict_duration_limit_seconds": 175,
            "fixed_timeline_seconds": round(total, 3),
            "model_label": os.environ.get("VIDEO_MODEL_LABEL", "").strip(),
            "media": media,
            "video": {
                "path": os.path.relpath(output, HERE).replace(os.sep, "/"),
                "sha256": sha256_file(render_output),
            },
            "subtitles": {
                "language": "en",
                "cues": len(beats),
                "burned_summary_captions": True,
                "sidecar_path": os.path.relpath(srt_output, HERE).replace(os.sep, "/"),
                "sidecar_sha256": sha256_file(srt_candidate),
            },
            "windows": windows,
        }
        with open(manifest_candidate, "w", encoding="utf-8", newline="\n") as f:
            json.dump(manifest, f, ensure_ascii=False, indent=2, sort_keys=True)
            f.write("\n")
        publish_exclusive([
            (render_output, output),
            (srt_candidate, srt_output),
            (manifest_candidate, manifest_output),
        ])
        print(
            f"[subtitles] {srt_output} · {len(beats)} exact fixed caption windows"
        )
        print(f"[manifest] {manifest_output} · rights/timing/media gates recorded")
    else:
        print(f"[subtitles] {srt_output} · {len(beats)} exact audio-locked beat windows")

    print(f"[ok] {output}  duration={vdur:.3f}s ({engine})  < 175s, frame-aligned")
    return 0


if __name__ == "__main__":
    sys.exit(main())
