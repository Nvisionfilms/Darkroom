//! A minimal sRGB ICC profile, embedded in every exported file.
//!
//! Darkroom's display transform ends in the sRGB OETF, so exported pixels are
//! sRGB numbers. Without a profile attached, a viewer has to guess: a
//! colour-managed one assumes sRGB and converts to the display, a careless one
//! sends the numbers straight to the panel. On a calibrated or wide-gamut
//! monitor those two are visibly different, and the file no longer matches
//! what the app showed - the preview canvas *is* colour managed by the
//! webview. Tagging the file removes the guesswork.
//!
//! This builds the profile rather than shipping someone else's .icc: it is a
//! plain ICC v2.1 matrix/TRC display profile with the sRGB primaries
//! chromatically adapted to the D50 profile connection space (the same
//! Bradford-adapted numbers every sRGB profile carries) and a 1024-point
//! sampled sRGB tone curve.

/// Points in the sampled tone reproduction curve.
const TRC_POINTS: usize = 1024;

/// sRGB primaries adapted to D50, as (X, Y, Z). These are the standard
/// Bradford-adapted values found in the reference sRGB profile.
const PRIMARIES: [[f64; 3]; 3] = [
    [0.436_074_7, 0.222_504_5, 0.013_932_2], // red
    [0.385_064_9, 0.716_878_6, 0.097_104_5], // green
    [0.143_080_4, 0.060_616_9, 0.714_173_3], // blue
];

/// The D50 profile connection space white point.
const D50: [f64; 3] = [0.964_202_9, 1.0, 0.824_905_1];

const DESC: &str = "sRGB (Darkroom)";
const COPYRIGHT: &str = "Public Domain";

fn s15_fixed16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i32).to_be_bytes()
}

/// The sRGB electro-optical transfer function: encoded value to linear light.
fn srgb_to_linear(x: f64) -> f64 {
    if x <= 0.040_45 {
        x / 12.92
    } else {
        ((x + 0.055) / 1.055).powf(2.4)
    }
}

fn xyz_tag(v: [f64; 3]) -> Vec<u8> {
    let mut t = Vec::with_capacity(20);
    t.extend_from_slice(b"XYZ ");
    t.extend_from_slice(&[0; 4]);
    for c in v {
        t.extend_from_slice(&s15_fixed16(c));
    }
    t
}

/// `curv` with a sampled sRGB tone curve. All three channels share it.
fn trc_tag() -> Vec<u8> {
    let mut t = Vec::with_capacity(12 + TRC_POINTS * 2);
    t.extend_from_slice(b"curv");
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(&(TRC_POINTS as u32).to_be_bytes());
    for i in 0..TRC_POINTS {
        let x = i as f64 / (TRC_POINTS - 1) as f64;
        let v = (srgb_to_linear(x) * 65535.0).round().clamp(0.0, 65535.0) as u16;
        t.extend_from_slice(&v.to_be_bytes());
    }
    t
}

/// ICC v2 `textDescriptionType`: an ASCII string plus empty Unicode and
/// ScriptCode blocks, which the format requires even when unused.
fn desc_tag(s: &str) -> Vec<u8> {
    let ascii = s.as_bytes();
    let count = ascii.len() + 1;
    let mut t = Vec::with_capacity(12 + count + 78);
    t.extend_from_slice(b"desc");
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(&(count as u32).to_be_bytes());
    t.extend_from_slice(ascii);
    t.push(0);
    t.extend_from_slice(&[0; 4]); // unicode language code
    t.extend_from_slice(&[0; 4]); // unicode count
    t.extend_from_slice(&[0; 2]); // scriptcode code
    t.push(0); // scriptcode count
    t.extend_from_slice(&[0; 67]); // scriptcode, fixed length
    t
}

fn text_tag(s: &str) -> Vec<u8> {
    let mut t = Vec::with_capacity(8 + s.len() + 1);
    t.extend_from_slice(b"text");
    t.extend_from_slice(&[0; 4]);
    t.extend_from_slice(s.as_bytes());
    t.push(0);
    t
}

