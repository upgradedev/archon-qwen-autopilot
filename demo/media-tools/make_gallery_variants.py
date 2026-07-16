#!/usr/bin/env python3
"""Create metadata-free 1500×1000 Devpost variants without cropping 16:9 evidence."""

from __future__ import annotations

import os
import sys
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[2]
EXPECTED_SOURCES = {
    "autopilot-live-intake-pending.png": "autopilot-01-live-intake-pending.png",
    "autopilot-human-amend-diff.png": "autopilot-02-human-amend-diff.png",
    "autopilot-correction-learning.png": "autopilot-03-correction-learning.png",
    "autopilot-security-pending.png": "autopilot-04-security-pending.png",
    "autopilot-alibaba-proof.png": "autopilot-05-alibaba-qwen-proof.png",
}


def contained(raw: str) -> Path:
    value = Path(raw).resolve()
    try:
        value.relative_to(ROOT)
    except ValueError as exc:
        raise SystemExit(f"refusing gallery path outside repository: {raw}") from exc
    return value


def main() -> int:
    if len(sys.argv) != 1 + 2 * len(EXPECTED_SOURCES):
        raise SystemExit(f"expected {len(EXPECTED_SOURCES)} source/destination pairs")
    pairs = list(zip(sys.argv[1::2], sys.argv[2::2]))
    observed = {}
    for source_raw, destination_raw in pairs:
        source = contained(source_raw)
        destination = contained(destination_raw)
        expected_destination = EXPECTED_SOURCES.get(source.name)
        if expected_destination != destination.name:
            raise SystemExit(f"invalid gallery mapping: {source.name} -> {destination.name}")
        if not source.is_file():
            raise SystemExit(f"missing 16:9 source: {source}")
        with Image.open(source) as image:
            if image.size != (1920, 1080) or image.mode != "RGB":
                raise SystemExit(f"unexpected source format for {source.name}: {image.size} {image.mode}")
            # Scale the complete 16:9 frame into 1500×844 and center it vertically.
            # The 78px top/bottom matte produces exact 3:2 without losing a pixel.
            resized = image.resize((1500, 844), Image.Resampling.LANCZOS)
            canvas = Image.new("RGB", (1500, 1000), (7, 11, 18))
            canvas.paste(resized, (0, 78))
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(".rendering.png")
            canvas.save(temporary, format="PNG", optimize=True)
        os.replace(temporary, destination)
        with Image.open(destination) as verified:
            if verified.size != (1500, 1000) or verified.mode != "RGB" or verified.info:
                raise SystemExit(f"gallery sanitization failed for {destination.name}")
        observed[source.name] = destination.name
    if observed != EXPECTED_SOURCES:
        raise SystemExit("incomplete gallery mapping")
    print(f"[gallery] {len(observed)} metadata-free 1500x1000 no-crop variants")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
