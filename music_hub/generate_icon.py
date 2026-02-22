"""
Generate Music Hub app icon — a premium gradient music note icon.
"""
from PIL import Image, ImageDraw, ImageFont
import math
import os

SIZE = 1024
CENTER = SIZE // 2

def create_icon():
    img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # ── Background: rounded square with gradient ──
    # Create gradient background
    for y in range(SIZE):
        ratio = y / SIZE
        # Purple to pink gradient (matching app theme)
        r = int(88 + (232 - 88) * ratio)
        g = int(86 + (93 - 86) * ratio)
        b = int(214 + (228 - 214) * ratio)
        draw.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

    # Round the corners
    mask = Image.new('L', (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    radius = SIZE // 4  # Corner radius
    mask_draw.rounded_rectangle([0, 0, SIZE, SIZE], radius=radius, fill=255)
    img.putalpha(mask)

    # ── Subtle radial glow in center ──
    glow = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    for i in range(200, 0, -1):
        r_size = int(SIZE * 0.35 * (i / 200))
        alpha = int(40 * (1 - i / 200))
        glow_draw.ellipse(
            [CENTER - r_size, CENTER - r_size, CENTER + r_size, CENTER + r_size],
            fill=(255, 255, 255, alpha)
        )
    img = Image.alpha_composite(img, glow)
    draw = ImageDraw.Draw(img)

    # ── Draw Music Note ──
    note_color = (255, 255, 255, 240)
    shadow_color = (0, 0, 0, 50)

    # Note head 1 (bottom-left) — ellipse
    head1_cx = CENTER - 100
    head1_cy = CENTER + 200
    head1_rx = 85
    head1_ry = 60

    # Note head 2 (bottom-right) — ellipse
    head2_cx = CENTER + 150
    head2_cy = CENTER + 140
    head2_rx = 85
    head2_ry = 60

    # Draw shadow first
    offset = 6
    draw.ellipse(
        [head1_cx - head1_rx + offset, head1_cy - head1_ry + offset,
         head1_cx + head1_rx + offset, head1_cy + head1_ry + offset],
        fill=shadow_color
    )
    draw.ellipse(
        [head2_cx - head2_rx + offset, head2_cy - head2_ry + offset,
         head2_cx + head2_rx + offset, head2_cy + head2_ry + offset],
        fill=shadow_color
    )

    # Stems (shadow)
    stem_width = 28
    draw.rectangle(
        [head1_cx + head1_rx - stem_width + offset, CENTER - 250 + offset,
         head1_cx + head1_rx + offset, head1_cy + offset],
        fill=shadow_color
    )
    draw.rectangle(
        [head2_cx + head2_rx - stem_width + offset, CENTER - 310 + offset,
         head2_cx + head2_rx + offset, head2_cy + offset],
        fill=shadow_color
    )

    # Note heads (white)
    draw.ellipse(
        [head1_cx - head1_rx, head1_cy - head1_ry,
         head1_cx + head1_rx, head1_cy + head1_ry],
        fill=note_color
    )
    draw.ellipse(
        [head2_cx - head2_rx, head2_cy - head2_ry,
         head2_cx + head2_rx, head2_cy + head2_ry],
        fill=note_color
    )

    # Stems (white)
    stem1_x = head1_cx + head1_rx - stem_width
    stem2_x = head2_cx + head2_rx - stem_width
    stem1_top = CENTER - 250
    stem2_top = CENTER - 310

    draw.rectangle(
        [stem1_x, stem1_top, stem1_x + stem_width, head1_cy],
        fill=note_color
    )
    draw.rectangle(
        [stem2_x, stem2_top, stem2_x + stem_width, head2_cy],
        fill=note_color
    )

    # Beam connecting the two stems (thick angled bar)
    beam_thickness = 40
    # Top beam
    beam_points = [
        (stem1_x, stem1_top),
        (stem2_x + stem_width, stem2_top),
        (stem2_x + stem_width, stem2_top + beam_thickness),
        (stem1_x, stem1_top + beam_thickness),
    ]
    draw.polygon(beam_points, fill=note_color)

    # Second beam (slightly lower)
    beam2_offset = 60
    beam2_points = [
        (stem1_x, stem1_top + beam2_offset),
        (stem2_x + stem_width, stem2_top + beam2_offset),
        (stem2_x + stem_width, stem2_top + beam2_offset + beam_thickness),
        (stem1_x, stem1_top + beam2_offset + beam_thickness),
    ]
    draw.polygon(beam2_points, fill=note_color)

    # ── Small sound wave arcs (decorative) ──
    wave_color = (255, 255, 255, 80)
    for i in range(3):
        arc_r = 320 + i * 50
        arc_width = 4
        start_angle = -40
        end_angle = 40
        draw.arc(
            [CENTER + 100 - arc_r, CENTER - 100 - arc_r,
             CENTER + 100 + arc_r, CENTER - 100 + arc_r],
            start=start_angle, end=end_angle,
            fill=wave_color, width=arc_width
        )

    # ── Save outputs ──
    output_dir = os.path.join('d:', os.sep, 'jio', 'music_hub', 'assets')
    os.makedirs(output_dir, exist_ok=True)

    # Save full 1024x1024
    icon_path = os.path.join(output_dir, 'icon.png')
    img.save(icon_path, 'PNG')
    print(f"✅ Saved 1024x1024 icon: {icon_path}")

    # Also save adaptive icon foreground (with extra padding)
    adaptive = Image.new('RGBA', (1024, 1024), (0, 0, 0, 0))
    # Scale icon to 70% and center it (adaptive icons need safe zone padding)
    scaled = img.resize((int(1024 * 0.7), int(1024 * 0.7)), Image.LANCZOS)
    offset_xy = (1024 - scaled.width) // 2
    adaptive.paste(scaled, (offset_xy, offset_xy), scaled)
    adaptive_path = os.path.join(output_dir, 'icon_foreground.png')
    adaptive.save(adaptive_path, 'PNG')
    print(f"✅ Saved adaptive foreground: {adaptive_path}")

    # Save notification icon (white on transparent)
    notif = img.resize((96, 96), Image.LANCZOS)
    notif_path = os.path.join(output_dir, 'icon_notification.png')
    notif.save(notif_path, 'PNG')
    print(f"✅ Saved notification icon: {notif_path}")

    print("\n🎵 All icons generated successfully!")

if __name__ == '__main__':
    create_icon()
