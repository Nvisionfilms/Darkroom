//! Creative look-up tables in the Adobe Cube format (`.cube`).
//!
//! Both 1D and 3D cubes are accepted; a 1D cube is expanded into a 3D lattice
//! so the preview and the export share one code path. The look is applied to
//! the display-referred image right after the point curves, which is where a
//! film or camera look belongs: the tone controls above it still work in
//! scene-referred light, and vibrance, HSL and grading still work on top.
//!
//! CPU twin of the `uLook` sampling in `DEVELOP_FRAG`.

use anyhow::{bail, Context, Result};
use std::path::Path;

/// A 3D cube lattice, `size` samples per axis, RGB triples in row-major
/// order with red varying fastest (the .cube convention).
pub struct Lut3d {
    pub name: String,
    pub size: usize,
    pub domain_min: [f32; 3],
    pub domain_max: [f32; 3],
    /// size^3 * 3 floats
    pub data: Vec<f32>,
}

/// Cubes larger than this are rejected. Resolve and most grading tools export
/// 33 and 65 points; 129 covers the rare high-precision cubes. The texture cost
/// grows with the cube of the size (129 points is about 17 MB as half floats),
/// and WebGL2 guarantees 3D textures of at least 256 per axis.
pub const MAX_SIZE: usize = 129;
/// A 1D cube is expanded to this lattice size.
const EXPAND_1D: usize = 33;

impl Lut3d {
    pub fn load(path: &Path) -> Result<Self> {
        let text =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        let name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("Look")
            .to_string();
        Self::parse(&text, name)
    }

    pub fn parse(text: &str, fallback_name: String) -> Result<Self> {
        let mut title: Option<String> = None;
        let mut size_3d: Option<usize> = None;
        let mut size_1d: Option<usize> = None;
        let mut domain_min = [0.0f32; 3];
        let mut domain_max = [1.0f32; 3];
        let mut data: Vec<f32> = Vec::new();

        for raw in text.lines() {
            let line = raw.split('#').next().unwrap_or("").trim();
            if line.is_empty() {
                continue;
            }
            let mut it = line.split_whitespace();
            let key = it.next().unwrap_or("");
            let upper = key.to_ascii_uppercase();
            match upper.as_str() {
                "TITLE" => {
                    let t = line[key.len()..].trim().trim_matches('"').to_string();
                    if !t.is_empty() {
                        title = Some(t);
                    }
                }
                "LUT_3D_SIZE" => size_3d = it.next().and_then(|v| v.parse().ok()),
                "LUT_1D_SIZE" => size_1d = it.next().and_then(|v| v.parse().ok()),
                "DOMAIN_MIN" | "DOMAIN_MAX" => {
                    let vals: Vec<f32> = it.filter_map(|v| v.parse().ok()).collect();
                    if vals.len() == 3 {
                        if upper == "DOMAIN_MIN" {
                            domain_min = [vals[0], vals[1], vals[2]];
                        } else {
                            domain_max = [vals[0], vals[1], vals[2]];
                        }
                    }
                }
                "LUT_3D_INPUT_RANGE" | "LUT_1D_INPUT_RANGE" => {
                    let vals: Vec<f32> = it.filter_map(|v| v.parse().ok()).collect();
                    if vals.len() == 2 {
                        domain_min = [vals[0]; 3];
                        domain_max = [vals[1]; 3];
                    }
                }
                _ => {
                    // a data row: three floats
                    let vals: Vec<f32> = line
                        .split_whitespace()
                        .filter_map(|v| v.parse::<f32>().ok())
                        .collect();
                    if vals.len() >= 3 {
                        data.extend_from_slice(&vals[0..3]);
                    }
                }
            }
        }

        let name = title.unwrap_or(fallback_name);
        if let Some(size) = size_3d {
            if !(2..=MAX_SIZE).contains(&size) {
                bail!("unsupported 3D cube size {size} (2..{MAX_SIZE})");
            }
            let want = size * size * size * 3;
            if data.len() < want {
                bail!("cube has {} values, expected {want}", data.len());
            }
            data.truncate(want);
            return Ok(Self {
                name,
                size,
                domain_min,
                domain_max,
                data,
            });
        }
        if let Some(size) = size_1d {
            if !(2..=65536).contains(&size) {
                bail!("unsupported 1D cube size {size}");
            }
            let want = size * 3;
            if data.len() < want {
                bail!("cube has {} values, expected {want}", data.len());
            }
            data.truncate(want);
            return Ok(Self::from_1d(name, size, &data, domain_min, domain_max));
        }
        bail!("no LUT_3D_SIZE or LUT_1D_SIZE in the .cube file")
    }

