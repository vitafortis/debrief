//! Tray icons, drawn here so they stay crisp: waveform bars (a macOS
//! template, so it follows the menu bar's colour), and a red disc with the
//! same bars while recording.

use tauri::image::Image;

const SIZE: u32 = 44;
const BARS: [f32; 5] = [0.36, 0.7, 1.0, 0.62, 0.3];

fn coverage_round_rect(x: f32, y: f32, cx: f32, cy: f32, hw: f32, hh: f32) -> f32 {
    // Distance to a capsule (a rect with fully rounded ends), antialiased over a pixel.
    let r = hw;
    let dy = ((y - cy).abs() - (hh - r)).max(0.0);
    let dx = (x - cx).abs();
    let d = (dx * dx + dy * dy).sqrt() - r;
    (0.5 - d).clamp(0.0, 1.0)
}

pub fn tray(recording: bool) -> Image<'static> {
    let mut px = vec![0u8; (SIZE * SIZE * 4) as usize];
    let c = SIZE as f32 / 2.0;
    for yi in 0..SIZE {
        for xi in 0..SIZE {
            let (x, y) = (xi as f32 + 0.5, yi as f32 + 0.5);
            let mut bar = 0f32;
            let (span, bar_w, max_h) = if recording { (5.4, 3.2, 20.0) } else { (7.0, 4.2, 30.0) };
            for (i, h) in BARS.iter().enumerate() {
                let cx = c + (i as f32 - 2.0) * span;
                bar = bar.max(coverage_round_rect(x, y, cx, c, bar_w / 2.0, (max_h * h).max(bar_w) / 2.0));
            }
            let o = ((yi * SIZE + xi) * 4) as usize;
            if recording {
                let d = ((x - c).powi(2) + (y - c).powi(2)).sqrt();
                let disc = (c - 1.0 - d + 0.5).clamp(0.0, 1.0);
                // Red disc, white bars on it.
                let (r, g, b) = (0xe5 as f32, 0x3e as f32, 0x3e as f32);
                let a = disc;
                px[o] = (r + (255.0 - r) * bar) as u8;
                px[o + 1] = (g + (255.0 - g) * bar) as u8;
                px[o + 2] = (b + (255.0 - b) * bar) as u8;
                px[o + 3] = (a * 255.0) as u8;
            } else {
                px[o + 3] = (bar * 255.0) as u8;
            }
        }
    }
    Image::new_owned(px, SIZE, SIZE)
}
