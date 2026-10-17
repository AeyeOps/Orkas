use qrcode::{Color, EcLevel, QrCode, Version};
use std::fmt::Write;

// Rounded locators and circular modules follow Chromium's bitmap generator.
// Keep a four-module quiet zone and bound the center mark to <25% of the width.
pub fn passkey_qr_svg(data: &[u8]) -> Result<String, qrcode::types::QrError> {
    let mut code = QrCode::with_error_correction_level(data, EcLevel::H)?;
    if code.width() < 37 { code = QrCode::with_version(data, Version::Normal(5), EcLevel::H)?; }
    let n = code.width();
    let size = n + 8;
    let mut svg = format!("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {size} {size}\" width=\"350\" height=\"350\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><g fill=\"black\">");
    for y in 0..n { for x in 0..n {
        let locator = (y < 8 && (x < 8 || x >= n-8)) || (y >= n-8 && x < 8);
        if !locator && code[(x,y)] == Color::Dark {
            write!(svg, "<circle cx=\"{}\" cy=\"{}\" r=\"0.42\"/>", x as f32+4.5,y as f32+4.5).unwrap();
        }
    }}
    for (x,y) in [(4,4),(n-3,4),(4,n-3)] {
        write!(svg,"<rect x=\"{x}\" y=\"{y}\" width=\"7\" height=\"7\" rx=\"1\"/><rect x=\"{}\" y=\"{}\" width=\"5\" height=\"5\" rx=\"1\" fill=\"white\"/><rect x=\"{}\" y=\"{}\" width=\"3\" height=\"3\" rx=\"1\"/>",x+1,y+1,x+2,y+2).unwrap();
    }
    let mark = ((n as f32*0.20) as usize) | 1;
    let start = 4+(n-mark)/2;
    let scale = (mark as f32-2.0)/24.0;
    write!(svg,"<rect x=\"{start}\" y=\"{start}\" width=\"{mark}\" height=\"{mark}\" fill=\"white\"/><g transform=\"translate({} {}) scale({scale})\"><circle cx=\"9\" cy=\"6\" r=\"5\"/><path d=\"M0 22v-3c0-4 4-7 9-7 3 0 5 1 6 3v7Z\"/><circle cx=\"19\" cy=\"13\" r=\"4\"/><circle cx=\"19\" cy=\"13\" r=\"1.5\" fill=\"white\"/><path d=\"M17 16h4v5l-2 3-2-3Z\"/></g></g></svg>",start+1,start+1).unwrap();
    Ok(svg)
}