    /// Expand a per-channel curve into a 3D lattice.
    fn from_1d(
        name: String,
        size: usize,
        data: &[f32],
        domain_min: [f32; 3],
        domain_max: [f32; 3],
    ) -> Self {
        let n = EXPAND_1D;
        let mut out = vec![0.0f32; n * n * n * 3];
        let sample = |c: usize, t: f32| -> f32 {
            let p = (t.clamp(0.0, 1.0) * (size - 1) as f32).clamp(0.0, (size - 1) as f32);
            let i = p.floor() as usize;
            let j = (i + 1).min(size - 1);
            let f = p - i as f32;
            data[i * 3 + c] * (1.0 - f) + data[j * 3 + c] * f
        };
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let i = ((b * n + g) * n + r) * 3;
                    out[i] = sample(0, r as f32 / (n - 1) as f32);
                    out[i + 1] = sample(1, g as f32 / (n - 1) as f32);
                    out[i + 2] = sample(2, b as f32 / (n - 1) as f32);
                }
            }
        }
        Self {
            name,
            size: n,
            domain_min,
            domain_max,
            data: out,
        }
    }

    /// Trilinear sample. `rgb` is display-referred 0..1; the result is clamped
    /// to 0..1. Twin of `sampleLook` in the shader (which uses a linear 3D
    /// texture, i.e. the same trilinear interpolation).
    #[inline]
    pub fn sample(&self, rgb: [f32; 3]) -> [f32; 3] {
        let n = self.size;
        let last = (n - 1) as f32;
        let mut p = [0.0f32; 3];
        for c in 0..3 {
            let span = (self.domain_max[c] - self.domain_min[c]).max(1e-6);
            let t = ((rgb[c] - self.domain_min[c]) / span).clamp(0.0, 1.0);
            p[c] = t * last;
        }
        let i0 = [
            p[0].floor() as usize,
            p[1].floor() as usize,
            p[2].floor() as usize,
        ];
        let i1 = [
            (i0[0] + 1).min(n - 1),
            (i0[1] + 1).min(n - 1),
            (i0[2] + 1).min(n - 1),
        ];
        let f = [
            p[0] - i0[0] as f32,
            p[1] - i0[1] as f32,
            p[2] - i0[2] as f32,
        ];
        let at = |r: usize, g: usize, b: usize| -> &[f32] {
            let i = ((b * n + g) * n + r) * 3;
            &self.data[i..i + 3]
        };
        let mut out = [0.0f32; 3];
        for c in 0..3 {
            let c00 = at(i0[0], i0[1], i0[2])[c] * (1.0 - f[0]) + at(i1[0], i0[1], i0[2])[c] * f[0];
            let c10 = at(i0[0], i1[1], i0[2])[c] * (1.0 - f[0]) + at(i1[0], i1[1], i0[2])[c] * f[0];
            let c01 = at(i0[0], i0[1], i1[2])[c] * (1.0 - f[0]) + at(i1[0], i0[1], i1[2])[c] * f[0];
            let c11 = at(i0[0], i1[1], i1[2])[c] * (1.0 - f[0]) + at(i1[0], i1[1], i1[2])[c] * f[0];
            let c0 = c00 * (1.0 - f[1]) + c10 * f[1];
            let c1 = c01 * (1.0 - f[1]) + c11 * f[1];
            out[c] = (c0 * (1.0 - f[2]) + c1 * f[2]).clamp(0.0, 1.0);
        }
        out
    }

    /// RGBA half-float bytes for a WebGL2 3D texture (alpha = 1).
    pub fn to_rgba_f16(&self) -> Vec<u8> {
        let n = self.size * self.size * self.size;
        let mut out = Vec::with_capacity(n * 4 * 2);
        for i in 0..n {
            for c in 0..3 {
                out.extend_from_slice(&half::f16::from_f32(self.data[i * 3 + c]).to_le_bytes());
            }
            out.extend_from_slice(&half::f16::from_f32(1.0).to_le_bytes());
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_cube() {
        // a 2x2x2 identity cube
        let mut text = String::from("TITLE \"Ident\"\nLUT_3D_SIZE 2\n");
        for b in 0..2 {
            for g in 0..2 {
                for r in 0..2 {
                    text.push_str(&format!("{} {} {}\n", r as f32, g as f32, b as f32));
                }
            }
        }
        let lut = Lut3d::parse(&text, "x".into()).unwrap();
        assert_eq!(lut.size, 2);
        assert_eq!(lut.name, "Ident");
        for &c in &[[0.0, 0.0, 0.0], [1.0, 1.0, 1.0], [0.25, 0.5, 0.75]] {
            let o = lut.sample(c);
            for i in 0..3 {
                assert!((o[i] - c[i]).abs() < 1e-5, "{c:?} -> {o:?}");
            }
        }
    }

    #[test]
    fn sixty_five_point_cube_loads() {
        // the size Resolve exports by default for high-quality LUTs
        let n = 65;
        let mut text = format!("TITLE \"Resolve 65\"\nLUT_3D_SIZE {n}\n");
        for b in 0..n {
            for g in 0..n {
                for r in 0..n {
                    let s = (n - 1) as f32;
                    text.push_str(&format!(
                        "{} {} {}\n",
                        r as f32 / s,
                        g as f32 / s,
                        b as f32 / s
                    ));
                }
            }
        }
        let lut = Lut3d::parse(&text, "x".into()).unwrap();
        assert_eq!(lut.size, 65);
        let o = lut.sample([0.3, 0.6, 0.9]);
        for (got, want) in o.iter().zip([0.3f32, 0.6, 0.9]) {
            assert!((got - want).abs() < 1e-4, "{o:?}");
        }
        assert_eq!(lut.to_rgba_f16().len(), 65 * 65 * 65 * 4 * 2);
    }

    #[test]
    fn oversized_cube_is_rejected() {
        let text = format!("LUT_3D_SIZE {}\n", MAX_SIZE + 1);
        assert!(Lut3d::parse(&text, "x".into()).is_err());
    }

    #[test]
    fn one_d_cube_expands() {
        // a 1D cube that inverts every channel
        let mut text = String::from("LUT_1D_SIZE 2\n1 1 1\n0 0 0\n");
        text.push('\n');
        let lut = Lut3d::parse(&text, "inv".into()).unwrap();
        let o = lut.sample([0.0, 0.0, 0.0]);
        assert!((o[0] - 1.0).abs() < 1e-4, "{o:?}");
        let o = lut.sample([1.0, 1.0, 1.0]);
        assert!(o[0].abs() < 1e-4, "{o:?}");
    }
}
