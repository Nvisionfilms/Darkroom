//! Headless smoke test: decode an image, print metadata, export a JPEG.
//!
//! cargo run --example develop -- <input> <output.jpg> [edits.json] [max_long_edge]

use darkroom_lib::decode;
use darkroom_lib::export::{export, ExportRequest};
use darkroom_lib::pipeline::{identity_lut, EditParams};
use std::path::Path;
use std::time::Instant;

fn main() -> anyhow::Result<()> {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!("usage: develop <input> <output.jpg> [edits.json] [max_long_edge]");
        std::process::exit(2);
    }
    let input = Path::new(&args[1]);
    let output = &args[2];
    let params: EditParams = match args.get(3) {
        Some(p) => serde_json::from_str(&std::fs::read_to_string(p)?)?,
        None => EditParams::default(),
    };
    let max_edge: Option<u32> = args.get(4).and_then(|s| s.parse().ok());

    // Dump the camera's embedded preview (if any) next to the output for comparison.
    if decode::is_raw(input) {
        if let Ok(src) = rawler::rawsource::RawSource::new(input) {
            if let Ok(dec) = rawler::get_decoder(&src) {
                let p = rawler::decoders::RawDecodeParams::default();
                if let Ok(Some(prev)) = dec
                    .preview_image(&src, &p)
                    .or_else(|_| dec.full_image(&src, &p))
                {
                    let cam_path = format!("{}_camera.jpg", output.trim_end_matches(".jpg"));
                    let small = prev.resize(1600, 1600, image::imageops::FilterType::Triangle);
                    small.to_rgb8().save(&cam_path)?;
                    println!(
                        "camera preview {}x{} -> {}",
                        prev.width(),
                        prev.height(),
                        cam_path
                    );
                }
            }
        }
    }

    let t = Instant::now();
    let (img, meta) = decode::load(input)?;
    println!(
        "decoded {}x{} in {:.2}s",
        img.width,
        img.height,
        t.elapsed().as_secs_f32()
    );
    println!("{}", serde_json::to_string_pretty(&meta)?);
    let (mut mn, mut mx, mut sum) = (f32::MAX, f32::MIN, 0.0f64);
    for v in &img.data {
        mn = mn.min(*v);
        mx = mx.max(*v);
        sum += *v as f64;
    }
    println!(
        "linear range: min {mn:.4} max {mx:.4} mean {:.4}",
        sum / img.data.len() as f64
    );

    let t = Instant::now();
    export(
        &img,
        &ExportRequest {
            out_path: output.to_string(),
            format: "jpeg".into(),
            quality: 92,
            bit_depth: 8,
            max_long_edge: max_edge,
            params,
            lut: identity_lut(),
        },
    )?;
    println!("exported {} in {:.2}s", output, t.elapsed().as_secs_f32());
    Ok(())
}