/// The profile as ICC bytes. Deterministic, so the same edit always exports
/// byte-identical metadata.
pub fn srgb() -> Vec<u8> {
    let trc = trc_tag();
    // (signature, data). The three tone curves deliberately share one block,
    // which the format allows and real profiles do.
    let tags: Vec<(&[u8; 4], Vec<u8>)> = vec![
        (b"bTRC", Vec::new()),
        (b"bXYZ", xyz_tag(PRIMARIES[2])),
        (b"cprt", text_tag(COPYRIGHT)),
        (b"desc", desc_tag(DESC)),
        (b"gTRC", Vec::new()),
        (b"gXYZ", xyz_tag(PRIMARIES[1])),
        (b"rTRC", trc),
        (b"rXYZ", xyz_tag(PRIMARIES[0])),
        (b"wtpt", xyz_tag(D50)),
    ];

    let table_len = 4 + tags.len() * 12;
    let mut data = Vec::new();
    let mut entries: Vec<(&[u8; 4], u32, u32)> = Vec::with_capacity(tags.len());
    let mut shared: Option<(u32, u32)> = None;
    for (sig, body) in &tags {
        if body.is_empty() {
            // a tone curve that shares the block written for the red channel;
            // it may be listed before that block exists, so it is filled in
            // by the second pass below
            entries.push((sig, 0, 0));
            continue;
        }
        let offset = (128 + table_len + data.len()) as u32;
        data.extend_from_slice(body);
        while data.len() % 4 != 0 {
            data.push(0);
        }
        entries.push((sig, offset, body.len() as u32));
        if **sig == *b"rTRC" {
            shared = Some((offset, body.len() as u32));
        }
    }
    // bTRC and gTRC are listed before rTRC, so fill them in once it is placed.
    let (off, len) = shared.expect("no tone curve");
    for e in entries.iter_mut() {
        if *e.0 == *b"bTRC" || *e.0 == *b"gTRC" {
            e.1 = off;
            e.2 = len;
        }
    }

    let size = 128 + table_len + data.len();
    let mut p = Vec::with_capacity(size);
    p.extend_from_slice(&(size as u32).to_be_bytes()); // profile size
    p.extend_from_slice(&[0; 4]); // preferred CMM
    p.extend_from_slice(&0x0210_0000u32.to_be_bytes()); // version 2.1
    p.extend_from_slice(b"mntr"); // display device
    p.extend_from_slice(b"RGB "); // data colour space
    p.extend_from_slice(b"XYZ "); // profile connection space
                                  // creation date: fixed, so exports stay reproducible
    for v in [2026u16, 1, 1, 0, 0, 0] {
        p.extend_from_slice(&v.to_be_bytes());
    }
    p.extend_from_slice(b"acsp"); // file signature
    p.extend_from_slice(&[0; 4]); // primary platform
    p.extend_from_slice(&[0; 4]); // profile flags
    p.extend_from_slice(&[0; 4]); // device manufacturer
    p.extend_from_slice(&[0; 4]); // device model
    p.extend_from_slice(&[0; 8]); // device attributes
    p.extend_from_slice(&0u32.to_be_bytes()); // rendering intent: perceptual
    for c in D50 {
        p.extend_from_slice(&s15_fixed16(c));
    }
    p.extend_from_slice(&[0; 4]); // profile creator
    p.extend_from_slice(&[0; 16]); // profile id
    p.extend_from_slice(&[0; 28]); // reserved
    debug_assert_eq!(p.len(), 128);

    p.extend_from_slice(&(entries.len() as u32).to_be_bytes());
    for (sig, off, len) in &entries {
        p.extend_from_slice(*sig);
        p.extend_from_slice(&off.to_be_bytes());
        p.extend_from_slice(&len.to_be_bytes());
    }
    p.extend_from_slice(&data);
    p
}

