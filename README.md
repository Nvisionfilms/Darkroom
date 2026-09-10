# Darkroom

A standalone desktop RAW photo editor in the spirit of Lightroom / Luminar.
Tauri 2 shell, Rust core (decode + export), React/TypeScript UI, WebGL2 real-time develop pipeline.

## Supported input

- **RAW:** Canon CR2/CR3/CRW, Sony ARW/SRF/SR2, Nikon NEF/NRW, Adobe DNG, Fuji RAF, Olympus ORF, Panasonic RW2, Pentax PEF, Phase One IIQ, Hasselblad 3FR and more (via `rawler`).
- **Bitmap:** JPEG, PNG, TIFF (8/16-bit). Embedded ICC profiles are ignored; input is assumed sRGB.

## Output

JPEG (quality 50–100), PNG and TIFF (8- or 16-bit), optional resize on the long edge.

## Product behavior

- **Motion Trails**: repeated semi-transparent directional echoes from the existing developed photo, with Amount, Direction, Distance, Copies, Fade, Blur, and Opacity controls.
- **Auto Edit**: a deterministic one-click recipe over normal develop sliders (contrast, highlights/shadows, vibrance/saturation, texture/clarity, denoise, sharpening). Every result remains editable. It is not generative AI and never adds, removes, or replaces image content.
- **Picture Profiles and Looks**: alongside the built-in profiles, load any `.cube` look-up table (1D or 3D, up to 64 points per axis) with an Amount slider. The look is applied after the point curves, so the tone controls above it still work in scene-referred light and vibrance, HSL and colour grading still work on top.
- **Presets**: save the current develop settings under a name and apply them to any other photo. A preset carries tone, colour, curves, detail, profile, look and lens settings; it never carries the crop, perspective, masks or retouch spots, so applying one never moves the picture around. Presets live in the app data folder.
- **Lens Corrections**: distortion, vignetting and colour fringing from the bundled open [lensfun](https://lensfun.github.io) database, matched automatically from the camera and lens recorded in the file, plus manual sliders for lenses that are not in it.
- **Transform**: perspective correction (vertical and horizontal keystone), rotate, aspect, scale and shift.
- **Picture Profiles**: Standard, Neutral, Portrait, Landscape, Vivid, Flat and three monochrome looks. A profile only moves normal develop controls, so every result stays editable.
- **Object Remover**: heal and clone spots that copy real pixels from elsewhere in the same photograph, with an automatic patch search. Heal also matches the brightness and colour of the new surroundings. Patch-based, not generative.
- **Masks (local adjustments)**: linear and radial gradients, a brush, a luminance range, and an on-device **Subject** mask (a small salient-object model runs locally; nothing is uploaded and no pixels are generated). Each mask carries its own Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature, Tint, Saturation, Texture, Clarity and Dehaze, can be inverted, and shows as a red overlay (M). Masks are stored in the sidecar and applied identically on export.
- **Dehaze**: dark-channel haze removal (or added haze with negative values), globally and per mask.
- **White balance eyedropper**: click something neutral in the photo to set Temperature and Tint.
- **Auto noise reduction**: sets the noise sliders from the measured noise level, optionally for every new RAW file.
- **Crop guides**: Thirds, Grid, Golden Ratio, Golden Spiral, Golden Triangle and Diagonal (O cycles, Shift+O flips).
- **Filmstrip thumbnails** generate on their own in the background, three at a time, so a restored session, a browsed folder or a tethered burst fills in without clicking each frame. RAW files use the camera’s embedded preview, which is far quicker than demosaicing.
- **Tethered Capture**: Darkroom watches the folder your camera software saves into (EOS Utility, Imaging Edge Desktop, a camera Wi‑Fi/FTP push, or a card reader) and opens each shot as it finishes writing. USB and Wi‑Fi both work because the vendor app does the transfer. Tether → Tethered Capture → choose the folder → Start watching.
- **Phone Monitor**: the app serves a live page on the local network (QR code in Tether → Phone Monitor). The phone shows the developed picture as you edit it plus the recent filmstrip. Nothing leaves the LAN and nothing is uploaded.
- Motion Trails retain the legacy `mirror` sidecar key only for backwards compatibility with existing `.drk.json` edits.

## Development

```bash
bun install
bun run tauri dev
bun run tauri build
```

## Release notes

See `docs/windows-release.md` for the Windows installer validation path, `docs/product-audit.md` for the product/architecture roadmap, and `docs/color-science.md` for the color pipeline.
