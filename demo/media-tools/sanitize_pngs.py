#!/usr/bin/env python3
"""Metadata-strip and validate Autopilot final-media PNG candidates in place."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
EXPECTED = {
    "autopilot-live-intake-pending.png": (1920, 1080),
    "autopilot-human-amend-diff.png": (1920, 1080),
    "autopilot-correction-learning.png": (1920, 1080),
    "autopilot-security-pending.png": (1920, 1080),
    "autopilot-alibaba-proof.png": (1920, 1080),
    "autopilot-youtube-thumbnail.png": (1280, 720),
}


def contained(path: Path) -> Path:
    resolved = path.resolve()
    try:
        resolved.relative_to(ROOT)
    except ValueError as exc:
        raise SystemExit(f"refusing PNG outside repository: {path}") from exc
    return resolved


def sanitize(path: Path) -> None:
    expected = EXPECTED.get(path.name)
    if expected is None:
        raise SystemExit(f"unexpected final-media filename: {path.name}")
    if not path.is_file() or path.stat().st_size < 1_000:
        raise SystemExit(f"missing or tiny PNG: {path}")
    with Image.open(path) as image:
        image.verify()
    with Image.open(path) as image:
        if image.format != "PNG":
            raise SystemExit(f"not a PNG: {path}")
        if image.size != expected:
            raise SystemExit(f"wrong dimensions for {path.name}: {image.size} != {expected}")
        clean = image.convert("RGB")
        temporary = path.with_suffix(".sanitizing.png")
        clean.save(temporary, format="PNG", optimize=True)
    os.replace(temporary, path)
    with Image.open(path) as verified:
        if verified.info:
            raise SystemExit(f"metadata remained in {path.name}: {sorted(verified.info)}")
        if verified.size != expected or verified.mode != "RGB":
            raise SystemExit(f"post-sanitize validation failed for {path.name}")


def main() -> int:
    if len(sys.argv) != len(EXPECTED) + 1:
        raise SystemExit(f"expected exactly {len(EXPECTED)} PNG paths")
    paths = [contained(Path(raw)) for raw in sys.argv[1:]]
    if {path.name for path in paths} != set(EXPECTED):
        raise SystemExit("the complete exact final-media filename set is required")
    for path in paths:
        sanitize(path)
    print(f"[sanitize] {len(paths)} PNGs re-encoded as metadata-free RGB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