#[cfg(test)]
mod tests {
    use super::*;

    fn be32(b: &[u8], at: usize) -> u32 {
        u32::from_be_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }

    #[test]
    fn header_is_a_valid_icc_profile() {
        let p = srgb();
        assert_eq!(
            be32(&p, 0) as usize,
            p.len(),
            "size field must match the file"
        );
        assert_eq!(&p[36..40], b"acsp", "missing the ICC file signature");
        assert_eq!(&p[12..16], b"mntr");
        assert_eq!(&p[16..20], b"RGB ");
        assert_eq!(&p[20..24], b"XYZ ");
        assert_eq!(be32(&p, 8), 0x0210_0000);
    }

    #[test]
    fn every_tag_is_present_and_in_bounds() {
        let p = srgb();
        let n = be32(&p, 128) as usize;
        assert_eq!(n, 9);
        let mut seen = Vec::new();
        for i in 0..n {
            let at = 132 + i * 12;
            let sig = std::str::from_utf8(&p[at..at + 4]).unwrap().to_string();
            let off = be32(&p, at + 4) as usize;
            let len = be32(&p, at + 8) as usize;
            assert!(off + len <= p.len(), "{sig} runs past the end");
            assert_eq!(off % 4, 0, "{sig} is not aligned");
            seen.push(sig);
        }
        for want in [
            "rXYZ", "gXYZ", "bXYZ", "rTRC", "gTRC", "bTRC", "wtpt", "desc", "cprt",
        ] {
            assert!(seen.iter().any(|s| s == want), "missing {want}");
        }
    }

    #[test]
    fn the_three_tone_curves_share_one_block() {
        let p = srgb();
        let find = |want: &str| {
            let n = be32(&p, 128) as usize;
            (0..n)
                .map(|i| 132 + i * 12)
                .find(|&at| &p[at..at + 4] == want.as_bytes())
                .map(|at| (be32(&p, at + 4), be32(&p, at + 8)))
                .unwrap()
        };
        assert_eq!(find("rTRC"), find("gTRC"));
        assert_eq!(find("rTRC"), find("bTRC"));
        let (off, len) = find("rTRC");
        assert_eq!(&p[off as usize..off as usize + 4], b"curv");
        assert_eq!(len as usize, 12 + TRC_POINTS * 2);
    }

    #[test]
    fn the_tone_curve_is_the_srgb_transfer_function() {
        let p = srgb();
        let n = be32(&p, 128) as usize;
        let at = (0..n)
            .map(|i| 132 + i * 12)
            .find(|&at| &p[at..at + 4] == b"rTRC")
            .unwrap();
        let off = be32(&p, at + 4) as usize;
        let count = be32(&p, off + 8) as usize;
        assert_eq!(count, TRC_POINTS);
        let point = |i: usize| {
            let a = off + 12 + i * 2;
            u16::from_be_bytes([p[a], p[a + 1]]) as f64 / 65535.0
        };
        assert!(point(0) < 1e-6, "black must stay black");
        assert!(
            (point(TRC_POINTS - 1) - 1.0).abs() < 1e-6,
            "white must stay white"
        );
        // mid grey: sRGB 0.5 is 0.2140 linear
        let mid = point(TRC_POINTS / 2);
        assert!(
            (mid - srgb_to_linear(0.5)).abs() < 2e-3,
            "mid grey is {mid}"
        );
        // monotonic
        for i in 1..TRC_POINTS {
            assert!(point(i) >= point(i - 1), "the curve dips at {i}");
        }
    }

    #[test]
    fn the_primaries_sum_to_the_white_point() {
        // a correct matrix profile maps white (1,1,1) onto the PCS white
        for c in 0..3 {
            let sum: f64 = PRIMARIES.iter().map(|p| p[c]).sum();
            assert!(
                (sum - D50[c]).abs() < 1e-3,
                "channel {c} sums to {sum}, want {}",
                D50[c]
            );
        }
    }
}
