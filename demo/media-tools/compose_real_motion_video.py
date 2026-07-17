#!/usr/bin/env python3
"""Compose and prove a caption-led submission video with genuine live motion.

The existing judge-first renderer remains the source of title, architecture,
metrics and claim-locked captions.  This compositor places a separately recorded,
SHA-bound live browser interaction into one reviewed timeline window, then measures
the shipped pixels and audio.  It never contacts the live service and never reads a
reviewer credential.

Production inputs must be regular project-contained files.  The interaction
manifest must bind the exact CAPTURE_REVIEW bytes, deployed runtime SHA, public origin and
raw browser-video hash.  The final remains rights-safe: no TTS or third-party music;
the compatibility AAC stream must decode to digital silence.
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
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any, Sequence


ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUTPUT = "demo/final-media/autopilot-demo.mp4"
DEFAULT_SRT_OUTPUT = "demo/final-media/autopilot-demo.en.srt"
DEFAULT_MANIFEST = "demo/final-media/autopilot-demo.real-motion.json"
DEFAULT_QA = "demo/final-media/autopilot-demo.qa.json"
DEFAULT_THUMBNAIL = "demo/final-media/autopilot-youtube-thumbnail.png"
DEFAULT_URL = "https://autopilot.43.106.13.19.sslip.io"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
SRT_TIME_RE = re.compile(r"^(\d{2}):(\d{2}):(\d{2}),(\d{3})$")
STRICT_LIMIT_SECONDS = 175.0
FPS = 30.0


class GateError(RuntimeError):
    pass


def require(condition: bool, message: str) -> None:
    if not condition:
        raise GateError(message)


def project_path(value: str | Path, label: str, *, exists: bool = False) -> Path:
    candidate = Path(value)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    resolved = candidate.resolve(strict=exists)
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise GateError(f"{label} must stay inside this repository") from exc
    if exists:
        require(resolved.is_file(), f"{label} must be a regular file")
        require(not resolved.is_symlink(), f"{label} must not be a symlink")
        require(resolved.stat().st_nlink == 1, f"{label} must have exactly one hard link")
    return resolved


def relative(path: Path) -> str:
    return path.resolve().relative_to(ROOT).as_posix()


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
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    return payload


def read_json_snapshot(path: Path, label: str) -> tuple[dict[str, Any], str]:
    """Parse and hash one descriptor-consistent, project-contained byte snapshot."""
    canonical = project_path(path, label, exists=True)
    before_path = canonical.stat()
    try:
        with canonical.open("rb") as stream:
            before = os.fstat(stream.fileno())
            require(before.st_nlink == 1, f"{label} must have exactly one hard link")
            require(0 < before.st_size <= 16 * 1024 * 1024, f"{label} has an invalid size")
            raw = stream.read()
            after = os.fstat(stream.fileno())
    except OSError as exc:
        raise GateError(f"{label} could not be read safely") from exc
    fingerprint = lambda value: (
        value.st_dev, value.st_ino, value.st_nlink, value.st_size,
        value.st_mtime_ns, value.st_ctime_ns,
    )
    require(fingerprint(before) == fingerprint(after), f"{label} changed while it was being read")
    require(len(raw) == before.st_size, f"{label} descriptor returned a partial read")
    require(canonical.resolve(strict=True) == canonical, f"{label} canonical target changed while it was being read")
    require(fingerprint(canonical.stat()) == fingerprint(before),
            f"{label} pathname no longer identifies the descriptor-read file")
    require(fingerprint(before_path) == fingerprint(before),
            f"{label} changed between pathname validation and descriptor open")
    try:
        payload = json.loads(raw.decode("utf-8", errors="strict"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise GateError(f"{label} is not valid UTF-8 JSON") from exc
    require(isinstance(payload, dict), f"{label} must be a JSON object")
    return payload, hashlib.sha256(raw).hexdigest()


def run(command: Sequence[str], label: str, *, binary: bool = False) -> bytes | str:
    completed = subprocess.run(command, cwd=ROOT, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if completed.returncode != 0:
        diagnostic = completed.stderr.decode("utf-8", errors="replace")[-3000:]
        raise GateError(f"{label} failed: {diagnostic}")
    return completed.stdout if binary else completed.stdout.decode("utf-8", errors="strict")


def ffprobe(path: Path) -> dict[str, Any]:
    raw = run([
        "ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", str(path)
    ], f"ffprobe {relative(path)}")
    try:
        return json.loads(str(raw))
    except json.JSONDecodeError as exc:
        raise GateError("ffprobe returned invalid JSON") from exc


def media_summary(path: Path) -> dict[str, Any]:
    probe = ffprobe(path)
    streams = probe.get("streams", [])
    videos = [row for row in streams if row.get("codec_type") == "video"]
    audios = [row for row in streams if row.get("codec_type") == "audio"]
    require(len(videos) == 1, f"{relative(path)} must contain exactly one video stream")
    duration = float(probe.get("format", {}).get("duration") or videos[0].get("duration") or 0)
    require(math.isfinite(duration) and duration > 0, f"{relative(path)} has no positive duration")
    video = videos[0]
    return {
        "durationSeconds": round(duration, 6),
        "videoStreamCount": len(videos),
        "audioStreamCount": len(audios),
        "width": int(video.get("width") or 0),
        "height": int(video.get("height") or 0),
        "videoCodec": video.get("codec_name"),
        "pixelFormat": video.get("pix_fmt"),
        "averageFrameRate": video.get("avg_frame_rate"),
        "frameCount": int(video["nb_frames"]) if str(video.get("nb_frames", "")).isdigit() else None,
        "audioCodec": audios[0].get("codec_name") if audios else None,
        "audioSampleRate": int(audios[0].get("sample_rate") or 0) if audios else None,
        "audioChannels": int(audios[0].get("channels") or 0) if audios else None,
    }


def frame_rate(value: str | None) -> float:
    if not value or "/" not in value:
        return 0.0
    numerator, denominator = value.split("/", 1)
    return float(numerator) / float(denominator) if float(denominator) else 0.0


def decoded_s16_peak(path: Path) -> int:
    raw = run([
        "ffmpeg", "-v", "error", "-i", str(path), "-map", "0:a:0", "-vn",
        "-ac", "2", "-ar", "48000", "-f", "s16le", "-"
    ], "decode compatibility silence", binary=True)
    content = bytes(raw)
    require(len(content) % 2 == 0, "decoded PCM byte count is not sample-aligned")
    if not content:
        return 0
    samples = array.array("h")
    samples.frombytes(content)
    if sys.byteorder != "little":
        samples.byteswap()
    return max(abs(int(sample)) for sample in samples)


def frame_hashes(path: Path, *, start: float = 0.0, duration: float | None = None) -> list[str]:
    command = ["ffmpeg", "-v", "error"]
    if start > 0:
        command += ["-ss", f"{start:.6f}"]
    command += ["-i", str(path)]
    if duration is not None:
        command += ["-t", f"{duration:.6f}"]
    command += ["-vf", "fps=2,scale=320:-2", "-an", "-f", "framemd5", "-"]
    text = str(run(command, f"sample frame diversity for {relative(path)}"))
    hashes = []
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        parts = [part.strip() for part in line.split(",")]
        if len(parts) >= 6 and re.fullmatch(r"[0-9a-f]{32}", parts[-1]):
            hashes.append(parts[-1])
    return hashes


def diversity(path: Path, *, start: float = 0.0, duration: float | None = None) -> dict[str, Any]:
    hashes = frame_hashes(path, start=start, duration=duration)
    require(len(hashes) >= 8, f"{relative(path)} produced too few diversity samples")
    unique = len(set(hashes))
    longest = 1
    run_length = 1
    for left, right in zip(hashes, hashes[1:]):
        run_length = run_length + 1 if left == right else 1
        longest = max(longest, run_length)
    return {
        "sampleRateFps": 2,
        "samples": len(hashes),
        "uniqueFrames": unique,
        "uniqueRatio": round(unique / len(hashes), 4),
        "longestIdenticalRunSamples": longest,
    }


def srt_seconds(value: str) -> float:
    match = SRT_TIME_RE.fullmatch(value.strip())
    require(match is not None, f"invalid SRT timestamp: {value!r}")
    h, m, s, ms = [int(part) for part in match.groups()]
    return h * 3600 + m * 60 + s + ms / 1000


def validate_srt(path: Path, duration: float) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    require("\r" not in text, "SRT must use canonical LF line endings")
    windows = []
    for line in text.splitlines():
        if " --> " not in line:
            continue
        start, end = line.split(" --> ", 1)
        windows.append((srt_seconds(start), srt_seconds(end)))
    require(windows, "SRT has no timed cues")
    previous = 0.0
    for start, end in windows:
        require(0 <= start < end <= duration + 0.05, "SRT cue is outside the final video")
        require(start + 1e-6 >= previous, "SRT cues overlap or are non-monotonic")
        previous = end
    return {"cues": len(windows), "firstStart": windows[0][0], "lastEnd": windows[-1][1]}


def evidence_runtime_sha(payload: dict[str, Any]) -> str:
    value = payload.get("deployedRuntimeSha")
    require(isinstance(value, str) and SHA_RE.fullmatch(value) is not None,
            "CAPTURE_REVIEW has no exact deployed runtime SHA")
    return value


def validate_bindings(
    *, expected_sha: str, expected_url: str, evidence_path: Path,
    interaction_path: Path, live_video: Path, allow_fixture: bool,
) -> tuple[dict[str, Any], dict[str, Any], str, str]:
    require(SHA_RE.fullmatch(expected_sha) is not None, "--expected-sha must be 40 lowercase hex characters")
    evidence, evidence_sha256 = read_json_snapshot(evidence_path, "CAPTURE_REVIEW")
    interaction, interaction_sha256 = read_json_snapshot(interaction_path, "interaction manifest")
    require(evidence.get("status") == "passed", "CAPTURE_REVIEW status is not passed")
    require(evidence_runtime_sha(evidence) == expected_sha, "CAPTURE_REVIEW exact SHA does not match --expected-sha")
    require(interaction.get("status") == "passed", "interaction manifest status is not passed")
    require(interaction.get("expectedRuntimeSha") == expected_sha, "interaction manifest exact SHA mismatch")
    require(interaction.get("publicUrl") == expected_url, "interaction manifest public origin mismatch")
    require(interaction.get("reviewerCredentialRendered") is False, "interaction manifest does not prove hidden credentials")
    require(interaction.get("evidenceManifestSha256") == evidence_sha256,
            "interaction manifest is not bound to these CAPTURE_REVIEW bytes")
    if not allow_fixture:
        require(evidence.get("schemaVersion") == 3, "CAPTURE_REVIEW schema version is not 3")
        capture_source = evidence.get("captureSourceHead")
        require(isinstance(capture_source, str) and SHA_RE.fullmatch(capture_source) is not None,
                "CAPTURE_REVIEW capture-source HEAD is missing or invalid")
        release_evidence = evidence.get("releaseEvidence")
        require(isinstance(release_evidence, dict)
                and release_evidence.get("schema") == "cloud-assistant-sentinel-v1",
                "CAPTURE_REVIEW release-evidence schema mismatch")
        require(interaction.get("mode") == "live", "production requires a live interaction manifest")
        require(interaction.get("submissionEligible") is True, "interaction is marked non-submission/draft")
        actions = interaction.get("actions")
        require(isinstance(actions, list), "interaction manifest has no ordered action log")
        required_markers = (
            "entered an original synthetic invoice in the public UI",
            "clicked Process invoice",
            "observed relevant read/analyze steps",
            "completed non-durable proposal and human-boundary copy",
        )
        required_actions = []
        for marker in required_markers:
            matches = [row for row in actions if isinstance(row, dict)
                       and marker.lower() in str(row.get("action", "")).lower()]
            require(len(matches) == 1, f"interaction action log must contain exactly one marker: {marker}")
            try:
                at_seconds = float(matches[0].get("atSeconds"))
            except (TypeError, ValueError):
                raise AssertionError(f"interaction action timestamp is invalid: {marker}")
            require(math.isfinite(at_seconds) and at_seconds >= 0,
                    f"interaction action timestamp is invalid: {marker}")
            required_actions.append((marker, at_seconds))
        edit = interaction.get("edit")
        require(isinstance(edit, dict), "interaction manifest has no highlight edit record")
        require(edit.get("finalSourceFrameRetained") is True,
                "interaction highlight does not retain the completed final browser state")
        require(float(edit.get("highlightWindowSeconds", 0)) == 9.0,
                "interaction highlight is not built for the canonical 9-second window")
        segments = edit.get("sourceSegments")
        require(isinstance(segments, list) and len(segments) >= 1,
                "interaction highlight has no source-segment record")
        normalized_segments = []
        for segment in segments:
            require(isinstance(segment, list) and len(segment) == 2,
                    "interaction highlight source segment is malformed")
            try:
                segment_start, segment_end = map(float, segment)
            except (TypeError, ValueError):
                raise AssertionError("interaction highlight source segment is malformed")
            require(math.isfinite(segment_start) and math.isfinite(segment_end)
                    and 0 <= segment_start < segment_end,
                    "interaction highlight source segment is invalid")
            normalized_segments.append((segment_start, segment_end))
        raw_duration = float(edit.get("rawDurationSeconds", -1))
        require(math.isfinite(raw_duration) and raw_duration > 0,
                "interaction highlight raw duration is invalid")
        for marker, at_seconds in required_actions:
            require(at_seconds <= raw_duration + 0.001,
                    f"interaction action lies outside the raw recording: {marker}")
            require(any(start - 0.001 <= at_seconds <= end + 0.001
                        for start, end in normalized_segments),
                    f"interaction action is not retained by the highlight: {marker}")
        final_segment = segments[-1]
        require(isinstance(final_segment, list) and len(final_segment) == 2,
                "interaction highlight final source segment is malformed")
        require(abs(float(final_segment[1]) - raw_duration) <= 0.001,
                "interaction highlight does not end at the final raw browser frame")
    raw = interaction.get("rawVideo")
    require(isinstance(raw, dict), "interaction manifest has no rawVideo record")
    require(raw.get("sha256") == sha256_file(live_video), "live video hash does not match interaction manifest")
    require(raw.get("path") == relative(live_video), "live video path does not match interaction manifest")
    return evidence, interaction, evidence_sha256, interaction_sha256


def atomic_copy(source: Path, destination: Path, scratch: Path, *, replace: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    require(replace or not destination.exists(), f"refusing to replace existing {relative(destination)} without --replace")
    scratch.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".writing", dir=scratch)
    os.close(fd)
    temporary = Path(temp_name)
    try:
        shutil.copyfile(source, temporary)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_json(payload: dict[str, Any], destination: Path, scratch: Path, *, replace: bool) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    require(replace or not destination.exists(), f"refusing to replace existing {relative(destination)} without --replace")
    scratch.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{destination.name}.", suffix=".writing", dir=scratch)
    os.close(fd)
    temporary = Path(temp_name)
    try:
        # Byte-exact LF output on every platform: these records are hash-bound
        # (the manifest binds the QA file's SHA-256), so a Windows text-mode CRLF
        # transform would break the committed binding on an LF checkout.
        temporary.write_bytes((json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8"))
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def compose(
    *, base_video: Path, live_video: Path, interaction_manifest: Path,
    evidence_manifest: Path, srt: Path, output_srt: Path, thumbnail: Path,
    output: Path, manifest_path: Path, qa_path: Path, scratch: Path,
    expected_sha: str, expected_url: str, overlay_start: float,
    overlay_end: float, replace: bool, allow_fixture: bool = False,
) -> dict[str, Any]:
    for path, label in ((base_video, "base video"), (live_video, "live video"),
                        (interaction_manifest, "interaction manifest"),
                        (evidence_manifest, "CAPTURE_REVIEW"), (srt, "SRT"),
                        (thumbnail, "thumbnail")):
        project_path(path, label, exists=True)
    require(output != base_video and output != live_video, "final output must not alias an input")
    require(0 <= overlay_start < overlay_end, "invalid live overlay window")
    window = overlay_end - overlay_start

    evidence, interaction, evidence_sha256, interaction_sha256 = validate_bindings(
        expected_sha=expected_sha, expected_url=expected_url,
        evidence_path=evidence_manifest, interaction_path=interaction_manifest,
        live_video=live_video, allow_fixture=allow_fixture,
    )
    thumbnail_sha256 = sha256_file(thumbnail)
    if not allow_fixture:
        evidence_artifacts = evidence.get("artifacts")
        evidence_final_media = evidence_artifacts.get("finalMedia") if isinstance(evidence_artifacts, dict) else None
        thumbnail_record = (
            evidence_final_media.get("autopilot-youtube-thumbnail.png")
            if isinstance(evidence_final_media, dict) else None
        )
        require(isinstance(thumbnail_record, dict), "CAPTURE_REVIEW does not bind the YouTube thumbnail")
        require(thumbnail_record.get("path") == relative(thumbnail), "CAPTURE_REVIEW thumbnail path mismatch")
        require(thumbnail_record.get("sha256") == thumbnail_sha256, "CAPTURE_REVIEW thumbnail hash mismatch")
    base = media_summary(base_video)
    live = media_summary(live_video)
    require(base["width"] == 1920 and base["height"] == 1080, "base video must be 1920x1080")
    require(base["audioStreamCount"] == 1, "base video must have one compatibility-silence stream")
    require(abs(frame_rate(base["averageFrameRate"]) - FPS) < 0.02, "base video must be 30 fps")
    require(live["audioStreamCount"] == 0, "live recorder must not capture any audio stream")
    require(live["width"] == 1920 and live["height"] == 1080, "live recording must be 1920x1080")
    require(live["durationSeconds"] >= 4.0, "live recording is too short to prove interaction")
    require(live["durationSeconds"] <= window + 1e-6,
            "live highlight exceeds the overlay window; completed browser state could be truncated")
    require(overlay_end <= base["durationSeconds"] + 1e-6, "live overlay extends past the base timeline")
    live_diversity = diversity(live_video, duration=float(live["durationSeconds"]))
    require(live_diversity["uniqueFrames"] >= 8 and live_diversity["uniqueRatio"] >= 0.25,
            "live recording is too static; genuine interaction motion was not demonstrated")
    srt_qa = validate_srt(srt, float(base["durationSeconds"]))

    scratch.mkdir(parents=True, exist_ok=True)
    fd, candidate_name = tempfile.mkstemp(prefix=".real-motion-", suffix=".rendering.mp4", dir=scratch)
    os.close(fd)
    candidate = Path(candidate_name)
    candidate.unlink(missing_ok=True)
    filter_graph = (
        f"[1:v]fps=30,scale=1424:800:force_original_aspect_ratio=decrease,"
        f"pad=1424:800:(ow-iw)/2:(oh-ih)/2:color=0x06110d,"
        f"tpad=stop_mode=clone:stop_duration={window:.6f},trim=duration={window:.6f},"
        f"setpts=PTS-STARTPTS+{overlay_start:.6f}/TB,"
        "drawbox=x=0:y=0:w=iw:h=ih:color=0x67e8b2:t=6[live];"
        f"[0:v][live]overlay=x=248:y=92:eof_action=pass:shortest=0:"
        f"enable='between(t,{overlay_start:.6f},{overlay_end:.6f})'[video]"
    )
    try:
        run([
            "ffmpeg", "-y", "-v", "error", "-i", str(base_video), "-i", str(live_video),
            "-filter_complex", filter_graph, "-map", "[video]", "-map", "0:a:0",
            "-map_metadata", "-1", "-c:v", "libx264", "-preset", "ultrafast" if allow_fixture else "medium", "-crf", "18",
            "-pix_fmt", "yuv420p", "-r", "30", "-c:a", "aac", "-b:a", "192k",
            "-ar", "48000", "-ac", "2", "-movflags", "+faststart",
            "-t", f"{base['durationSeconds']:.6f}", str(candidate),
        ], "compose real-motion final")
        final = media_summary(candidate)
        require(final["durationSeconds"] < STRICT_LIMIT_SECONDS, "final reaches the 175-second publication ceiling")
        require(abs(float(final["durationSeconds"]) - float(base["durationSeconds"])) <= 0.08,
                "final duration drifted from the caption timeline")
        require(final["width"] == 1920 and final["height"] == 1080, "final is not 1920x1080")
        require(final["videoCodec"] == "h264" and final["pixelFormat"] == "yuv420p",
                "final must be H.264/yuv420p")
        require(abs(frame_rate(final["averageFrameRate"]) - FPS) < 0.02, "final is not 30 fps")
        require(final["audioStreamCount"] == 1 and final["audioCodec"] == "aac",
                "final must contain exactly one AAC compatibility-silence stream")
        require(final["audioSampleRate"] == 48000 and final["audioChannels"] == 2,
                "final compatibility stream must be 48 kHz stereo")
        peak = decoded_s16_peak(candidate)
        require(peak <= 8, f"final audio is not digital silence (decoded signed-16 peak {peak})")
        overlay_diversity = diversity(candidate, start=overlay_start, duration=window)
        require(overlay_diversity["uniqueFrames"] >= 8 and overlay_diversity["uniqueRatio"] >= 0.25,
                "shipped overlay window does not retain real motion")
        require(sha256_file(evidence_manifest) == evidence_sha256,
                "CAPTURE_REVIEW changed after validation while the final was composed")
        require(sha256_file(interaction_manifest) == interaction_sha256,
                "interaction manifest changed after validation while the final was composed")
        require(sha256_file(thumbnail) == thumbnail_sha256,
                "YouTube thumbnail changed after validation while the final was composed")

        output.parent.mkdir(parents=True, exist_ok=True)
        require(replace or not output.exists(), f"refusing to replace existing {relative(output)} without --replace")
        os.replace(candidate, output)
    finally:
        candidate.unlink(missing_ok=True)

    atomic_copy(srt, output_srt, scratch, replace=replace) if srt != output_srt else None
    output_srt = srt if srt == output_srt else output_srt
    output_srt_qa = validate_srt(output_srt, float(final["durationSeconds"]))
    final_sha = sha256_file(output)
    qa = {
        "schemaVersion": 1,
        "status": "passed",
        "duration": {"baseSeconds": base["durationSeconds"], "finalSeconds": final["durationSeconds"], "limitSeconds": 175},
        "video": final,
        "audio": {"policy": "locally-generated compatibility silence", "decodedPeakS16": peak, "tts": False, "music": False},
        "subtitles": output_srt_qa,
        "liveInputFrameDiversity": live_diversity,
        "shippedOverlayFrameDiversity": overlay_diversity,
        "overlayWindow": {"startSeconds": overlay_start, "endSeconds": overlay_end},
        "liveInputFullyConsumed": True,
        "reviewerCredentialRendered": False,
    }
    manifest = {
        "schemaVersion": 1,
        "status": "passed",
        "builder": "caption-led-real-motion-compositor-v1",
        "generatedAt": dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "exactRuntimeSource": expected_sha,
        "publicUrl": expected_url,
        "rightsProfile": {"voice": False, "tts": False, "thirdPartyMusic": False, "audio": "locally generated digital silence"},
        "evidence": {"captureReviewPath": relative(evidence_manifest), "captureReviewSha256": evidence_sha256},
        "liveInteraction": {
            "manifestPath": relative(interaction_manifest),
            "manifestSha256": interaction_sha256,
            "videoPath": relative(live_video),
            "videoSha256": sha256_file(live_video),
            "actions": interaction.get("actions", []),
            "overlayStartSeconds": overlay_start,
            "overlayEndSeconds": overlay_end,
            "liveInputFullyConsumed": True,
        },
        "inputs": {
            "baseVideo": {"path": relative(base_video), "sha256": sha256_file(base_video)},
            "subtitles": {"path": relative(srt), "sha256": sha256_file(srt)},
            "thumbnail": {"path": relative(thumbnail), "sha256": thumbnail_sha256},
        },
        "outputs": {
            "video": {"path": relative(output), "sha256": final_sha, **final},
            "subtitles": {"path": relative(output_srt), "sha256": sha256_file(output_srt), **output_srt_qa},
            "thumbnail": {"path": relative(thumbnail), "sha256": thumbnail_sha256},
            "qa": {"path": relative(qa_path)},
        },
        "claimBoundary": "Live footage demonstrates interaction with the deployed app; benchmark and security claims remain bounded by CAPTURE_REVIEW and the existing caption source.",
    }
    atomic_json(qa, qa_path, scratch, replace=replace)
    manifest["outputs"]["qa"]["sha256"] = sha256_file(qa_path)
    atomic_json(manifest, manifest_path, scratch, replace=replace)
    return {"manifest": manifest, "qa": qa}


def verify_existing(manifest_path: Path, qa_path: Path, *, allow_fixture: bool = False) -> dict[str, Any]:
    """Re-measure a built final without trusting the build-time QA record."""
    manifest = read_json(manifest_path, "real-motion manifest")
    qa = read_json(qa_path, "real-motion QA")
    require(manifest.get("status") == "passed" and qa.get("status") == "passed",
            "final manifest or QA status is not passed")
    expected_sha = str(manifest.get("exactRuntimeSource") or "")
    expected_url = str(manifest.get("publicUrl") or "")
    evidence_record = manifest.get("evidence")
    live_record = manifest.get("liveInteraction")
    outputs = manifest.get("outputs")
    require(isinstance(evidence_record, dict) and isinstance(live_record, dict) and isinstance(outputs, dict),
            "final manifest is missing evidence/live/output records")
    evidence_path = project_path(str(evidence_record.get("captureReviewPath") or ""), "CAPTURE_REVIEW", exists=True)
    interaction_path = project_path(str(live_record.get("manifestPath") or ""), "interaction manifest", exists=True)
    live_video = project_path(str(live_record.get("videoPath") or ""), "live video", exists=True)
    video_record = outputs.get("video")
    subtitle_record = outputs.get("subtitles")
    thumbnail_record = outputs.get("thumbnail")
    qa_record = outputs.get("qa")
    require(all(isinstance(row, dict) for row in (video_record, subtitle_record, thumbnail_record, qa_record)),
            "final manifest has incomplete output records")
    final_video = project_path(str(video_record.get("path") or ""), "final video", exists=True)
    subtitles = project_path(str(subtitle_record.get("path") or ""), "final subtitles", exists=True)
    thumbnail = project_path(str(thumbnail_record.get("path") or ""), "thumbnail", exists=True)
    require(project_path(str(qa_record.get("path") or ""), "manifest QA", exists=True) == qa_path,
            "--qa does not match the manifest QA path")

    _evidence, _interaction, evidence_sha256, interaction_sha256 = validate_bindings(
        expected_sha=expected_sha,
        expected_url=expected_url,
        evidence_path=evidence_path,
        interaction_path=interaction_path,
        live_video=live_video,
        allow_fixture=allow_fixture,
    )
    require(evidence_record.get("captureReviewSha256") == evidence_sha256, "CAPTURE_REVIEW hash drift")
    require(live_record.get("manifestSha256") == interaction_sha256, "interaction manifest hash drift")
    require(live_record.get("videoSha256") == sha256_file(live_video), "live video hash drift")
    require(video_record.get("sha256") == sha256_file(final_video), "final video hash drift")
    require(subtitle_record.get("sha256") == sha256_file(subtitles), "subtitle hash drift")
    require(thumbnail_record.get("sha256") == sha256_file(thumbnail), "thumbnail hash drift")
    require(qa_record.get("sha256") == sha256_file(qa_path), "QA hash drift")

    measured = media_summary(final_video)
    require(measured["durationSeconds"] < STRICT_LIMIT_SECONDS, "final reaches the 175-second publication ceiling")
    require(measured["width"] == 1920 and measured["height"] == 1080, "final is not 1920x1080")
    require(measured["videoCodec"] == "h264" and measured["pixelFormat"] == "yuv420p", "final is not H.264/yuv420p")
    require(abs(frame_rate(measured["averageFrameRate"]) - FPS) < 0.02, "final is not 30 fps")
    require(measured["audioStreamCount"] == 1 and measured["audioCodec"] == "aac", "final lacks one AAC silence stream")
    require(measured["audioSampleRate"] == 48000 and measured["audioChannels"] == 2,
            "final silence stream is not 48 kHz stereo")
    peak = decoded_s16_peak(final_video)
    require(peak <= 8, f"final audio is not digital silence (decoded signed-16 peak {peak})")
    srt_qa = validate_srt(subtitles, float(measured["durationSeconds"]))
    start = float(live_record.get("overlayStartSeconds"))
    end = float(live_record.get("overlayEndSeconds"))
    require(0 <= start < end <= float(measured["durationSeconds"]), "manifest overlay window is invalid")
    live_measured = media_summary(live_video)
    require(float(live_measured["durationSeconds"]) <= end - start + 1e-6,
            "live highlight now exceeds the manifest overlay window")
    require(live_record.get("liveInputFullyConsumed") is True and qa.get("liveInputFullyConsumed") is True,
            "build records do not attest full live-highlight consumption")
    live_motion = diversity(live_video, duration=float(live_measured["durationSeconds"]))
    shipped_motion = diversity(final_video, start=start, duration=end - start)
    require(live_motion["uniqueFrames"] >= 8 and live_motion["uniqueRatio"] >= 0.25,
            "live input no longer proves genuine frame motion")
    require(shipped_motion["uniqueFrames"] >= 8 and shipped_motion["uniqueRatio"] >= 0.25,
            "shipped overlay no longer retains genuine frame motion")
    require(qa.get("audio", {}).get("decodedPeakS16") == peak, "build-time QA audio result differs from re-measurement")
    require(qa.get("subtitles", {}).get("cues") == srt_qa["cues"], "build-time QA subtitle result differs from re-measurement")
    return {
        "exactRuntimeSource": expected_sha,
        "durationSeconds": measured["durationSeconds"],
        "decodedPeakS16": peak,
        "subtitleCues": srt_qa["cues"],
        "liveFrameDiversity": live_motion,
        "shippedFrameDiversity": shipped_motion,
    }


def self_test() -> int:
    root = project_path(".artifacts/final-video/compositor-selftest", "self-test root")
    if root.exists():
        shutil.rmtree(root)
    root.mkdir(parents=True)
    sha = "1" * 40
    base = root / "base.mp4"
    live = root / "live.mp4"
    thumbnail = root / "thumbnail.png"
    srt = root / "captions.srt"
    evidence = root / "CAPTURE_REVIEW.json"
    interaction = root / "interaction.json"
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x071b16:s=1920x1080:r=30:d=12",
         "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-t", "12",
         "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(base)], "make self-test base")
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=5",
         "-an", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", str(live)], "make self-test live motion")
    run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=c=0x0b211a:s=1280x720", "-frames:v", "1", str(thumbnail)], "make self-test thumbnail")
    srt.write_text("1\n00:00:00,000 --> 00:00:06,000\nSynthetic compositor test.\n\n2\n00:00:06,000 --> 00:00:12,000\nNot submission evidence.\n", encoding="utf-8")
    evidence.write_text(json.dumps({"status": "passed", "deployedRuntimeSha": sha}) + "\n", encoding="utf-8")
    interaction.write_text(json.dumps({
        "status": "passed", "mode": "fixture", "submissionEligible": False,
        "expectedRuntimeSha": sha, "publicUrl": DEFAULT_URL,
        "reviewerCredentialRendered": False,
        "evidenceManifestSha256": sha256_file(evidence),
        "rawVideo": {"path": relative(live), "sha256": sha256_file(live)},
        "actions": ["synthetic motion fixture"],
    }) + "\n", encoding="utf-8")
    compose(
        base_video=base, live_video=live, interaction_manifest=interaction,
        evidence_manifest=evidence, srt=srt, output_srt=root / "final.srt",
        thumbnail=thumbnail, output=root / "final.mp4", manifest_path=root / "final.manifest.json",
        qa_path=root / "final.qa.json", scratch=root / "scratch", expected_sha=sha,
        expected_url=DEFAULT_URL, overlay_start=1, overlay_end=7, replace=False,
        allow_fixture=True,
    )
    verify_existing(root / "final.manifest.json", root / "final.qa.json", allow_fixture=True)
    original_evidence = evidence.read_bytes()
    mutation = threading.Timer(
        1.0,
        lambda: evidence.write_text(
            json.dumps({"status": "passed", "deployedRuntimeSha": sha, "changedDuringCompose": True}) + "\n",
            encoding="utf-8",
        ),
    )
    mutation.start()
    try:
        try:
            compose(
                base_video=base, live_video=live, interaction_manifest=interaction,
                evidence_manifest=evidence, srt=srt, output_srt=root / "drift-final.srt",
                thumbnail=thumbnail, output=root / "drift-final.mp4",
                manifest_path=root / "drift-final.manifest.json", qa_path=root / "drift-final.qa.json",
                scratch=root / "drift-scratch", expected_sha=sha, expected_url=DEFAULT_URL,
                overlay_start=1, overlay_end=7, replace=False, allow_fixture=True,
            )
        except GateError as exc:
            require(
                "CAPTURE_REVIEW changed after validation while the final was composed" in str(exc),
                f"unexpected evidence-drift rejection: {exc}",
            )
        else:
            raise GateError("compositor accepted CAPTURE_REVIEW bytes changed after validation")
        require(not (root / "drift-final.mp4").exists(),
                "evidence drift must fail before promoting an unbound final video")
    finally:
        mutation.cancel()
        evidence.write_bytes(original_evidence)
    print("real-motion compositor self-test: PASS · 1080p/30fps · genuine frame diversity · silent AAC · SRT sync")
    return 0


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--base-video")
    parser.add_argument("--live-video")
    parser.add_argument("--interaction-manifest")
    parser.add_argument("--evidence-manifest", default="demo/gallery/CAPTURE_REVIEW.json")
    parser.add_argument("--srt", default=DEFAULT_SRT_OUTPUT)
    parser.add_argument("--output-srt", default=DEFAULT_SRT_OUTPUT)
    parser.add_argument("--thumbnail", default=DEFAULT_THUMBNAIL)
    parser.add_argument("--output", default=DEFAULT_OUTPUT)
    parser.add_argument("--manifest", default=DEFAULT_MANIFEST)
    parser.add_argument("--qa", default=DEFAULT_QA)
    parser.add_argument("--scratch", default=".artifacts/final-video/compose")
    parser.add_argument("--expected-sha")
    parser.add_argument("--expected-url", default=DEFAULT_URL)
    parser.add_argument("--overlay-start", type=float, default=19.0)
    parser.add_argument("--overlay-end", type=float, default=28.0)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.self_test:
            return self_test()
        if args.verify_only:
            verified = verify_existing(
                project_path(args.manifest, "manifest", exists=True),
                project_path(args.qa, "QA", exists=True),
            )
            print(
                f"real-motion verify: PASS · {verified['durationSeconds']:.3f}s · "
                f"silent peak {verified['decodedPeakS16']} · {verified['subtitleCues']} SRT cues · "
                f"exact SHA {verified['exactRuntimeSource'][:12]}"
            )
            return 0
        for name in ("base_video", "live_video", "interaction_manifest", "expected_sha"):
            require(getattr(args, name) is not None, f"--{name.replace('_', '-')} is required")
        output = project_path(args.output, "output")
        manifest = project_path(args.manifest, "manifest")
        qa = project_path(args.qa, "QA")
        output_srt = project_path(args.output_srt, "output SRT")
        require(output.parent == ROOT / "demo" / "final-media", "final MP4 must be directly under demo/final-media")
        require(manifest.parent == output.parent and qa.parent == output.parent and output_srt.parent == output.parent,
                "final sidecars must be directly under demo/final-media")
        compose(
            base_video=project_path(args.base_video, "base video", exists=True),
            live_video=project_path(args.live_video, "live video", exists=True),
            interaction_manifest=project_path(args.interaction_manifest, "interaction manifest", exists=True),
            evidence_manifest=project_path(args.evidence_manifest, "CAPTURE_REVIEW", exists=True),
            srt=project_path(args.srt, "SRT", exists=True), output_srt=output_srt,
            thumbnail=project_path(args.thumbnail, "thumbnail", exists=True), output=output,
            manifest_path=manifest, qa_path=qa, scratch=project_path(args.scratch, "scratch"),
            expected_sha=str(args.expected_sha), expected_url=str(args.expected_url),
            overlay_start=args.overlay_start, overlay_end=args.overlay_end, replace=args.replace,
        )
        print(f"real-motion video: PASS · {relative(output)} · exact SHA {args.expected_sha[:12]} · live window {args.overlay_start:.1f}-{args.overlay_end:.1f}s")
        return 0
    except (GateError, OSError, UnicodeError, ValueError) as exc:
        print(f"real-motion video: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
