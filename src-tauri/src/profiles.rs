//! Picture profiles: deterministic starting looks, the way a camera's
//! Standard / Portrait / Landscape / Neutral picture styles differ from each
//! other. A profile only moves normal develop controls (contrast, saturation,
//! vibrance, warmth and the eight HSL bands), so every result stays editable
//! and nothing is generated.
//!
//! CPU twin of `src/profiles.ts`. The numbers here and there must match.

use serde::{Deserialize, Serialize};

/// Band order matches `HSL_CENTERS` in pipeline.rs:
/// red, orange, yellow, green, aqua, blue, purple, magenta.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct ProfileLook {
    /// added to the contrast slider (-100..100 units)
    pub contrast: f32,
    /// added to saturation (-100..100 units)
    pub saturation: f32,
    /// added to vibrance
    pub vibrance: f32,
    /// added to temperature
    pub temperature: f32,
    /// added to the HSL band saturations
    pub band_sat: [f32; 8],
    /// added to the HSL band luminances
    pub band_lum: [f32; 8],
    /// added to the HSL band hues
    pub band_hue: [f32; 8],
    /// true for the black and white profiles
    pub mono: bool,
    /// channel weights used by the mono conversion (Rec.709 by default)
    pub mono_mix: [f32; 3],
}

const Z: [f32; 8] = [0.0; 8];
const REC709: [f32; 3] = [0.2126, 0.7152, 0.0722];

/// Look for a profile id. Unknown ids fall back to Standard.
pub fn look(id: &str) -> ProfileLook {
    match id {
        "flat" | "linear" => ProfileLook {
            contrast: -10.0,
            saturation: -8.0,
            mono_mix: REC709,
            ..Default::default()
        },
        "neutral" => ProfileLook {
            contrast: -6.0,
            saturation: -6.0,
            vibrance: 4.0,
            mono_mix: REC709,
            ..Default::default()
        },
        "portrait" => ProfileLook {
            contrast: 4.0,
            saturation: -2.0,
            vibrance: 10.0,
            temperature: 4.0,
            // hold skin tones back a little and lift them
            band_sat: [-4.0, -8.0, -4.0, 0.0, 0.0, 0.0, 0.0, -2.0],
            band_lum: [2.0, 5.0, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            band_hue: [0.0, 3.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
            mono_mix: REC709,
            mono: false,
        },
        "landscape" => ProfileLook {
            contrast: 12.0,
            saturation: 6.0,
            vibrance: 12.0,
            temperature: -2.0,
            band_sat: [0.0, 0.0, 6.0, 14.0, 10.0, 14.0, 0.0, 0.0],
            band_lum: [0.0, 0.0, 2.0, -4.0, -2.0, -6.0, 0.0, 0.0],
            band_hue: [0.0, 0.0, -4.0, -6.0, 0.0, 0.0, 0.0, 0.0],
            mono_mix: REC709,
            mono: false,
        },
        "vivid" => ProfileLook {
            contrast: 18.0,
            saturation: 18.0,
            vibrance: 10.0,
            mono_mix: REC709,
            ..Default::default()
        },
        "mono" => ProfileLook {
            contrast: 8.0,
            mono: true,
            mono_mix: REC709,
            ..Default::default()
        },
        "mono-red" => ProfileLook {
            contrast: 12.0,
            mono: true,
            // red filter: dark skies, bright skin
            mono_mix: [0.62, 0.31, 0.07],
            ..Default::default()
        },
        "mono-yellow" => ProfileLook {
            contrast: 10.0,
            mono: true,
            mono_mix: [0.42, 0.48, 0.10],
            ..Default::default()
        },
        // "standard"
        _ => ProfileLook {
            band_sat: Z,
            band_lum: Z,
            band_hue: Z,
            mono_mix: REC709,
            ..Default::default()
        },
    }
}

pub const IDS: &[&str] = &[
    "standard",
    "neutral",
    "portrait",
    "landscape",
    "vivid",
    "flat",
    "mono",
    "mono-yellow",
    "mono-red",
];
