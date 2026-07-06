#!/usr/bin/env python3
"""Generate the demo sample invoice image (demo/sample-invoice.png).

A REAL, rasterized vendor invoice — the artifact the UI's "Use sample document"
button uploads so a judge can exercise the genuine Qwen-VL vision-extraction path
end to end (image in -> structured invoice out -> the multi-step approval loop).

Deliberately uses only universal financial terms (vendor, invoice number, tax id,
subtotal, tax, total). Requires Pillow:  pip install pillow

    python scripts/make-sample-invoice.py

Commit the output PNG. Regenerate only if the sample content changes.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "demo" / "sample-invoice.png"

W, H = 1000, 1300
BG = (255, 255, 255)
INK = (17, 24, 39)
MUTED = (100, 116, 139)
LINE = (203, 213, 225)
ACCENT = (37, 99, 235)


def _font(size: int, bold: bool = False):
    names = (
        ["arialbd.ttf", "DejaVuSans-Bold.ttf"] if bold else ["arial.ttf", "DejaVuSans.ttf"]
    )
    for n in names:
        try:
            return ImageFont.truetype(n, size)
        except OSError:
            continue
    return ImageFont.load_default()


def main() -> None:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    f_title = _font(54, bold=True)
    f_h = _font(26, bold=True)
    f = _font(24)
    f_sm = _font(20)

    # Header
    d.text((60, 60), "INVOICE", font=f_title, fill=INK)
    d.rectangle([60, 130, 260, 138], fill=ACCENT)

    # Vendor block (top-right)
    d.text((600, 66), "Meridian Logistics", font=f_h, fill=INK)
    for i, ln in enumerate(
        ["48 Harbour Way", "Rotterdam Business Park", "Tax ID: TAX-ML-88231"]
    ):
        d.text((600, 108 + i * 30), ln, font=f_sm, fill=MUTED)

    # Meta
    y = 200
    for label, val in [
        ("Invoice number", "ML-2026-0417"),
        ("Invoice date", "2026-06-30"),
        ("Payment due", "2026-07-30"),
        ("Currency", "EUR"),
    ]:
        d.text((60, y), label, font=f_sm, fill=MUTED)
        d.text((320, y), val, font=f, fill=INK)
        y += 42

    # Bill-to
    d.text((600, 200), "Bill to", font=f_sm, fill=MUTED)
    d.text((600, 230), "Archon Autopilot Demo Co.", font=f, fill=INK)

    # Line-items table
    ty = 420
    d.rectangle([60, ty, W - 60, ty + 48], fill=(241, 245, 249))
    d.text((72, ty + 12), "Description", font=f_h, fill=INK)
    d.text((640, ty + 12), "Qty", font=f_h, fill=INK)
    d.text((730, ty + 12), "Unit price", font=f_h, fill=INK)
    d.text((880, ty + 12), "Amount", font=f_h, fill=INK)

    rows = [
        ("Freight and warehousing - June", "1", "5,200.00", "5,200.00"),
    ]
    ry = ty + 48
    for desc, qty, unit, amt in rows:
        d.text((72, ry + 14), desc, font=f, fill=INK)
        d.text((640, ry + 14), qty, font=f, fill=INK)
        d.text((730, ry + 14), unit, font=f, fill=INK)
        d.text((880, ry + 14), amt, font=f, fill=INK)
        d.line([60, ry + 56, W - 60, ry + 56], fill=LINE, width=1)
        ry += 56

    # Totals
    sy = ry + 40
    for label, val, bold in [
        ("Subtotal", "5,200.00", False),
        ("Tax (24%)", "1,248.00", False),
        ("Total due", "EUR 6,448.00", True),
    ]:
        ff = f_h if bold else f
        d.text((640, sy), label, font=ff, fill=INK if bold else MUTED)
        d.text((820, sy), val, font=ff, fill=INK)
        if bold:
            d.line([640, sy - 12, W - 60, sy - 12], fill=INK, width=2)
        sy += 44

    # Footer
    d.text(
        (60, H - 80),
        "Thank you for your business. Payment terms: net 30.",
        font=f_sm,
        fill=MUTED,
    )

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, format="PNG", optimize=True)
    print(f"wrote {OUT} ({OUT.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
