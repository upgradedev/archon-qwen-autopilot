"""Generate the original synthetic Qwen-VL invoice benchmark in-repo.

The script is deterministic. It reads only manifest.json and writes only the
assets/ directory next to itself. No downloaded templates, fonts, or logos.
"""

from __future__ import annotations

import json
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas

ROOT = Path(__file__).resolve().parent
MANIFEST = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
ASSETS = ROOT / "assets"
FONT = ImageFont.load_default(size=22)
FONT_SMALL = ImageFont.load_default(size=17)
FONT_BIG = ImageFont.load_default(size=34)


def money(value, currency, eu=False):
    if value is None:
        return "[OBSCURED]"
    if currency == "JPY":
        out = f"{value:,.0f}"
    else:
        out = f"{value:,.2f}"
    if eu:
        out = out.replace(",", "_").replace(".", ",").replace("_", ".")
    return f"{out} {currency}"


def labels(variant):
    if variant == "german_labels_png":
        return {"number": "Rechnungsnummer", "date": "Rechnungsdatum", "tax": "USt-IdNr.", "subtotal": "Nettobetrag", "vat": "Umsatzsteuer", "total": "Gesamtbetrag"}
    return {"number": "Invoice number", "date": "Invoice date", "tax": "Tax ID", "subtotal": "Subtotal", "vat": "Tax", "total": "Total due"}


def draw_invoice(case, low_contrast=False):
    gt = case["groundTruth"]
    variant = case["variant"]
    fg = (112, 118, 126) if low_contrast else (24, 31, 43)
    muted = (150, 155, 162) if low_contrast else (77, 88, 102)
    img = Image.new("RGB", (1400, 1000), (247, 248, 250))
    d = ImageDraw.Draw(img)
    accent = (86, 112, 184)
    d.rounded_rectangle((70, 60, 1330, 940), radius=18, fill=(255, 255, 255), outline=(208, 214, 224), width=3)
    d.rectangle((70, 60, 1330, 160), fill=(238, 242, 250))
    d.polygon([(105, 90), (140, 72), (175, 90), (140, 108)], fill=accent)
    d.text((205, 88), gt["vendor"], font=FONT_BIG, fill=fg)
    d.text((1090, 88), "INVOICE", font=FONT_BIG, fill=accent)
    lab = labels(variant)
    rows = [
        (lab["number"], gt["invoice_number"] or "████████"),
        (lab["date"], gt["invoice_date"]),
        (lab["tax"], gt["tax_id"] or "NOT PROVIDED"),
        ("Currency", gt["currency"]),
    ]
    y = 205
    for key, value in rows:
        d.text((110, y), key, font=FONT_SMALL, fill=muted)
        d.text((390, y), str(value), font=FONT, fill=fg)
        y += 54
    d.line((110, 445, 1290, 445), fill=(205, 211, 220), width=2)
    d.text((120, 475), "Description", font=FONT_SMALL, fill=muted)
    d.text((1060, 475), "Amount", font=FONT_SMALL, fill=muted)
    descriptions = ["Professional services", "Operations subscription", "Parts and delivery"]
    amounts = [round(gt["subtotal"] * 0.45, 2), round(gt["subtotal"] * 0.35, 2), round(gt["subtotal"] * 0.20, 2)]
    for i, (desc, amount) in enumerate(zip(descriptions, amounts)):
        yy = 525 + i * 52
        d.text((120, yy), desc, font=FONT, fill=fg)
        d.text((1060, yy), money(amount, gt["currency"], variant == "eu_decimal_png"), font=FONT, fill=fg)
    d.line((790, 700, 1290, 700), fill=(205, 211, 220), width=2)
    total_rows = [(lab["subtotal"], gt["subtotal"]), (lab["vat"], gt["tax"]), (lab["total"], gt["total"])]
    for i, (key, value) in enumerate(total_rows):
        yy = 730 + i * 55
        d.text((800, yy), key, font=FONT_SMALL if i < 2 else FONT, fill=muted if i < 2 else fg)
        shown = value
        if variant == "inconsistent_total_pdf" and key == lab["total"]:
            shown = 1180.00
        d.text((1060, yy), money(shown, gt["currency"], variant == "eu_decimal_png"), font=FONT if i < 2 else FONT_BIG, fill=fg)
    d.text((110, 900), "Synthetic benchmark fixture · not a financial document", font=FONT_SMALL, fill=muted)
    return img


