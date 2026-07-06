#!/usr/bin/env python3
"""Render the Archon Autopilot demo as a per-scene 1920x1080 slideshow (silent).

Design goals (Track-4 demo video):
  * PER-SCENE assembly with NO black lead-in — the very first frame (t=0) is the
    title scene, never a black gap.
  * Captions are burned INTO each PIL frame with an auto-fit routine (wrap + shrink
    to fit the canvas width and a max line count), so a caption can never overflow
    the screen — no fragile ffmpeg drawtext escaping.
  * The multi-step-loop scene is driven by the REAL captured live trace JSON
    (demo/video/assets/live_intake_journal.json + live_intake_duplicate.json),
    captured from the deployed Alibaba Cloud box over HTTPS — proof, not a mock.
  * The human-gate scene embeds real Playwright screenshots of the live approval UI.

Technique: render ONE PNG per beat, then assemble with the ffmpeg concat demuxer
using per-beat durations, re-encoded to CONSTANT framerate (-fps_mode cfr -r 30).

Env (all optional):
  TARGET_SECONDS  total video length (normally the real voiceover length + a small
                  tail). Every beat is scaled by target/timeline so the visuals track
                  the narration exactly. Default = the built-in timeline length.
  OUTPUT          output mp4 path (default scenes.mp4)
  ASSETS_DIR      dir with the trace JSONs + UI PNGs (default demo/video/assets)
  FPS             output framerate (default 30)
  FONT_SANS / FONT_SANS_BOLD / FONT_MONO  font overrides
  FFMPEG / FFPROBE  binaries

Usage:
  python scripts/make_frames.py
  TARGET_SECONDS=135 python scripts/make_frames.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

# --------------------------------------------------------------------------- #
# Canvas / palette (GitHub-dark, matching the live approval UI)
# --------------------------------------------------------------------------- #
W, H = 1920, 1080
BG = (13, 17, 23)          # #0d1117
PANEL = (22, 27, 34)       # #161b22
PANEL2 = (28, 35, 48)      # #1c2330
BORDER = (43, 51, 63)      # #2b333f
TEXT = (230, 237, 243)     # #e6edf3
MUTED = (139, 148, 158)    # #8b949e
ACCENT = (88, 166, 255)    # #58a6ff
GREEN = (63, 185, 80)      # #3fb950
AMBER = (210, 153, 34)     # #d29922
RED = (248, 81, 73)        # #f85149
EMERALD = (52, 211, 153)   # #34d399

MARGIN = 120
CAP_MAXW = W - 2 * MARGIN


def _find_font(env_key, candidates):
    p = os.environ.get(env_key)
    if p and os.path.exists(p):
        return p
    for c in candidates:
        if os.path.exists(c):
            return c
    return None


SANS = _find_font("FONT_SANS", [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf",
])
SANS_BOLD = _find_font("FONT_SANS_BOLD", [
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    "C:/Windows/Fonts/segoeuib.ttf", "C:/Windows/Fonts/arialbd.ttf",
])
MONO = _find_font("FONT_MONO", [
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf",
])
if not (SANS and SANS_BOLD and MONO):
    raise SystemExit(f"Missing fonts: SANS={SANS} SANS_BOLD={SANS_BOLD} MONO={MONO}")

_font_cache = {}


def font(kind, size):
    key = (kind, size)
    if key not in _font_cache:
        path = {"sans": SANS, "bold": SANS_BOLD, "mono": MONO}[kind]
        _font_cache[key] = ImageFont.truetype(path, size)
    return _font_cache[key]


def tw(d, text, f):
    return d.textlength(text, font=f)


def wrap(d, text, f, max_w):
    """Greedy word-wrap to max_w pixels."""
    words = text.split(" ")
    lines, cur = [], ""
    for w in words:
        trial = (cur + " " + w).strip()
        if tw(d, trial, f) <= max_w or not cur:
            cur = trial
        else:
            lines.append(cur)
            cur = w
    if cur:
        lines.append(cur)
    return lines


def fit_lines(d, text, kind, max_w, max_lines, start_size, min_size):
    """Shrink font until the wrapped text fits within max_lines rows AND max_w."""
    size = start_size
    while size >= min_size:
        f = font(kind, size)
        lines = wrap(d, text, f, max_w)
        if len(lines) <= max_lines:
            return f, lines
        size -= 2
    f = font(kind, min_size)
    return f, wrap(d, text, f, max_w)


def rounded(d, box, radius, fill=None, outline=None, width=1):
    d.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


# --------------------------------------------------------------------------- #
# Caption bar (burned into every frame, auto-fit, guaranteed on-screen)
# --------------------------------------------------------------------------- #
def draw_caption(img, d, text):
    if not text:
        return
    f, lines = fit_lines(d, text, "bold", CAP_MAXW - 60, 2, 40, 26)
    lh = f.size + 12
    block_h = lh * len(lines) + 28
    y0 = H - block_h - 46
    max_line_w = max(tw(d, ln, f) for ln in lines)
    box_w = min(CAP_MAXW, max_line_w + 60)
    x0 = (W - box_w) // 2
    rounded(d, [x0, y0, x0 + box_w, y0 + block_h], 18, fill=(0, 0, 0))
    rounded(d, [x0, y0, x0 + box_w, y0 + block_h], 18, outline=BORDER, width=2)
    y = y0 + 14
    for ln in lines:
        d.text(((W - tw(d, ln, f)) / 2, y), ln, font=f, fill=TEXT)
        y += lh


def new_frame():
    img = Image.new("RGB", (W, H), BG)
    return img, ImageDraw.Draw(img)


def kicker(d, text, y=110):
    f = font("bold", 30)
    d.text((MARGIN, y), text.upper(), font=f, fill=ACCENT)


# --------------------------------------------------------------------------- #
# Scene renderers — each returns a PIL image
# --------------------------------------------------------------------------- #
def scene_title(cap):
    img, d = new_frame()
    d.text((MARGIN, 300), "Archon Autopilot", font=font("bold", 120), fill=EMERALD)
    d.text((MARGIN, 448), "A human-gated accounts-payable agent", font=font("sans", 46), fill=TEXT)
    d.text((MARGIN, 528), "Qwen  ·  qwen-plus function-calling  ·  live on Alibaba Cloud",
           font=font("mono", 34), fill=MUTED)
    draw_caption(img, d, cap)
    return img


def scene_bullets(kick, heading, bullets, cap):
    img, d = new_frame()
    kicker(d, kick)
    d.text((MARGIN, 170), heading, font=font("bold", 62), fill=TEXT)
    y = 320
    fb = font("sans", 42)
    for b in bullets:
        d.ellipse([MARGIN, y + 16, MARGIN + 16, y + 32], fill=ACCENT)
        for ln in wrap(d, b, fb, W - MARGIN - 200):
            d.text((MARGIN + 44, y), ln, font=fb, fill=TEXT)
            y += 56
        y += 26
    draw_caption(img, d, cap)
    return img


def scene_panel(kick, heading, rows, cap):
    img, d = new_frame()
    kicker(d, kick)
    d.text((MARGIN, 170), heading, font=font("bold", 60), fill=TEXT)
    x0, y0, x1 = MARGIN, 310, W - MARGIN
    rounded(d, [x0, y0, x1, y0 + 560], 20, fill=PANEL, outline=BORDER, width=2)
    y = y0 + 46
    fl = font("mono", 30)
    fv = font("sans", 38)
    for label, value in rows:
        d.text((x0 + 44, y + 4), label, font=fl, fill=MUTED)
        vx = x0 + 44 + 360
        for ln in wrap(d, value, fv, x1 - vx - 44):
            d.text((vx, y), ln, font=fv, fill=TEXT)
            y += 48
        y += 42
    draw_caption(img, d, cap)
    return img


def scene_curl(cap):
    img, d = new_frame()
    kicker(d, "The multi-step loop · live over HTTPS")
    x0, y0, x1, y1 = MARGIN, 200, W - MARGIN, 720
    rounded(d, [x0, y0, x1, y1], 18, fill=(9, 12, 16), outline=BORDER, width=2)
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([x0 + 30 + i * 34, y0 + 26, x0 + 30 + i * 34 + 16, y0 + 42], fill=c)
    d.text((x0 + 150, y0 + 22), "POST  /intake   →   autopilot.43.106.13.19.sslip.io",
           font=font("mono", 26), fill=MUTED)
    fm = font("mono", 28)
    lines = [
        ("$ curl -X POST https://autopilot.43.106.13.19.sslip.io/intake \\", GREEN),
        ('    -d \'{"invoice":{"supplier":"Larkfield Instruments",', TEXT),
        ('           "invoice_number":"LK-7021","tax_id":"TX-40881",', TEXT),
        ('           "subtotal":7300,"tax":1752,"total":9052}}\'', TEXT),
        ("", TEXT),
        ("→ real qwen-plus function-calling begins its step-by-step reasoning …", ACCENT),
    ]
    y = y0 + 96
    for txt, col in lines:
        d.text((x0 + 44, y), txt, font=fm, fill=col)
        y += 44
    draw_caption(img, d, cap)
    return img


def scene_loop(steps, n_visible, terminal, cap):
    """steps: list of (tool, observation). terminal: dict or None."""
    img, d = new_frame()
    kicker(d, "The multi-step loop · recall → validate → check → variance")
    d.text((MARGIN, 168), "autopilot.43.106.13.19.sslip.io  ·  live  ·  qwen-plus",
           font=font("mono", 26), fill=MUTED)
    y = 250
    ftool = font("mono", 34)
    fobs = font("sans", 32)
    for i in range(n_visible):
        tool, obs = steps[i]
        d.text((MARGIN, y + 4), f"{i+1}", font=font("mono", 30), fill=MUTED)
        tx = MARGIN + 70
        chip_w = tw(d, tool, ftool) + 28
        rounded(d, [tx, y - 4, tx + chip_w, y + 46], 8, outline=ACCENT, width=2)
        d.text((tx + 14, y + 2), tool, font=ftool, fill=ACCENT)
        oy = y + 58
        for ln in wrap(d, "→ " + obs, fobs, W - tx - MARGIN):
            d.text((tx, oy), ln, font=fobs, fill=MUTED)
            oy += 42
        y = oy + 24
    if terminal:
        by = y + 8
        term_col = RED if terminal["tool"] == "flag_for_review" else EMERALD
        rounded(d, [MARGIN, by, W - MARGIN, by + 150], 16, fill=PANEL2, outline=term_col, width=3)
        d.text((MARGIN + 32, by + 22), f"PROPOSED  →  {terminal['tool']}",
               font=font("bold", 44), fill=term_col)
        d.text((MARGIN + 32, by + 86),
               f"qwen-plus · confidence {int(terminal['confidence']*100)}% · HUMAN-GATED — nothing executes",
               font=font("mono", 28), fill=TEXT)
    draw_caption(img, d, cap)
    return img


def scene_image(png_path, kick, cap):
    img, d = new_frame()
    top = 96 if kick else 70
    if kick:
        kicker(d, kick, y=28)
    avail_h = H - top - 250
    avail_w = W - 2 * 60
    pic = Image.open(png_path).convert("RGB")
    scale = min(avail_w / pic.width, avail_h / pic.height)
    nw, nh = int(pic.width * scale), int(pic.height * scale)
    pic = pic.resize((nw, nh), Image.LANCZOS)
    px = (W - nw) // 2
    py = top + 8
    d.rectangle([px - 2, py - 2, px + nw + 2, py + nh + 2], outline=BORDER, width=2)
    img.paste(pic, (px, py))
    draw_caption(img, d, cap)
    return img


def scene_mcp(cap):
    img, d = new_frame()
    kicker(d, "Also an MCP server + a custom-skills catalog")
    d.text((MARGIN, 168), "Drivable by any MCP client", font=font("bold", 56), fill=TEXT)
    colw = (W - 2 * MARGIN - 60) // 2
    lx, rx = MARGIN, MARGIN + colw + 60
    top = 300
    rounded(d, [lx, top, lx + colw, top + 560], 18, fill=PANEL, outline=BORDER, width=2)
    rounded(d, [rx, top, rx + colw, top + 560], 18, fill=PANEL, outline=BORDER, width=2)
    d.text((lx + 34, top + 26), "MCP server · 7 tools", font=font("bold", 36), fill=ACCENT)
    for i, t in enumerate(["intake_invoice", "list_pending", "approve", "amend",
                           "reject", "recall_vendor", "list_skills"]):
        d.text((lx + 44, top + 96 + i * 58), "• " + t, font=font("mono", 30), fill=TEXT)
    d.text((rx + 34, top + 26), "Custom skills · 9 (5 autonomous · 4 gated)",
           font=font("bold", 32), fill=EMERALD)
    skills = ["recall_vendor_history", "validate_invoice", "check_duplicate",
              "compute_variance_vs_history", "request_more_context",
              "draft_journal_entry *", "draft_payment *",
              "draft_vendor_reply *", "flag_for_review *"]
    for i, s in enumerate(skills):
        d.text((rx + 44, top + 96 + i * 50), "• " + s, font=font("mono", 26),
               fill=(AMBER if s.endswith("*") else TEXT))
    d.text((rx + 44, top + 560 - 44), "* human-gated terminal skill", font=font("sans", 24), fill=MUTED)
    draw_caption(img, d, cap)
    return img


def scene_outro(cap):
    img, d = new_frame()
    d.text((MARGIN, 300), "Live on Alibaba Cloud · over HTTPS", font=font("bold", 66), fill=TEXT)
    d.text((MARGIN, 400), "Real Qwen models · human always in the loop", font=font("sans", 42), fill=MUTED)
    rounded(d, [MARGIN, 520, W - MARGIN, 720], 18, fill=PANEL, outline=BORDER, width=2)
    d.text((MARGIN + 40, 556), "https://autopilot.43.106.13.19.sslip.io", font=font("mono", 38), fill=EMERALD)
    d.text((MARGIN + 40, 626), "github.com/upgradedev/archon-qwen-autopilot  ·  MIT",
           font=font("mono", 32), fill=ACCENT)
    draw_caption(img, d, cap)
    return img


# --------------------------------------------------------------------------- #
# Timeline — (duration_seconds, image_factory). Scene 1 is at t=0: no black lead-in.
# --------------------------------------------------------------------------- #
def build_beats(assets):
    je = json.load(open(os.path.join(assets, "live_intake_journal.json"), encoding="utf-8"))
    dup = json.load(open(os.path.join(assets, "live_intake_duplicate.json"), encoding="utf-8"))
    je_steps = [(t["tool"], t["observation"]) for t in je["trace"]]
    je_term = {"tool": je["proposed"]["tool"], "confidence": je["proposed"]["confidence"]}
    dup_steps = [(t["tool"], t["observation"]) for t in dup["trace"]]
    dup_term = {"tool": dup["proposed"]["tool"], "confidence": dup["proposed"]["confidence"]}
    ov = os.path.join(assets, "ui_overview.png")
    card = os.path.join(assets, "ui_card.png")

    beats = []

    def add(dur, factory):
        beats.append((dur, factory))

    # ---- Scene 1 · Problem (~26s) ----
    add(6, lambda: scene_title(
        "Archon Autopilot — a human-gated accounts-payable agent on Qwen"))
    add(20, lambda: scene_bullets(
        "The problem", "Accounts payable is slow and error-prone",
        ["Every incoming invoice must be recorded, validated, and checked for duplicates and odd amounts",
         "Then someone has to decide what to do with it — under time pressure",
         "And one rule can never break: money must NEVER leave the account without a human"],
        "Record · validate · dedup · decide — and never auto-pay without a human"))

    # ---- Scene 2 · What it is (~26s) ----
    add(26, lambda: scene_panel(
        "What it is", "A human-gated AP agent, grounded in memory",
        [("model", "Qwen qwen-plus — real function-calling"),
         ("memory", "persistent vendor history in pgvector (the Track-1 MemoryAgent foundation)"),
         ("promise", "runs the workflow to a PROPOSED action — then stops for a human"),
         ("live", "deployed on Alibaba Cloud, served over HTTPS")],
        "A human-gated AP agent on qwen-plus, grounded in persistent vendor memory"))

    # ---- Scene 3 · The multi-step loop (the star, ~56s) ----
    add(8, lambda: scene_curl(
        "A real invoice, sent live over HTTPS to the deployed box"))
    step_caps = [
        "Step 1 · recall_vendor_history — grounded in pgvector memory",
        "Step 2 · validate_invoice — six cross-checks, R1–R6",
        "Step 3 · check_duplicate — has this invoice been seen before?",
        "Step 4 · compute_variance — how does the amount compare to history?",
    ]
    durs = [12, 10, 10, 8]
    for i in range(4):
        add(durs[i], lambda n=i + 1, c=step_caps[i]: scene_loop(je_steps, n, None, c))
    add(8, lambda: scene_loop(
        je_steps, 4, je_term,
        "Autonomous steps of real reasoning — then it STOPS at a human-gated proposal"))

    # ---- Scene 4 · The human gate + UI (~37s) ----
    add(12, lambda: scene_image(
        ov, "The approval queue · live UI",
        "The proposal is PENDING in the approval queue — nothing has executed"))
    add(13, lambda: scene_image(
        card, "How the agent decided",
        "A human sees the full step trace, then Approves, Amends, or Rejects"))
    add(12, lambda: scene_loop(
        dup_steps, len(dup_steps), dup_term,
        "Send it twice: the agent recalls the first, confirms the DUPLICATE, and flags it"))

    # ---- Scene 5 · MCP + custom skills (~18s) ----
    add(18, lambda: scene_mcp(
        "The same workflow, exposed as an MCP server (7 tools) + 9 custom skills"))

    # ---- Scene 6 · Close (~14s) ----
    add(14, lambda: scene_outro(
        "Live on Alibaba Cloud · real Qwen · open source (MIT) · human-in-the-loop"))

    return beats


def main():
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    assets = os.environ.get("ASSETS_DIR", os.path.join(here, "demo", "video", "assets"))
    output = os.environ.get("OUTPUT", os.path.join(os.getcwd(), "scenes.mp4"))
    fps = int(os.environ.get("FPS", "30"))
    ffmpeg = os.environ.get("FFMPEG", "ffmpeg")

    beats = build_beats(assets)
    timeline_end = sum(d for d, _ in beats)
    target = float(os.environ.get("TARGET_SECONDS", str(timeline_end)))
    factor = target / timeline_end
    print(f"[frames] beats={len(beats)} timeline_end={timeline_end}s "
          f"target={target}s factor={factor:.3f} fps={fps}")

    tmpdir = tempfile.mkdtemp(prefix="autopilot_frames_")
    concat_path = os.path.join(tmpdir, "concat.txt")
    pngs = []
    with open(concat_path, "w", encoding="utf-8") as cf:
        for idx, (dur, factory) in enumerate(beats):
            img = factory()
            png = os.path.join(tmpdir, f"f{idx:03d}.png")
            img.save(png)
            pngs.append(png)
            cf.write(f"file '{png}'\n")
            cf.write(f"duration {max(0.5, dur * factor):.3f}\n")
        cf.write(f"file '{pngs[-1]}'\n")

    cmd = [
        ffmpeg, "-y", "-f", "concat", "-safe", "0", "-i", concat_path,
        "-vf", "scale=1920:1080,setsar=1,format=yuv420p",
        "-fps_mode", "cfr", "-r", str(fps),
        # -t pins the total to exactly `target`, capping the concat-demuxer's
        # trailing-frame overshoot so the downstream VO mux lands frame-exact.
        "-t", f"{target:.3f}",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        output,
    ]
    print("[frames] " + " ".join(cmd))
    r = subprocess.run(cmd)
    if r.returncode != 0:
        return r.returncode
    try:
        dur = subprocess.check_output([
            os.environ.get("FFPROBE", "ffprobe"), "-v", "error",
            "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", output,
        ]).decode().strip()
        print(f"[frames] wrote {output} duration={dur}s (target {target}s)")
    except Exception as e:
        print(f"[frames] wrote {output} (ffprobe skipped: {e})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
