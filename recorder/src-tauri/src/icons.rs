//! Tray icons, drawn here so they stay crisp: the Debrief logo (seven bars,
//! dark blue to light), and a red disc with the same bars in white while
//! recording. An amber dot in the corner when uploads can't go through.
//! On the Mac the logo is a template instead, flat like the system's own
//! icons: macOS paints it white or black to suit the menu bar, dot and all.

use tauri::image::Image;

const SIZE: u32 = 44;
/// The logo's bars in its 64-unit viewBox: x, y, height and colour. Each is 5.6 wide.
const BARS: [(f32, f32, f32, [u8; 3]); 7] = [
    (4.0, 22.0, 20.0, [0x17, 0x55, 0x9b]),
    (12.4, 15.0, 34.0, [0x31, 0x66, 0xa8]),
    (20.8, 6.0, 52.0, [0x47, 0x78, 0xb6]),
    (29.2, 13.0, 38.0, [0x5d, 0x8a, 0xc3]),
    (37.6, 9.0, 46.0, [0x73, 0x9c, 0xd0]),
    (46.0, 18.0, 28.0, [0x89, 0xae, 0xde]),
    (54.4, 25.0, 14.0, [0xa0, 0xc0, 0xeb]),
];

fn coverage_round_rect(x: f32, y: f32, cx: f32, cy: f32, hw: f32, hh: f32) -> f32 {
    // Distance to a capsule (a rect with fully rounded ends), antialiased over a pixel.
    let r = hw;
    let dy = ((y - cy).abs() - (hh - r)).max(0.0);
    let dx = (x - cx).abs();
    let d = (dx * dx + dy * dy).sqrt() - r;
    (0.5 - d).clamp(0.0, 1.0)
}

/// Where the warning dot sits, and its radius, in pixels.
const WARN: (f32, f32, f32) = (SIZE as f32 - 8.0, SIZE as f32 - 8.0, 7.5);

/// The icon, and whether it's a template for macOS to colour.
pub fn tray(recording: bool, warn: bool) -> (Image<'static>, bool) {
    let template = cfg!(target_os = "macos") && !recording;
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    let c = SIZE as f32 / 2.0;
    // Logo units to pixels: the full icon, or smaller to sit inside the disc.
    let s = SIZE as f32 / 64.0 * if recording { 0.6 } else { 1.0 };
    let off = c - 32.0 * s;
    for yi in 0..SIZE {
        for xi in 0..SIZE {
            let (x, y) = (xi as f32 + 0.5, yi as f32 + 0.5);
            // Bars don't overlap, so each pixel takes the colour of the one it's in.
            let (mut bar, mut rgb) = (0f32, [0u8; 3]);
            for (bx, by, bh, col) in BARS {
                let cov = coverage_round_rect(x, y, (bx + 2.8) * s + off, (by + bh / 2.0) * s + off, 2.8 * s, bh / 2.0 * s);
                if cov > bar {
                    (bar, rgb) = (cov, col);
                }
            }
            let o = ((yi * SIZE + xi) * 4) as usize;
            if recording {
                let d = ((x - c).powi(2) + (y - c).powi(2)).sqrt();
                let disc = (c - 1.0 - d + 0.5).clamp(0.0, 1.0);
                // Red disc, white bars on it.
                let (r, g, b) = (0xe5 as f32, 0x3e as f32, 0x3e as f32);
                px[o] = (r + (255.0 - r) * bar) as u8;
                px[o + 1] = (g + (255.0 - g) * bar) as u8;
                px[o + 2] = (b + (255.0 - b) * bar) as u8;
                px[o + 3] = (disc * 255.0) as u8;
            } else {
                px[o..o + 3].copy_from_slice(if template { &[0; 3] } else { &rgb });
                px[o + 3] = (bar * 255.0) as u8;
            }
            if warn {
                // Clear a gap round the dot, then draw it over whatever is there.
                let d = ((x - WARN.0).powi(2) + (y - WARN.1).powi(2)).sqrt();
                let gap = (WARN.2 + 2.5 - d + 0.5).clamp(0.0, 1.0);
                let dot = (WARN.2 - d + 0.5).clamp(0.0, 1.0);
                let a = px[o + 3] as f32 / 255.0 * (1.0 - gap);
                let out = a * (1.0 - dot) + dot;
                let dot_rgb = if template { [0; 3] } else { [0xf5u8, 0xa5, 0x24] };
                for (i, amber) in dot_rgb.into_iter().enumerate() {
                    px[o + i] = if out > 0.0 { ((px[o + i] as f32 * a * (1.0 - dot) + amber as f32 * dot) / out) as u8 } else { 0 };
                }
                px[o + 3] = (out * 255.0) as u8;
            }
        }
    }
    (Image::new_owned(px, SIZE, SIZE), template)
}