def save_image(case, path):
    variant = case["variant"]
    img = draw_invoice(case, low_contrast=variant == "low_contrast_jpeg")
    if variant == "rotated_scan_png":
        img = img.rotate(2.2, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(235, 235, 235))
    if variant == "noisy_scan_jpeg":
        rng = random.Random(808)
        px = img.load()
        for _ in range(52000):
            x, y = rng.randrange(img.width), rng.randrange(img.height)
            r, g, b = px[x, y]
            delta = rng.randrange(-24, 25)
            px[x, y] = tuple(max(0, min(255, c + delta)) for c in (r, g, b))
        img = img.filter(ImageFilter.GaussianBlur(0.35))
    if variant == "low_contrast_jpeg":
        img = ImageEnhance.Contrast(img).enhance(0.72)
    quality = 86 if path.suffix.lower() in {".jpg", ".jpeg"} else None
    img.save(path, quality=quality)


def save_pdf(case, path):
    gt = case["groundTruth"]
    c = canvas.Canvas(str(path), pagesize=A4, invariant=1, pageCompression=1)
    width, height = A4
    c.setStrokeColorRGB(0.75, 0.78, 0.83)
    c.roundRect(40, 55, width - 80, height - 110, 12, stroke=1, fill=0)
    c.setFillColorRGB(0.16, 0.26, 0.48)
    c.setFont("Helvetica-Bold", 23)
    c.drawString(65, height - 105, gt["vendor"])
    c.drawRightString(width - 65, height - 105, "INVOICE")
    c.setFillColorRGB(0.12, 0.15, 0.2)
    c.setFont("Helvetica", 11)
    fields = [("Invoice number", gt["invoice_number"] or "NOT PROVIDED"), ("Invoice date", gt["invoice_date"]), ("Tax ID", gt["tax_id"] or "NOT PROVIDED"), ("Currency", gt["currency"])]
    y = height - 160
    for key, value in fields:
        c.setFillColorRGB(0.38, 0.42, 0.48)
        c.drawString(70, y, key)
        c.setFillColorRGB(0.12, 0.15, 0.2)
        c.drawString(210, y, str(value))
        y -= 28
    c.line(70, y - 5, width - 70, y - 5)
    y -= 45
    c.setFont("Helvetica-Bold", 11)
    c.drawString(75, y, "Description")
    c.drawRightString(width - 75, y, "Amount")
    c.setFont("Helvetica", 11)
    items = [("Professional services", 0.45), ("Operations subscription", 0.35), ("Parts and delivery", 0.20)]
    for desc, share in items:
        y -= 30
        c.drawString(75, y, desc)
        c.drawRightString(width - 75, y, money(round(gt["subtotal"] * share, 2), gt["currency"]))
    y -= 55
    shown_total = gt["total"]
    if case["variant"] == "inconsistent_total_pdf":
        shown_total = 1180.00
    for key, value in [("Subtotal", gt["subtotal"]), ("Tax", gt["tax"]), ("TOTAL DUE", shown_total)]:
        c.setFont("Helvetica-Bold" if key == "TOTAL DUE" else "Helvetica", 13 if key == "TOTAL DUE" else 11)
        c.drawString(335, y, key)
        c.drawRightString(width - 75, y, money(value, gt["currency"]))
        y -= 28
    c.setFont("Helvetica", 8)
    c.setFillColorRGB(0.45, 0.48, 0.52)
    c.drawString(70, 75, "Synthetic benchmark fixture · not a financial document")
    if case["variant"] == "two_page_pdf":
        c.showPage()
        c.setFont("Helvetica-Bold", 16)
        c.drawString(70, height - 90, "Service detail — page 2 of 2")
        c.setFont("Helvetica", 11)
        c.drawString(70, height - 125, "Reference NCO-2026-05 · support, monitoring, and incident response.")
    c.save()


def main():
    ASSETS.mkdir(parents=True, exist_ok=True)
    expected = set()
    for case in MANIFEST["cases"]:
        path = ROOT / case["filename"]
        expected.add(path.resolve())
        path.parent.mkdir(parents=True, exist_ok=True)
        if path.suffix.lower() == ".pdf":
            save_pdf(case, path)
        else:
            save_image(case, path)
    for path in ASSETS.iterdir():
        if path.is_file() and path.resolve() not in expected:
            path.unlink()
    print(f"Generated {len(expected)} original fixtures under {ASSETS.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
