#!/usr/bin/env python3
"""One-command final Autopilot render: caption-only base + real live motion."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Sequence

import compose_real_motion_video as motion


ROOT = Path(__file__).resolve().parents[2]
REQUIRED_FINALS = (
    "autopilot-live-intake-pending.png",
    "autopilot-human-amend-diff.png",
    "autopilot-correction-learning.png",
    "autopilot-security-pending.png",
    "autopilot-alibaba-proof.png",
    "autopilot-youtube-thumbnail.png",
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


def evidence(path: Path, expected_sha: str) -> tuple[dict[str, Any], str]:
    payload, evidence_sha256 = motion.read_json_snapshot(path, "CAPTURE_REVIEW")
    require(payload.get("status") == "passed", "CAPTURE_REVIEW status is not passed")
    require(payload.get("schemaVersion") == 3, "CAPTURE_REVIEW schema version is not 3")
    require(payload.get("deployedRuntimeSha") == expected_sha, "CAPTURE_REVIEW deployed runtime SHA mismatch")
    capture_source = payload.get("captureSourceHead")
    require(isinstance(capture_source, str) and motion.SHA_RE.fullmatch(capture_source) is not None,
            "CAPTURE_REVIEW capture-source HEAD is missing or invalid")
    release_evidence = payload.get("releaseEvidence")
    require(isinstance(release_evidence, dict)
            and release_evidence.get("schema") == "cloud-assistant-sentinel-v1",
            "CAPTURE_REVIEW release-evidence schema mismatch")
    require(payload.get("publicUrl") == motion.DEFAULT_URL, "CAPTURE_REVIEW public URL mismatch")
    gates = payload.get("gates")
    require(isinstance(gates, dict) and gates.get("pendingCleanupZero") is True,
            "CAPTURE_REVIEW does not prove zero capture PENDING residue")
    models = payload.get("models")
    require(isinstance(models, dict), "CAPTURE_REVIEW has no model binding")
    require(models.get("decision") == "qwen-plus", "final decision model is not qwen-plus")
    require(models.get("vision") == "qwen-vl-max", "final vision model is not qwen-vl-max")
    require(models.get("embedding") == "text-embedding-v4", "final embedding model is not text-embedding-v4")
    artifacts = payload.get("artifacts")
    final_media = artifacts.get("finalMedia") if isinstance(artifacts, dict) else None
    require(isinstance(final_media, dict), "CAPTURE_REVIEW has no finalMedia inventory")
    for name in REQUIRED_FINALS:
        record = final_media.get(name)
        require(isinstance(record, dict), f"CAPTURE_REVIEW does not bind {name}")
        file = motion.project_path(f"demo/final-media/{name}", name, exists=True)
        require(record.get("path") == motion.relative(file), f"CAPTURE_REVIEW path mismatch for {name}")
        require(record.get("sha256") == sha256_file(file), f"CAPTURE_REVIEW hash mismatch for {name}")
    architecture_record = artifacts.get("architecture")
    require(isinstance(architecture_record, dict), "CAPTURE_REVIEW does not bind the architecture asset")
    architecture = motion.project_path("demo/final-media/judge-architecture.jpg", "architecture", exists=True)
    require(architecture_record.get("path") == motion.relative(architecture),
            "CAPTURE_REVIEW architecture path mismatch")
    require(architecture_record.get("sha256") == sha256_file(architecture),
            "CAPTURE_REVIEW architecture hash mismatch")
    require(sha256_file(path) == evidence_sha256,
            "CAPTURE_REVIEW changed while its bound media inventory was validated")
    return payload, evidence_sha256


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--expected-sha", required=True)
    parser.add_argument("--live-video", default=".artifacts/final-video/autopilot-live-interaction.mp4")
    parser.add_argument("--interaction-manifest", default=".artifacts/final-video/autopilot-live-interaction.manifest.json")
    parser.add_argument("--capture-review", default="demo/gallery/CAPTURE_REVIEW.json")
    parser.add_argument("--thumbnail", default="demo/final-media/autopilot-youtube-thumbnail.png")
    parser.add_argument("--output", default="demo/final-media/autopilot-demo.mp4")
    parser.add_argument("--srt-output", default="demo/final-media/autopilot-demo.en.srt")
    parser.add_argument("--manifest", default="demo/final-media/autopilot-demo.real-motion.json")
    parser.add_argument("--qa", default="demo/final-media/autopilot-demo.qa.json")
    parser.add_argument("--scratch", default=".artifacts/final-video")
    parser.add_argument("--overlay-start", type=float, default=19.0)
    parser.add_argument("--overlay-end", type=float, default=28.0)
    parser.add_argument("--replace", action="store_true")
    return parser.parse_args(argv)


def main(argv: Sequence[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        expected_sha = str(args.expected_sha).lower()
        require(motion.SHA_RE.fullmatch(expected_sha) is not None, "--expected-sha must be 40 lowercase hex characters")
        capture_review = motion.project_path(args.capture_review, "CAPTURE_REVIEW", exists=True)
        review, review_sha256 = evidence(capture_review, expected_sha)
        live_video = motion.project_path(args.live_video, "live video", exists=True)
        interaction_manifest = motion.project_path(args.interaction_manifest, "interaction manifest", exists=True)
        thumbnail = motion.project_path(args.thumbnail, "thumbnail", exists=True)
        output = motion.project_path(args.output, "output")
        output_srt = motion.project_path(args.srt_output, "SRT output")
        manifest_path = motion.project_path(args.manifest, "manifest")
        qa_path = motion.project_path(args.qa, "QA")
        scratch_root = motion.project_path(args.scratch, "scratch")
        require(motion.relative(scratch_root).startswith(".artifacts/final-video"), "scratch must stay under .artifacts/final-video")
        for final in (output, output_srt, manifest_path, qa_path):
            require(final.parent == ROOT / "demo" / "final-media", "final files must be directly under demo/final-media")
            require(args.replace or not final.exists(), f"refusing to replace existing {motion.relative(final)} without --replace")

        session = scratch_root / f"base-{expected_sha[:12]}-{secrets.token_hex(8)}"
        session.mkdir(parents=True, exist_ok=False)
        asset_snapshot = session / "assets"
        asset_snapshot.mkdir()
        snapshot_hashes: dict[Path, str] = {}
        final_media_records = review["artifacts"]["finalMedia"]
        for name in REQUIRED_FINALS:
            source = motion.project_path(f"demo/final-media/{name}", name, exists=True)
            destination = asset_snapshot / name
            shutil.copyfile(source, destination)
            expected = str(final_media_records[name]["sha256"])
            require(sha256_file(destination) == expected,
                    f"immutable renderer snapshot hash mismatch for {name}")
            snapshot_hashes[destination] = expected
        architecture_source = motion.project_path(
            str(review["artifacts"]["architecture"]["path"]), "architecture", exists=True,
        )
        architecture_snapshot = asset_snapshot / architecture_source.name
        shutil.copyfile(architecture_source, architecture_snapshot)
        architecture_sha256 = str(review["artifacts"]["architecture"]["sha256"])
        require(sha256_file(architecture_snapshot) == architecture_sha256,
                "immutable renderer snapshot hash mismatch for architecture")
        snapshot_hashes[architecture_snapshot] = architecture_sha256
        base_video = session / "caption-base.mp4"
        base_srt = session / "caption-base.en.srt"
        base_manifest = session / "caption-base.caption-only.json"
        base_work = session / "render"
        models = review["models"]
        environment = {
            **os.environ,
            "CAPTION_ONLY": "true",
            "PUBLIC_APP_URL": motion.DEFAULT_URL,
            "VIDEO_MODEL_LABEL": f"{models['decision']} · {models['vision']} · {models['embedding']}",
            "ASSETS_DIR": str(asset_snapshot),
            "OUTPUT": str(base_video),
            "SRT_OUTPUT": str(base_srt),
            "CAPTION_MANIFEST_OUTPUT": str(base_manifest),
            "WORKDIR": str(base_work),
            "FPS": "30",
        }
        built = subprocess.run(
            [sys.executable, str(ROOT / "scripts" / "build_video.py")],
            cwd=ROOT,
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )
        if built.returncode != 0:
            raise motion.GateError(f"caption-only base renderer failed: {built.stderr[-3000:]}")
        for snapshot_path, expected_hash in snapshot_hashes.items():
            require(sha256_file(snapshot_path) == expected_hash,
                    f"renderer asset snapshot changed during caption build: {snapshot_path.name}")
        require(sha256_file(capture_review) == review_sha256,
                "CAPTURE_REVIEW changed after validation while the caption base was rendered")
        result = motion.compose(
            base_video=base_video,
            live_video=live_video,
            interaction_manifest=interaction_manifest,
            evidence_manifest=capture_review,
            srt=base_srt,
            output_srt=output_srt,
            thumbnail=thumbnail,
            output=output,
            manifest_path=manifest_path,
            qa_path=qa_path,
            scratch=session / "compose",
            expected_sha=expected_sha,
            expected_url=motion.DEFAULT_URL,
            overlay_start=args.overlay_start,
            overlay_end=args.overlay_end,
            replace=args.replace,
        )
        require(sha256_file(capture_review) == review_sha256,
                "CAPTURE_REVIEW changed while the final submission was composed")
        for name in REQUIRED_FINALS:
            canonical = motion.project_path(f"demo/final-media/{name}", name, exists=True)
            require(sha256_file(canonical) == str(final_media_records[name]["sha256"]),
                    f"canonical evidence asset changed during final build: {name}")
        require(sha256_file(architecture_source) == architecture_sha256,
                "canonical architecture asset changed during final build")
        duration = result["qa"]["duration"]["finalSeconds"]
        print(
            f"Autopilot real-motion submission: PASS · {duration:.3f}s · 1920x1080 · "
            f"silent/caption-led · exact SHA {expected_sha[:12]} · base retained in {motion.relative(session)}"
        )
        return 0
    except (motion.GateError, OSError, UnicodeError, ValueError, KeyError) as exc:
        print(f"Autopilot real-motion submission: FAIL · {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
