#!/usr/bin/env python3
"""Replace the canonical video's digital silence with rights-safe local narration.

The visual stream is copied bit-for-bit. Nine narration cues are synthesized locally
from a hash-locked Piper voice whose model card identifies a public-domain LibriVox
training source. No microphone, system audio, music, or remote TTS service is used.
Promotion is fail-closed and rolls back the MP4 and both evidence sidecars together.
"""
from __future__ import annotations

import argparse
import array
import datetime as dt
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

import compose_real_motion_video as motion


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_VIDEO = "demo/final-media/autopilot-demo.mp4"
DEFAULT_SRT = "demo/final-media/autopilot-demo.en.srt"
DEFAULT_MANIFEST = "demo/final-media/autopilot-demo.real-motion.json"
DEFAULT_QA = "demo/final-media/autopilot-demo.qa.json"
DEFAULT_SCRIPT = "demo/media-tools/narration-script.json"
DEFAULT_VOICE_LOCK = "demo/media-tools/narration-voice.lock.json"
DEFAULT_VOICE_DIR = ".artifacts/tts/norman-voice"
TIMELINE_SECONDS = 168.0
START_PAD_SECONDS = 0.45
END_PAD_SECONDS = 0.60
MAX_SPEED_FACTOR = 1.30
DISALLOWED_PUBLIC_RHETORIC = re.compile(
    r"[$€£¥]|\b(?:USD|EUR|GBP)\b|\b\d[\d.,]*\s*(?:euros?|dollars?|pounds?)\b|"
    r"\bhidden\s+costs?\b|\b(?:zero|no)\s+spend\b|\bfew\s+cents\b",
    re.IGNORECASE,
)


def require(value: bool, message: str) -> None:
    if not value:
        raise motion.GateError(message)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read_json(path: Path, label: str) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise motion.GateError(f"{label} is not valid UTF-8 JSON") from exc
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    return payload


def srt_cues(path: Path) -> list[dict[str, Any]]:
    content = path.read_text(encoding="utf-8")
    require("\r" not in content, "SRT must use canonical LF line endings")
    parsed: list[dict[str, Any]] = []
    for block in re.split(r"\n{2,}", content.strip()):
        lines = block.splitlines()
        require(len(lines) >= 3 and lines[0].strip().isdigit(), "SRT cue block is malformed")
        require(" --> " in lines[1], "SRT cue has no time window")
        start, end = lines[1].split(" --> ", 1)
        parsed.append({
            "startSeconds": motion.srt_seconds(start),
            "endSeconds": motion.srt_seconds(end),
            "text": " ".join(line.strip() for line in lines[2:] if line.strip()),
        })
    require(parsed, "SRT has no timed cues")
    return parsed


def validate_script(path: Path, srt: Path) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    payload = read_json(path, "narration script")
    require(payload.get("schemaVersion") == 1, "narration script schema version is not 1")
    require(payload.get("language") == "en-US", "narration script language is not en-US")
    require(float(payload.get("timelineSeconds", 0)) == TIMELINE_SECONDS,
            "narration script timeline is not exactly 168 seconds")
    policy = payload.get("policy")
    require(isinstance(policy, dict), "narration script has no policy record")
    for key in ("capturedAudio", "currencyExamples", "music", "numericMoneyExamples"):
        require(policy.get(key) is False, f"narration script policy must set {key}=false")
    require(policy.get("phoneticAliasesOnly") is True,
            "narration script must restrict speech drift to phonetic aliases")
    cues = payload.get("cues")
    require(isinstance(cues, list) and len(cues) == 9, "narration script must contain exactly nine cues")
    subtitles = srt_cues(srt)
    require(len(subtitles) == len(cues), "narration cue count differs from the SRT")
    ids: set[str] = set()
    for index, (cue, subtitle) in enumerate(zip(cues, subtitles), start=1):
        require(isinstance(cue, dict), f"narration cue {index} is not an object")
        cue_id = str(cue.get("id") or "")
        text = str(cue.get("text") or "").strip()
        speech_text = str(cue.get("speechText") or text).strip()
        require(re.fullmatch(r"[a-z0-9-]+", cue_id) is not None and cue_id not in ids,
                f"narration cue {index} has an invalid or duplicate id")
        ids.add(cue_id)
        start = float(cue.get("startSeconds", -1))
        end = float(cue.get("endSeconds", -1))
        require(abs(start - float(subtitle["startSeconds"])) <= 0.001
                and abs(end - float(subtitle["endSeconds"])) <= 0.001,
                f"narration cue {cue_id} does not match its SRT window")
        require(" ".join(text.split()) == " ".join(str(subtitle["text"]).split()),
                f"narration cue {cue_id} text differs from the accessibility SRT")
        canonicalized_speech = speech_text.replace("Ark-on", "Archon").replace("Kwen", "Qwen").replace("Ali Baba", "Alibaba")
        require(canonicalized_speech == text,
                f"narration cue {cue_id} speechText contains more than approved phonetic aliases")
        require(end - start > START_PAD_SECONDS + END_PAD_SECONDS + 2,
                f"narration cue {cue_id} has no safe speech window")
        require(12 <= len(re.findall(r"\b[\w'-]+\b", text)) <= 70,
                f"narration cue {cue_id} has an implausible word count")
        require(DISALLOWED_PUBLIC_RHETORIC.search(text) is None
                and DISALLOWED_PUBLIC_RHETORIC.search(speech_text) is None,
                f"narration cue {cue_id} contains prohibited money/cost rhetoric")
    return payload, cues


