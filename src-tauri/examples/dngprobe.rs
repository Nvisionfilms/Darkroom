//! Probe a DNG strip: decode it with rawler's lossless JPEG decompressor
//! directly and report what comes out, to tell a decoding fault from a
//! colour-pipeline fault.
//!
//!   cargo run --example dngprobe -- <file.dng> <strip offset> <strip length> [out.png]

use rawler::decompressors::ljpeg::LjpegDecompressor;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 4 {
        eprintln!("usage: dngprobe <file.dng> <offset> <length> [out.png]");
        std::process::exit(2);
    }
    let bytes = std::fs::read(&args[1])?;
    let off: usize = args[2].parse()?;
    let len: usize = args[3].parse()?;
    let strip = &bytes[off..off + len];

    let d = LjpegDecompressor::new(strip).map_err(|e| format!("ljpeg: {e}"))?;
    let w = d.width();
    let h = d.height();
    let comps = d.components();
    println!("ljpeg: {w} samples per row x {h} rows, {comps} components");

    let mut buf = vec![0u16; w * h];
    d.decode(&mut buf, 0, w, w, h, false)
        .map_err(|e| format!("decode: {e}"))?;

    let mut min = u16::MAX;
    let mut max = 0u16;
    let mut sum = 0u64;
    for v in &buf {
        min = min.min(*v);
        max = max.max(*v);
        sum += *v as u64;
    }
    println!(
        "samples: min {min} max {max} mean {:.1}",
        sum as f64 / buf.len() as f64
    );
    println!("row 0, first 12: {:?}", &buf[..12]);
    println!("row 1000, first 12: {:?}", &buf[1000 * w..1000 * w + 12]);
    println!("row 2999, first 12: {:?}", &buf[2999 * w..2999 * w + 12]);

    // row means: a picture varies, a runaway predictor climbs steadily
    for r in [0usize, 750, 1500, 2250, 2999] {
        let row = &buf[r * w..(r + 1) * w];
        let m = row.iter().map(|v| *v as u64).sum::<u64>() as f64 / row.len() as f64;
        println!("row {r:4} mean {m:8.1}");
    }

    if let Some(out) = args.get(4) {
        let pw = w / comps.max(1);
        let mut img = image::ImageBuffer::<image::Rgb<u8>, Vec<u8>>::new(pw as u32, h as u32);
        for y in 0..h {
            for x in 0..pw {
                let i = y * w + x * comps;
                let px = |c: usize| (buf.get(i + c).copied().unwrap_or(0) >> 8) as u8;
                img.put_pixel(
                    x as u32,
                    y as u32,
                    image::Rgb([px(0), px(1 % comps), px(2 % comps)]),
                );
            }
        }
        img.save(out)?;
        println!("wrote {out}");
    }
    Ok(())
}
