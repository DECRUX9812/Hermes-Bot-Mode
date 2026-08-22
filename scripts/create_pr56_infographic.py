#!/usr/bin/env python3
"""
Generate a warm-paper retro command-center infographic poster for PR #56.
Aesthetic: Warm cream paper, navy ink, rust orange accents, clean typography, 4:3 canvas (1600x1200).
"""

import os
from PIL import Image, ImageDraw, ImageFont

def create_poster(output_path):
    W, H = 1600, 1200
    im = Image.new("RGB", (W, H), "#F9F6EE") # Warm cream background
    draw = ImageDraw.Draw(im)

    # Palette
    INK_MAIN = "#0C1829"      # Deep navy ink
    INK_MUTED = "#4A5568"     # Secondary slate
    RUST = "#D95D39"          # Warm rust orange accent
    GOLD = "#E5A93C"          # Amber/Gold accent
    EMERALD = "#2E8B57"       # Green
    CARD_BG = "#FFFFFF"       # Crisp card bg
    CARD_BORDER = "#E2D9C8"   # Subtle warm stroke
    CARD_BORDER_DARK = "#CBD5E1"

    # Load fonts
    def get_font(size, bold=False):
        variants = [
            "/usr/share/fonts/google-lato/Lato-Heavy.ttf" if bold else "/usr/share/fonts/google-lato/Lato-Regular.ttf",
            "/usr/share/fonts/google-lato/Lato-Bold.ttf" if bold else "/usr/share/fonts/google-lato/Lato-Regular.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans-Bold.ttf" if bold else "/usr/share/fonts/dejavu-sans-fonts/DejaVuSans.ttf",
        ]
        for v in variants:
            if os.path.exists(v):
                try:
                    return ImageFont.truetype(v, size)
                except Exception:
                    pass
        return ImageFont.load_default()

    font_title = get_font(52, bold=True)
    font_subtitle = get_font(24, bold=False)
    font_section = get_font(22, bold=True)
    font_heading = get_font(20, bold=True)
    font_body = get_font(16, bold=False)
    font_badge = get_font(14, bold=True)
    font_footer = get_font(18, bold=True)

    # 1. Outer framing
    draw.rectangle([30, 30, W - 30, H - 30], outline=INK_MAIN, width=4)
    draw.rectangle([38, 38, W - 38, H - 38], outline=CARD_BORDER, width=2)

    # 2. Header Area
    # Tag Pill
    tag_text = "HERMES BOT MODE · PR #56"
    draw.rectangle([60, 60, 320, 92], fill=RUST, outline=RUST)
    draw.text((75, 68), tag_text, fill="#FFFFFF", font=font_badge)

    # Title & Subtitle
    draw.text((60, 110), "SQUAD COMMAND CENTER & WORKSTREAM BOARD", fill=INK_MAIN, font=font_title)
    draw.text((60, 175), "From endless chat sprawl to a unified attention-first desktop control surface.", fill=INK_MUTED, font=font_subtitle)

    # Divider
    draw.line([60, 220, W - 60, 220], fill=CARD_BORDER, width=2)

    # 3. Four Major Value Pillars (Grid of 4 Feature Cards)
    cards = [
        {
            "num": "01",
            "tag": "CONTROL SURFACE",
            "title": "Unified Bots & Tasks Pane",
            "bullets": [
                "• [Bots | Tasks] segmented switcher in left pane",
                "• 1-click expand to full-screen responsive 4-col board",
                "• Compact 2-session history: no more vertical explosion",
                "• Instant Deliverable Drawer with 1-click Review & Done"
            ],
            "accent": RUST
        },
        {
            "num": "02",
            "tag": "DETERMINISTIC STATUS",
            "title": "Honest Attention Hierarchy",
            "bullets": [
                "• Working: Live turn execution with action verb",
                "• Needs you: Gated strictly on human actions/reviews",
                "• Waiting: Blocked on peer bot reply (open loops)",
                "• Paused & Bot Working Hours: Safe queueing, no deadlocks"
            ],
            "accent": GOLD
        },
        {
            "num": "03",
            "tag": "HIGH-VELOCITY INTERACTION",
            "title": "Universal ⌘K & Tool Pills",
            "bullets": [
                "• ⌘K Fast Dispatch: Type '@trader ...' from anywhere",
                "• Collapsible Tool Execution Pills with timers (0.2s)",
                "• Live Squad Pipeline Matrix showing flow traffic",
                "• Silent background chatter: unread badges, zero toast spam"
            ],
            "accent": EMERALD
        },
        {
            "num": "04",
            "tag": "SECURITY & HARDENING",
            "title": "Zero-Injection Fleet Dispatch",
            "bullets": [
                "• POSIX single-quoted payloads (blocks $(whoami) & `cmd`)",
                "• Path traversal hardened approval queue (0o700/0o600)",
                "• Primary bot 'hermes' / 'default' handle normalization",
                "• Portable POSIX shims for macOS, BSD, and Linux"
            ],
            "accent": INK_MAIN
        }
    ]

    card_coords = [
        (60, 250, 780, 640),
        (820, 250, 1540, 640),
        (60, 670, 780, 1060),
        (820, 670, 1540, 1060),
    ]

    for (x1, y1, x2, y2), c in zip(card_coords, cards):
        # Card container
        draw.rectangle([x1, y1, x2, y2], fill=CARD_BG, outline=CARD_BORDER, width=2)
        # Top Accent Strip
        draw.rectangle([x1, y1, x2, y1 + 8], fill=c["accent"])
        
        # Number Circle / Box
        draw.rectangle([x1 + 24, y1 + 24, x1 + 74, y1 + 64], fill=INK_MAIN)
        draw.text((x1 + 34, y1 + 30), c["num"], fill="#FFFFFF", font=font_section)

        # Category Tag
        draw.text((x1 + 90, y1 + 35), c["tag"], fill=c["accent"], font=font_badge)

        # Title
        draw.text((x1 + 24, y1 + 80), c["title"], fill=INK_MAIN, font=font_heading)

        # Bullets
        by = y1 + 130
        for b in c["bullets"]:
            draw.text((x1 + 24, by), b, fill=INK_MUTED, font=font_body)
            by += 44

    # 4. Footer Strip
    draw.line([60, 1090, W - 60, 1090], fill=CARD_BORDER, width=2)
    draw.text((60, 1120), "⚡ 140/140 TESTS PASSING · ZERO EXTERNAL RUNTIME DEPS · 60FPS NATIVE REACT", fill=INK_MAIN, font=font_footer)
    draw.text((1200, 1120), "NOUS RESEARCH · HERMES BOT MODE", fill=INK_MUTED, font=font_badge)

    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    im.save(output_path, "PNG")
    print(f"✅ Infographic generated successfully at {output_path}")

if __name__ == "__main__":
    out = "/home/decrux/.hermes/desktop-plugins/hermes-bots/docs/pr-assets/pr-56-squad-command-center.png"
    create_poster(out)