def validate_voice_assets(lock_path: Path, voice_dir: Path) -> tuple[dict[str, Any], Path, Path]:
    lock = read_json(lock_path, "narration voice lock")
    require(lock.get("schemaVersion") == 1, "voice-lock schema version is not 1")
    engine = lock.get("engine")
    voice = lock.get("voice")
    rights = lock.get("outputRights")
    require(isinstance(engine, dict) and engine.get("name") == "piper-tts"
            and engine.get("version") == "1.4.1", "voice lock does not pin piper-tts 1.4.1")
    require(isinstance(voice, dict) and voice.get("id") == "en_US-norman-medium",
            "voice lock does not pin en_US-norman-medium")
    require(voice.get("sourceRevision") == "82999b670b06c78cabeb830d535b63a31cd0ca22",
            "voice lock has an unexpected source revision")
    require(voice.get("trainingDatasetLicense") == "public domain",
            "voice-lock training dataset is not declared public domain")
    require(isinstance(rights, dict) and rights.get("tts") is True and rights.get("voice") is True
            and rights.get("thirdPartyMusic") is False and rights.get("capturedAudio") is False,
            "voice-lock output-rights profile is incomplete")
    records = voice.get("files")
    require(isinstance(records, dict) and len(records) == 4, "voice lock has an incomplete file inventory")
    for name, expected in records.items():
        asset = voice_dir / str(name)
        require(asset.is_file() and not asset.is_symlink(), f"voice asset is missing or unsafe: {name}")
        require(sha256_file(asset) == expected, f"voice asset hash mismatch: {name}")
    card = (voice_dir / "MODEL_CARD").read_text(encoding="utf-8")
    revision = (voice_dir / "SOURCE_REVISION.txt").read_text(encoding="utf-8").strip()
    require("License: public domain" in card and "Trained from scratch" in card,
            "voice model card does not contain the required public-domain/from-scratch statements")
    require(revision == voice.get("sourceRevision"), "voice source-revision file differs from the lock")
    return lock, voice_dir / "en_US-norman-medium.onnx", voice_dir / "en_US-norman-medium.onnx.json"


