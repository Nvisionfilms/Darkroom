//! Print low-level RAW facts for debugging: cargo run --example rawinfo -- <file>
use rawler::decoders::RawDecodeParams;
use rawler::rawsource::RawSource;
fn main() -> anyhow::Result<()> {
    let path = std::env::args().nth(1).expect("file");
    let src = RawSource::new(std::path::Path::new(&path))?;
    let dec = rawler::get_decoder(&src)?;
    let raw = dec.raw_image(&src, &RawDecodeParams::default(), false)?;
    let data = raw.data.as_f32();
    let mx = data.iter().cloned().fold(f32::MIN, f32::max);
    let mn = data.iter().cloned().fold(f32::MAX, f32::min);
    println!(
        "dims {}x{} cpp={} bps={} data min={} max={} len={}",
        raw.width,
        raw.height,
        raw.cpp,
        raw.bps,
        mn,
        mx,
        data.len()
    );
    println!(
        "white={:?} black={:?}",
        raw.whitelevel, raw.blacklevel.levels
    );
    println!(
        "wb={:?} photometric={:?}",
        raw.wb_coeffs,
        std::mem::discriminant(&raw.photometric)
    );
    let mut tags: Vec<_> = raw.dng_tags.keys().collect();
    tags.sort();
    println!("dng_tags: {:?}", tags);
    for (k, v) in &raw.dng_tags {
        let s = format!("{:?}", v);
        println!("  tag {:#06x}: {}", k, &s[..s.len().min(160)]);
    }
    if let Some(out) = std::env::args().nth(2) {
        use rawler::imgop::develop::RawDevelop;
        let dev = RawDevelop::default();
        let inter = dev.develop_intermediate(&raw)?;
        let img = inter.to_dynamic_image().expect("image");
        img.resize(1200, 1200, image::imageops::FilterType::Triangle)
            .to_rgb8()
            .save(&out)?;
        println!("rawler default develop -> {out}");
    }
    Ok(())
}
