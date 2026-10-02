# Darkroom

A standalone desktop RAW photo editor in the spirit of Lightroom / Luminar.
Tauri 2 shell, Rust core (decode + export), React/TypeScript UI, WebGL2 real-time develop pipeline.

## Supported input

- **RAW:** Canon CR2/CR3/CRW, Sony ARW/SRF/SR2, Nikon NEF/NRW, Adobe DNG, Fuji RAF, Olympus ORF, Panasonic RW2, Pentax PEF, Phase One IIQ, Hasselblad 3FR and more (via `rawler`). Linear DNGs whose lossless JPEG uses restart markers - Samsung Expert RAW, for one - are decoded by `lossless.rs`, because the decoder underneath ignores those markers and turns the picture into a gradient.
- **Not yet:** CinemaDNG from Blackmagic cameras. Those frames are 12-bit DCT JPEG, and no Rust JPEG decoder reads anything but 8-bit. Convert a clip to lossless or uncompressed DNG (DNG Converter, Resolve) and it opens.
- **Bitmap:** JPEG, PNG, TIFF (8/16-bit). Embedded ICC profiles are ignored; input is assumed sRGB.

## Output

JPEG (quality 50–100), PNG and TIFF (8- or 16-bit), optional resize on the long edge.

## Product behavior

