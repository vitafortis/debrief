//! The meeting app's biggest window, drawn into a bitmap by PrintWindow
//! (which works while it's behind other windows, but not minimized).

use super::{is_call_title, Frame};
use crate::audio::system_win::{app_pids, processes};
use anyhow::{anyhow, Result};
use windows::core::BOOL;
use windows::Win32::Foundation::{HWND, LPARAM, RECT};
use windows::Win32::Graphics::Gdi::{
    CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS,
};
use windows::Win32::Storage::Xps::{PrintWindow, PRINT_WINDOW_FLAGS};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible};

// PrintWindow draws what the compositor shows, browsers and Electron apps included.
const PW_RENDERFULLCONTENT: PRINT_WINDOW_FLAGS = PRINT_WINDOW_FLAGS(2);

unsafe extern "system" fn collect(hwnd: HWND, out: LPARAM) -> BOOL {
    let v = &mut *(out.0 as *mut Vec<HWND>);
    v.push(hwnd);
    BOOL(1)
}

fn title(hwnd: HWND) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(hwnd, &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn grab(app_id: &str, browser: bool) -> Result<Option<Frame>> {
    let procs = processes();
    let pids = app_pids(app_id, &procs);
    if pids.is_empty() {
        return Ok(None);
    }
    let mut all: Vec<HWND> = Vec::new();
    unsafe {
        EnumWindows(Some(collect), LPARAM(&mut all as *mut Vec<HWND> as isize))?;
    }
    let mut best: Option<(i32, HWND, RECT)> = None;
    for hwnd in all {
        unsafe {
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if !pids.contains(&pid) || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
                continue;
            }
            let mut r = RECT::default();
            if GetWindowRect(hwnd, &mut r).is_err() {
                continue;
            }
            let (w, h) = (r.right - r.left, r.bottom - r.top);
            if w < 400 || h < 300 {
                continue;
            }
            let t = title(hwnd);
            if t.is_empty() || (browser && !is_call_title(&t)) {
                continue;
            }
            if best.is_none_or(|(a, _, _)| w * h > a) {
                best = Some((w * h, hwnd, r));
            }
        }
    }
    let Some((_, hwnd, r)) = best else { return Ok(None) };
    let (w, h) = (r.right - r.left, r.bottom - r.top);
    unsafe {
        let screen = GetDC(None);
        let dc = CreateCompatibleDC(Some(screen));
        let bmp = CreateCompatibleBitmap(screen, w, h);
        let old = SelectObject(dc, bmp.into());
        let ok = PrintWindow(hwnd, dc, PW_RENDERFULLCONTENT).as_bool();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; (w * h * 4) as usize];
        let rows = if ok { GetDIBits(dc, bmp, 0, h as u32, Some(bgra.as_mut_ptr().cast()), &mut info, DIB_RGB_COLORS) } else { 0 };
        SelectObject(dc, old);
        let _ = DeleteObject(bmp.into());
        let _ = DeleteDC(dc);
        ReleaseDC(None, screen);
        if rows == 0 {
            return Err(anyhow!("Windows couldn't draw the window"));
        }
        Ok(Some(Frame { width: w as usize, height: h as usize, stride: w as usize * 4, bgra }))
    }
}
