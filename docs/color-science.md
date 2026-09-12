# Colour science and noise reduction notes

What was borrowed from DaVinci Resolve, what was not, and why.

## Resolve's model in one paragraph

Resolve Color Management (like ACES) is **scene-referred**: the image is kept as a
representation of scene light in a very wide gamut for as long as possible, every creative
operation happens there, and only the final step converts to a display (sRGB, Rec.709, P3,
HDR). Its default working space since v17 is **DaVinci Wide Gamut (DWG)** with the
**DaVinci Intermediate (DI)** log curve. DWG is larger than Rec.2020 and ARRI Wide Gamut, so
every camera's native gamut fits inside it without clipping; DI encodes >9 stops above
18% grey. The output transform ("Color Space Transform" / RCM output) applies
**DaVinci tone mapping** (smooth luminance roll-off in shadows and highlights with
controlled desaturation of the brightest values) and **saturation / gamut mapping** so
colours outside the display gamut compress instead of clipping.

## What Darkroom does with that

| Resolve concept | Darkroom implementation |
| --- | --- |
| Working space DWG, D65 | `decode.rs` outputs linear DWG. RAW: camera matrix -> XYZ -> DWG (rows normalised so camera white is DWG white). JPEG/TIFF: sRGB -> DWG. Constants in `color.rs`. |
| Grade in log around mid grey | Tone controls run on `log2(Y / 0.18)`: contrast is a slope about mid grey, highlights/shadows/whites/blacks are smooth EV offsets in tonal zones. |
| DaVinci tone mapping | Luminance-preserving tone step, then a per-channel exponential shoulder above 0.8 (film-like highlight desaturation). |
| Saturation / gamut mapping | `gamut_compress()`: after DWG -> sRGB, colours whose minimum channel goes negative are pulled toward their luminance with a soft knee starting at 75% of the way to the boundary, hue preserved. No hard clipping of saturated blues, reds. |
| Midtone Detail | **Clarity**: `log2` luma minus a 2%-of-long-edge Gaussian, weighted to midtones (full within +-1.5 EV of mid grey), soft-limited with `tanh` so halos stay bounded. Negative values soften. |
| (Structure, Capture One / Nik) | **Texture**: band-pass of the log luma between sigma 1 px and sigma 4 px, so it boosts surface detail without amplifying single-pixel noise. |
| Color Boost | Vibrance (boosts low-saturation pixels more than saturated ones). |
| DaVinci Intermediate curve | Encoder/decoder in `color.rs`; used to feed LUTs whose input is DaVinci Intermediate / Wide Gamut. |
| Output colour space tagging | Every exported file carries an embedded sRGB ICC profile, built in `icc.rs` (ICC v2.1 matrix/TRC, sRGB primaries Bradford-adapted to the D50 connection space, 1024-point sampled sRGB curve). Without it the numbers are still sRGB but the viewer has to guess, and on a calibrated or wide-gamut display an untagged file looks more saturated than the app - the preview canvas is colour managed by the webview. |
| Layer compositing (Fusion / Photoshop) | **Double exposure** (`blend.rs`): the default Expose mode adds the second picture as linear light right after white balance and exposure, so the shared tone map rolls the overlap off together, as one negative would. Screen, Multiply, Overlay, Soft light, Lighten, Darken, Difference and Normal run after the point curves on gamma-encoded values, with the overlay put through the same display transform (`display_encode`) as the base picture. Placement is resolution-independent, so preview and export agree. |
| Color Space Transform before a camera LUT | `camlog.rs`: linear DWG is converted to the LUT's camera gamut (S-Gamut3.Cine, S-Gamut3, Cinema Gamut, Blackmagic Wide Gamut Gen 5, DWG) and encoded with its published log curve (S-Log3, Canon Log 3 v1.2, Blackmagic Film Gen 5, DaVinci Intermediate) before the LUT is sampled. |

Local-contrast radii scale with the long edge, so the preview (<= 2560 px) and the
full-resolution export look the same.

### DaVinci Wide Gamut

Primaries R (0.8000, 0.3130), G (0.1682, 0.9877), B (0.0790, -0.1155), white D65.
The DWG -> XYZ matrix derived from those primaries matches the one shipped in Resolve to 7
digits. Note DWG blue has negative Y, so the pipeline uses a positive-weight luma proxy
(Rec.2020 weights) for tone and denoise decisions and only uses true luminance in
display space.

## Noise reduction

Resolve's spatial NR (the part that applies to stills) exposes **Luma** and **Chroma**
thresholds separately, a **Radius**, a **Mode** (Faster / Better / Enhanced, where Enhanced
preserves detail best at high settings) and a **Blend** back to the original. Temporal NR
needs neighbouring frames and does not apply to photos. Resolve applies NR at the start
of the node tree, before sharpening.

Darkroom's denoiser (`denoise.rs` / `DENOISE_FRAG`):

- **Non-local means**, 7x7 search window, 3x3 patches, on the *linear scene data* before
  any tone change and before sharpening.
- Patch distances are measured in a **square-root domain** so photon-shot noise is roughly
  uniform across the tonal range (a cheap variance-stabilising transform).
- **Luminance and colour are weighted separately** (two weight sets from the same patch
  comparison): colour speckle can be removed aggressively while luma edges keep their own
  weights. The output takes luma from the luma-weighted average and chroma from the
  chroma-weighted average.
- **Detail** restores residuals that are large compared with the noise (soft threshold
  at 2 sigma), so real edges the smoother touched come back while noise does not. It is
  a smarter version of Resolve's Blend.
- **Two scales** ("Enhanced" territory): a second NLM at half resolution removes the
  low-frequency blotches a 7x7 window cannot see; its low frequencies replace those of
  the full-res result (`out = d1 + up(nlm(down(src))) - up(down(d1))`).
- **Noise sigma is estimated from the image**: the 20th percentile of 8x8-block standard
  deviations in the sqrt-luma domain. Laplacian-style estimators were tried first and
  underestimated by ~35% because demosaicing leaves spatially correlated noise.
- The CPU export uses the per-offset + box-filter formulation (49 offsets, not 441
  fetches). A 24 MP Canon file denoises in about 10 s on this machine; the GPU preview is
  interactive.

## Not done yet

- A Kelvin/tint white balance model (current temperature/tint are RGB gain
  approximations).
- Output to Display P3 / Adobe RGB / Rec.2020 and HDR output transforms.
- Input ICC profiles for JPEG/TIFF.
- Resolve's colour warper / hue-vs-hue style curves.
- S-Log2, ARRI LogC and other camera log inputs beyond S-Log3, Canon Log 3, Blackmagic Film Gen 5 and DaVinci Intermediate.