- **Motion Trails**: repeated semi-transparent directional echoes from the existing developed photo, with Amount, Direction, Distance, Copies, Fade, Blur, and Opacity controls. **Trail from** points the effect at one of the photo's masks: the echoes are then cut from that mask's area alone and the area itself is left untouched, so a trail streaks out from behind a selected subject while the subject keeps every bit of its own detail. With no mask chosen the whole frame echoes, as before. The section sits under Masks, because that is where the subject comes from. Every echo is a translated copy of pixels that are already in the photograph — no AI manipulation.
- **Auto Edit**: a deterministic one-click recipe over normal develop sliders (contrast, highlights/shadows, vibrance/saturation, texture/clarity, denoise, sharpening). Every result remains editable. It is not generative AI and never adds, removes, or replaces image content.
- **Picture Profiles and Looks**: alongside the built-in profiles, load any `.cube` look-up table (1D or 3D, up to 129 points per axis, so Resolve's 33- and 65-point exports load) with an Amount slider. A **LUT input** setting tells Darkroom what the LUT was built for: a finished Rec.709/sRGB picture, or camera log footage (Sony S-Log3 with S-Gamut3.Cine or S-Gamut3, Canon Log 3 / Cinema Gamut, Blackmagic Film Gen 5, DaVinci Intermediate / Wide Gamut). For a log LUT the photo is converted into that camera's gamut and log curve first, exactly as a Resolve colour space transform would, using each maker's published specification. The input is detected from the file name, e.g. `SLog3SGamut3.CineToLC-709.cube`. The look is applied after the point curves, so the tone controls above it still work in scene-referred light and vibrance, HSL and colour grading still work on top.
- **Filmstrip selection and batch work**: click to open a photo, Ctrl/Cmd-click to pick several, Shift-click for a run, Ctrl+A for all. With a selection you can export them all in one go (each with its own saved edits, into a folder you choose), apply a preset to every one of them, or take them out of the strip with Delete or the right-click menu. Removing never deletes the file from disk.
- **Undo and redo**: every develop change is a step (Ctrl+Z / Ctrl+Shift+Z, or the arrows in the title bar). A slider drag counts as one step, and each photo keeps its own history.
- **Presets**: save the current develop settings under a name and apply them to any other photo. A preset carries tone, colour, curves, detail, profile, look and lens settings; it never carries the crop, perspective, masks or retouch spots, so applying one never moves the picture around. Presets live in the app data folder.
- **Export the look as a `.cube` LUT**: Presets → *Export .cube* writes the current look as a 17/33/65-point 3D LUT for Resolve, Premiere, Final Cut, OBS or a camera. It is not an approximation of the pipeline — each lattice point is run through the same per-pixel develop the export uses, so a host applying the LUT to a Rec.709/sRGB image gets what Darkroom shows. A LUT is a colour-for-colour lookup, so it carries everything that depends only on a pixel's own colour (white balance, exposure, the tone controls, base and point curves, vibrance/saturation, HSL, colour grading, profile and look) and nothing that depends on a pixel's neighbours or its place in the frame. Texture, clarity, dehaze, sharpening, noise reduction, grain, starburst, trails, masks, retouch, crop and the double exposure cannot go in one — the app names the ones your photo was actually using rather than dropping them silently.
- **Lens Corrections**: distortion, vignetting and colour fringing from the bundled open [lensfun](https://lensfun.github.io) database, matched automatically from the camera and lens recorded in the file, plus manual sliders for lenses that are not in it.
- **Transform**: perspective correction (vertical and horizontal keystone), rotate, aspect, scale and shift.
- **Picture Profiles**: Standard, Neutral, Portrait, Landscape, Vivid, Flat and three monochrome looks. A profile only moves normal develop controls, so every result stays editable.
- **Colour-managed export**: every exported JPEG, PNG and TIFF carries an embedded sRGB profile. The preview canvas is colour managed by the webview, so an untagged file only matched the app in viewers that happened to assume sRGB; on a calibrated or wide-gamut display the same pixels looked noticeably more saturated outside the app. Tagging the file removes the guesswork and makes the export match what you edited.
- **Double Exposure**: composite a second photograph onto the one being edited. Drag a file onto the panel or choose one; any format the app opens works, RAW included. The default **Expose** mode is a true double exposure: the second picture is added as scene-referred light *before* the tone mapping, so where the two overlap the highlights roll off together exactly as they would on one negative. The familiar display-referred layer blends (Screen, Multiply, Lighten, Darken, Overlay, Soft light, Difference, Normal) are also there and run after the point curves and the look, so vibrance, HSL, colour grading and a monochrome profile still apply to both pictures at once. Opacity, brightness, fit, size, position, rotation, mirror and negative are all in the panel. The preview uses a downsampled copy; the export reads the original again at full resolution.
- **Object Remover**: heal and clone spots that copy real pixels from elsewhere in the same photograph, with an automatic patch search. Heal also matches the brightness and colour of the new surroundings. Patch-based, not generative.
- **Masks (local adjustments)**: linear and radial gradients, a brush, a luminance range, and an on-device **Subject** mask (a small salient-object model runs locally; nothing is uploaded and no pixels are generated). The model sees a 320-pixel copy of the photo, so its matte knows where the subject is but not exactly where it ends; a guided filter then pulls that matte onto the picture's own edges, so the boundary follows the shoulder of a jersey or the line of a helmet rather than a blurred guess at it. Each mask carries its own Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature, Tint, Saturation, Texture, Clarity and Dehaze, can be inverted, and shows as a red overlay (M). Masks are stored in the sidecar and applied identically on export.
- **Subtract from a mask**: **− Subtract** adds a second shape that cuts its area out of the mask above it rather than carrying adjustments of its own — "the person, but not their face". Any kind can subtract from any kind, several subtractions compose, soft edges stay soft, and Invert on a subtraction cuts everything *except* that shape. Subtractions sit indented under the mask they belong to, and the mask's own adjustments still apply everywhere else.
- **Film Grain**: Amount, Size and Color. The grain is a hash of each pixel's position rather than a random number, so it lands in exactly the same places in the preview and in the export, and it is measured against the picture rather than the pixel grid, so it stays the same size relative to the frame whether you are looking at a fitted preview or a full-resolution file. It is a gain, not an offset, so it moves brightness without tinting until the Color slider asks it to, and it is weighted towards the midtones and shadows the way film is. Judge it at 1:1.
- **Starburst (cross-screen filter)**: the glass filter photographers screw onto the lens to turn street lamps and specular highlights into stars. Points (4 to 12), Amount, Length, Angle, Threshold, Falloff and Dispersion. Only the highlights above the threshold are smeared, along one line of light per groove direction, and Dispersion spreads the ends of the streaks into colour the way real diffraction does. Nothing is generated: a frame with no highlights above the threshold comes out untouched.
- **Dehaze**: dark-channel haze removal (or added haze with negative values), globally and per mask.
- **White balance eyedropper**: click something neutral in the photo to set Temperature and Tint.
- **Auto noise reduction**: sets the noise sliders from the measured noise level, optionally for every new RAW file.
- **Crop guides**: Thirds, Grid, Golden Ratio, Golden Spiral, Golden Triangle and Diagonal (O cycles, Shift+O flips).
- **Filmstrip thumbnails** generate on their own in the background, three at a time, so a restored session, a browsed folder or a tethered burst fills in without clicking each frame. RAW files use the camera’s embedded preview, which is far quicker than demosaicing.
- **Tethered Capture**: Darkroom watches the folder your camera software saves into (EOS Utility, Imaging Edge Desktop, a camera Wi‑Fi/FTP push, or a card reader) and opens each shot as it finishes writing. USB and Wi‑Fi both work because the vendor app does the transfer. Tether → Tethered Capture → choose the folder → Start watching.
- **Phone Monitor**: the app serves a live page on the local network (QR code in Tether → Phone Monitor). The phone shows the developed picture as you edit it plus the recent filmstrip. Nothing leaves the LAN and nothing is uploaded.
- Motion Trails retain the legacy `mirror` sidecar key only for backwards compatibility with existing `.drk.json` edits.

## Phones

Darkroom also builds for Android and iPhone, with a phone layout that switches on for phone-sized screens. See `docs/mobile.md` for what differs on a phone and how to build each one (iPhone builds need the Mac).

## Development

```bash
bun install
bun run tauri dev
bun run tauri build
```

## Testing

```
bun run test                      # pipeline checks, unit tests, type check
bun run test -- --app photo.CR3   # also launches the app and runs the UI smoke test (Windows)
```

The pipeline checks (`src-tauri/src/checks.rs`) run the whole develop pipeline on synthetic images, so they need no photos and run in CI. They check that neutral settings change nothing, that a technical S-Log3 LUT fed through the S-Log3 input lands on the flat render, that retouch spots stay inside their circle, that presets never carry crop or masks, that a double exposure only ever adds light in Expose mode and stays inside its own frame when scaled down, that every export format carries the sRGB profile, and that old sidecars still open. The smoke test (`scripts/smoke.mjs`) drives the real window through every major tool on a temporary copy of the photo and fails on any error.

## Release notes

See `docs/windows-release.md` for the Windows installer validation path, `docs/product-audit.md` for the product/architecture roadmap, and `docs/color-science.md` for the color pipeline.