def piper_version(python: Path) -> str:
    completed = subprocess.run(
        [str(python), "-c", "import importlib.metadata; print(importlib.metadata.version('piper-tts'))"],
        cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    if completed.returncode != 0:
        raise motion.GateError(f"cannot inspect local piper-tts: {completed.stderr[-1000:]}")
    return completed.stdout.strip()


def audio_duration(path: Path) -> float:
    raw = motion.run([
        "ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "json", str(path)
    ], f"ffprobe audio {path.name}")
    try:
        duration = float(json.loads(str(raw))["format"]["duration"])
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise motion.GateError(f"cannot measure narration audio {path.name}") from exc
    require(math.isfinite(duration) and duration > 0, f"narration audio has invalid duration: {path.name}")
    return duration


def pcm_stats(path: Path, *, start: float | None = None, duration: float | None = None) -> dict[str, Any]:
    command = ["ffmpeg", "-v", "error"]
    if start is not None:
        command += ["-ss", f"{start:.6f}"]
    command += ["-i", str(path)]
    if duration is not None:
        command += ["-t", f"{duration:.6f}"]
    command += ["-map", "0:a:0", "-vn", "-ac", "2", "-ar", "48000", "-f", "s16le", "-"]
    content = bytes(motion.run(command, f"decode narration audio {path.name}", binary=True))
    require(content and len(content) % 2 == 0, f"decoded narration audio is invalid: {path.name}")
    samples = array.array("h")
    samples.frombytes(content)
    if sys.byteorder != "little":
        samples.byteswap()
    peak = max(abs(int(value)) for value in samples)
    square_sum = sum(int(value) * int(value) for value in samples)
    non_silent = sum(1 for value in samples if abs(int(value)) >= 256)
    return {
        "peak": peak,
        "rms": round(math.sqrt(square_sum / len(samples)), 3),
        "nonSilentFraction": round(non_silent / len(samples), 6),
        "samples": len(samples),
    }


def video_stream_hash(path: Path) -> str:
    output = str(motion.run([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:v:0", "-c", "copy",
        "-f", "hash", "-hash", "sha256", "-"
    ], f"hash visual stream {path.name}"))
    match = re.search(r"SHA256=([0-9a-f]{64})", output, re.IGNORECASE)
    require(match is not None, f"ffmpeg did not return a visual-stream hash for {path.name}")
    return match.group(1).lower()


def write_json(path: Path, payload: dict[str, Any]) -> None:
    path.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"))


def synthesize(
    *, video: Path, srt: Path, manifest_path: Path, qa_path: Path,
    script_path: Path, voice_lock_path: Path, voice_dir: Path,
    piper_python: Path, scratch_root: Path, replace: bool,
) -> dict[str, Any]:
    require(replace, "narration promotion requires explicit --replace")
    for path, label in ((video, "canonical video"), (srt, "canonical SRT"),
                        (manifest_path, "real-motion manifest"), (qa_path, "real-motion QA"),
                        (script_path, "narration script"), (voice_lock_path, "voice lock")):
        motion.project_path(path, label, exists=True)
    require(voice_dir.is_dir() and not voice_dir.is_symlink(), "voice directory is missing or unsafe")
    require(piper_python.is_file() and not piper_python.is_symlink(), "--piper-python is missing or unsafe")

    silent_verification = motion.verify_existing(manifest_path, qa_path)
    require(silent_verification["audioMode"] == "digital silence",
            "canonical input is not the verified silent real-motion master")
    base_manifest_bytes = manifest_path.read_bytes()
    base_qa_bytes = qa_path.read_bytes()
    base_video_bytes_hash = sha256_file(video)
    base_manifest = json.loads(base_manifest_bytes.decode("utf-8"))
    base_qa = json.loads(base_qa_bytes.decode("utf-8"))
    base_visual_hash = video_stream_hash(video)
    base_media = motion.media_summary(video)
    require(abs(float(base_media["durationSeconds"]) - TIMELINE_SECONDS) <= 0.05,
            "canonical silent master is not exactly 168 seconds")

    script, cues = validate_script(script_path, srt)
    voice_lock, model, config = validate_voice_assets(voice_lock_path, voice_dir)
    engine_version = piper_version(piper_python)
    require(engine_version == voice_lock["engine"]["version"],
            f"local piper-tts version {engine_version} differs from the voice lock")

    session = scratch_root / f"narration-{secrets.token_hex(8)}"
    session.mkdir(parents=True, exist_ok=False)
    cue_outputs: list[Path] = []
    cue_metrics: list[dict[str, Any]] = []
    for index, cue in enumerate(cues, start=1):
        cue_id = str(cue["id"])
        text = str(cue["text"]).strip()
        speech_text = str(cue.get("speechText") or text).strip()
        source = session / f"{index:02d}-{cue_id}.txt"
        raw_wav = session / f"{index:02d}-{cue_id}.raw.wav"
        processed_wav = session / f"{index:02d}-{cue_id}.voice.wav"
        source.write_text(speech_text + "\n", encoding="utf-8", newline="\n")
        completed = subprocess.run([
            str(piper_python), "-m", "piper", "-m", str(model), "-c", str(config),
            "-i", str(source), "-f", str(raw_wav), "--length-scale", "0.90",
            "--sentence-silence", "0.08", "--volume", "0.95",
        ], cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if completed.returncode != 0:
            raise motion.GateError(f"Piper failed for cue {cue_id}: {completed.stderr[-1500:]}")
        raw_duration = audio_duration(raw_wav)
        window = float(cue["endSeconds"]) - float(cue["startSeconds"])
        available = window - START_PAD_SECONDS - END_PAD_SECONDS
        speed = max(1.0, raw_duration / available)
        require(speed <= MAX_SPEED_FACTOR,
                f"cue {cue_id} needs {speed:.3f}x speech and exceeds the {MAX_SPEED_FACTOR:.2f}x limit")
        expected_duration = raw_duration / speed
        fade_out = max(0.08, expected_duration - 0.14)
        filters = (
            f"atempo={speed:.6f},highpass=f=70,lowpass=f=15000,"
            "loudnorm=I=-18:TP=-2:LRA=9,"
            f"afade=t=in:st=0:d=0.08,afade=t=out:st={fade_out:.6f}:d=0.12"
        )
        motion.run([
            "ffmpeg", "-y", "-v", "error", "-i", str(raw_wav), "-af", filters,
            "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le", str(processed_wav),
        ], f"master narration cue {cue_id}")
        processed_duration = audio_duration(processed_wav)
        require(processed_duration <= available + 0.08,
                f"processed narration cue {cue_id} exceeds its safe timeline window")
        word_count = len(re.findall(r"\b[\w'-]+\b", speech_text))
        speech_wpm = word_count / (processed_duration / 60)
        require(85 <= speech_wpm <= 190, f"cue {cue_id} speech rate is implausible ({speech_wpm:.1f} WPM)")
        cue_outputs.append(processed_wav)
        cue_metrics.append({
            "id": cue_id,
            "startSeconds": float(cue["startSeconds"]),
            "endSeconds": float(cue["endSeconds"]),
            "speechStartSeconds": float(cue["startSeconds"]) + START_PAD_SECONDS,
            "rawDurationSeconds": round(raw_duration, 6),
            "processedDurationSeconds": round(processed_duration, 6),
            "speedFactor": round(speed, 6),
            "wordCount": word_count,
            "wordsPerMinute": round(speech_wpm, 2),
            "captionTextSha256": hashlib.sha256((text + "\n").encode("utf-8")).hexdigest(),
            "speechTextSha256": hashlib.sha256((speech_text + "\n").encode("utf-8")).hexdigest(),
            "voiceWavSha256": sha256_file(processed_wav),
        })

    narration_wav = session / "autopilot-narration.master.wav"
    mix_command = [
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-t", f"{TIMELINE_SECONDS:.3f}",
        "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    ]
    for cue_output in cue_outputs:
        mix_command += ["-i", str(cue_output)]
    filters = [f"[0:a]atrim=duration={TIMELINE_SECONDS:.6f},asetpts=PTS-STARTPTS[sil]"]
    delayed_labels = []
    for index, metric in enumerate(cue_metrics, start=1):
        delay_ms = int(round(float(metric["speechStartSeconds"]) * 1000))
        label = f"cue{index}"
        filters.append(f"[{index}:a]adelay=delays={delay_ms}:all=1[{label}]")
        delayed_labels.append(f"[{label}]")
    mix_inputs = "[sil]" + "".join(delayed_labels)
    filters.append(
        f"{mix_inputs}amix=inputs={len(delayed_labels) + 1}:duration=longest:dropout_transition=0:normalize=0,"
        f"alimiter=limit=0.95,atrim=duration={TIMELINE_SECONDS:.6f},asetpts=PTS-STARTPTS[mix]"
    )
    mix_command += [
        "-filter_complex", ";".join(filters), "-map", "[mix]", "-ar", "48000", "-ac", "2",
        "-c:a", "pcm_s16le", str(narration_wav),
    ]
    motion.run(mix_command, "assemble timeline-aligned narration")
    require(abs(audio_duration(narration_wav) - TIMELINE_SECONDS) <= 0.05,
            "assembled narration is not exactly 168 seconds")

    candidate = session / "autopilot-demo.narrated.mp4"
    motion.run([
        "ffmpeg", "-y", "-v", "error", "-i", str(video), "-i", str(narration_wav),
        "-map", "0:v:0", "-map", "1:a:0", "-map_metadata", "-1", "-c:v", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
        "-t", f"{TIMELINE_SECONDS:.6f}", "-movflags", "+faststart", str(candidate),
    ], "mux rights-safe narration")
    final_media = motion.media_summary(candidate)
    require(final_media["width"] == 1920 and final_media["height"] == 1080,
            "narrated candidate is not 1920x1080")
    require(final_media["videoCodec"] == "h264" and final_media["pixelFormat"] == "yuv420p",
            "narrated candidate is not H.264/yuv420p")
    require(final_media["audioStreamCount"] == 1 and final_media["audioCodec"] == "aac"
            and final_media["audioSampleRate"] == 48000 and final_media["audioChannels"] == 2,
            "narrated candidate is not one 48 kHz stereo AAC stream")
    require(abs(float(final_media["durationSeconds"]) - TIMELINE_SECONDS) <= 0.05,
            "narrated candidate duration drifted from the visual timeline")
    require(video_stream_hash(candidate) == base_visual_hash,
            "narration mux changed the evidence-bound visual bitstream")

    overall = pcm_stats(candidate)
    require(1_000 <= overall["peak"] < 32_700, "narrated candidate audio is silent or clipped")
    require(overall["rms"] >= 350, "narrated candidate audio RMS is too low")
    require(0.03 <= overall["nonSilentFraction"] <= 0.9,
            "narrated candidate audio activity is implausible")
    for cue, metric in zip(cues, cue_metrics):
        window_stats = pcm_stats(
            candidate, start=float(cue["startSeconds"]),
            duration=float(cue["endSeconds"]) - float(cue["startSeconds"]),
        )
        require(window_stats["peak"] >= 900 and window_stats["rms"] >= 250,
                f"final audio has no intelligible-level narration in cue {cue['id']}")
        metric["finalWindowAudio"] = window_stats

    generated_at = dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    new_qa = dict(base_qa)
    new_qa.update({"schemaVersion": 2, "status": "passed", "video": final_media})
    new_qa["duration"] = dict(base_qa.get("duration", {}))
    new_qa["duration"]["finalSeconds"] = final_media["durationSeconds"]
    new_qa["audio"] = {
        "policy": "locally synthesized, hash-locked narration; no music or captured audio",
        "decodedPeakS16": overall["peak"],
        "decodedRmsS16": overall["rms"],
        "nonSilentFraction": overall["nonSilentFraction"],
        "voice": True,
        "tts": True,
        "music": False,
        "capturedAudio": False,
        "cueCount": len(cue_metrics),
        "allCueWindowsAudible": True,
    }
    new_qa["narrationCues"] = cue_metrics

    new_manifest = dict(base_manifest)
    new_manifest.update({
        "schemaVersion": 2,
        "status": "passed",
        "builder": "caption-led-real-motion-plus-rights-safe-narration-v1",
        "generatedAt": generated_at,
        "rightsProfile": {
            "voice": True,
            "tts": True,
            "thirdPartyMusic": False,
            "capturedAudio": False,
            "audio": "locally synthesized narration from a hash-locked public-domain-source voice; no music",
        },
        "baseComposition": {
            "manifestSha256": hashlib.sha256(base_manifest_bytes).hexdigest(),
            "qaSha256": hashlib.sha256(base_qa_bytes).hexdigest(),
            "silentVideoSha256": base_video_bytes_hash,
            "silentDecodedPeakS16": silent_verification["decodedPeakS16"],
            "visualStreamSha256": base_visual_hash,
        },
        "narration": {
            "script": {"path": motion.relative(script_path), "sha256": sha256_file(script_path)},
            "voiceLock": {"path": motion.relative(voice_lock_path), "sha256": sha256_file(voice_lock_path)},
            "engine": voice_lock["engine"],
            "voice": {
                "id": voice_lock["voice"]["id"],
                "sourceRevision": voice_lock["voice"]["sourceRevision"],
                "modelSha256": sha256_file(model),
                "configSha256": sha256_file(config),
                "modelCardSha256": voice_lock["voice"]["files"]["MODEL_CARD"],
                "trainingDataset": voice_lock["voice"]["trainingDataset"],
                "trainingDatasetLicense": voice_lock["voice"]["trainingDatasetLicense"],
            },
            "masterPcmSha256": sha256_file(narration_wav),
            "cueCount": len(cue_metrics),
            "cueMetrics": cue_metrics,
        },
    })
    outputs = new_manifest.get("outputs")
    require(isinstance(outputs, dict), "base manifest has no outputs record")
    outputs["video"] = {"path": motion.relative(video), "sha256": sha256_file(candidate), **final_media}

    staged_qa = session / "autopilot-demo.qa.json"
    staged_manifest = session / "autopilot-demo.real-motion.json"
    write_json(staged_qa, new_qa)
    outputs["qa"] = {"path": motion.relative(qa_path), "sha256": sha256_file(staged_qa)}
    write_json(staged_manifest, new_manifest)

    backups = {video: video.read_bytes(), qa_path: base_qa_bytes, manifest_path: base_manifest_bytes}
    try:
        os.replace(candidate, video)
        os.replace(staged_qa, qa_path)
        os.replace(staged_manifest, manifest_path)
        verified = motion.verify_existing(manifest_path, qa_path)
        require(verified["audioMode"] == "rights-safe narrated TTS",
                "post-promotion verifier did not recognize the narrated final")
    except Exception:
        for destination, content in backups.items():
            destination.write_bytes(content)
        raise
    return {
        "video": motion.relative(video),
        "videoSha256": sha256_file(video),
        "durationSeconds": final_media["durationSeconds"],
        "audio": overall,
        "cueCount": len(cue_metrics),
        "session": motion.relative(session),
    }


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--video", default=DEFAULT_VIDEO)
    parser.add_argument("--srt", default=DEFAULT_SRT)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--qa", default=DEFAULT_QA)
    parser.add_argument("--script", default=DEFAULT_SCRIPT)
    parser.add_argument("--voice-lock", default=DEFAULT_VOICE_LOCK)
    parser.add_argument("--voice-dir", default=DEFAULT_VOICE_DIR)
    parser.add_argument("--piper-python")
    parser.add_argument("--scratch", default=".artifacts/final-video")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        manifest = motion.project_path(args.manifest, "real-motion manifest", exists=True)
        qa = motion.project_path(args.qa, "real-motion QA", exists=True)
        if args.verify_only:
            verified = motion.verify_existing(manifest, qa)
            require(verified["audioMode"] == "rights-safe narrated TTS",
                    "canonical final is not the rights-safe narrated release")
            print(
                f"narrated video verify: PASS · {verified['durationSeconds']:.3f}s · "
                f"peak {verified['decodedPeakS16']} · RMS {verified['decodedRmsS16']:.1f} · "
                f"{verified['subtitleCues']} cues · visual/live evidence retained"
            )
            return 0
        require(args.piper_python, "--piper-python is required for synthesis")
        result = synthesize(
            video=motion.project_path(args.video, "canonical video", exists=True),
            srt=motion.project_path(args.srt, "canonical SRT", exists=True),
            manifest_path=manifest,
            qa_path=qa,
            script_path=motion.project_path(args.script, "narration script", exists=True),
            voice_lock_path=motion.project_path(args.voice_lock, "voice lock", exists=True),
            voice_dir=motion.project_path(args.voice_dir, "voice directory"),
            piper_python=Path(args.piper_python).resolve(strict=True),
            scratch_root=motion.project_path(args.scratch, "narration scratch"),
            replace=args.replace,
        )
        print(
            f"rights-safe narration: PASS · {result['durationSeconds']:.3f}s · "
            f"{result['cueCount']} audible cues · peak {result['audio']['peak']} · "
            f"{result['videoSha256'][:12]} · retained {result['session']}"
        )
        return 0
    except (motion.GateError, OSError, UnicodeError, ValueError, KeyError, json.JSONDecodeError) as exc:
        print(f"rights-safe narration: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
