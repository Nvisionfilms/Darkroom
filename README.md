# Darkroom

A desktop RAW photo editor in the spirit of Lightroom / Luminar.
Tauri 2 shell, Rust core (decode + export), React/TypeScript UI, WebGL2 real-time develop pipeline.

## Supported input

- **RAW:** Canon CR2/CR3/CRW, Sony ARW/SRF/SR2, Nikon NEF/NRW, Adobe DNG, Fuji RAF,
  Olympus ORF, Panasonic RW2, Pentax PEF, Phase One IIQ, Hasselblad 3FR and more (via `rawler`).
- **Bitmap:** JPEG, PNG, TIFF (8/16-bit). Embedded ICC profiles are ignored; input is assumed sRGB.

## Output

JPEG (quality 50–100), PNG and TIFF (8- or 16-bit), optional resize on the long edge.

## Edits (non-destructive)

Edits are stored in a sidecar `<image>.drk.json` next to the source and re-applied on reopen.

- Profile (Standard / Linear), Temperature, Tint
- Exposure, Contrast, Highlights, Shadows, Whites, Blacks
- Vibrance, Saturation
- Tone curve (RGB + per-channel, monotone cubic)
- HSL: hue / saturation / luminance for 8 colour bands
- Texture (mid-frequency structure) and Clarity (midtone local contrast), both signed
- Noise reduction: two-scale non-local means with separate luminance / colour strength and
  detail restoration; noise level estimated from the image
- Output sharpening
- Rotate 90° left / right
- Color grading: shadow / midtone / highlight tints with balance (split toning)
- Mirror power window: an ellipse you drag on the image whose content is reflected across its
  far edge into a tail that fades with distance (feather, gap, direction, length, opacity)
- Watermark: any PNG/JPEG placed anywhere on the photo, dragged to move, corner-dragged to
  resize, with opacity; baked into exports

Colour pipeline: linear DaVinci Wide Gamut working space, log-space tone controls, hue-preserving
gamut compression and a highlight shoulder on the way to sRGB. See
[docs/color-science.md](docs/color-science.md) for what was borrowed from Resolve.

## How it works

```
file ──► Rust: decode ► demosaic (PPG) ► WB + camera matrix ► linear DaVinci Wide Gamut f32
                │
                ├─► half-float preview (≤2560px) ──► WebGL2: denoise ► local-contrast maps ► develop ──► screen
                │
                └─► full-res CPU (rayon): denoise ► maps ► develop ► rotate ► resize ► sharpen ► JPEG/PNG/TIFF
```

`src-tauri/src/{pipeline,denoise,detail}.rs` and `src/gl/shaders.ts` are twins: the same math
runs on the CPU for export and on the GPU for preview. Keep them in sync.

## Development

```bash
bun install
bun run tauri dev        # dev build + live reload
bun run tauri build      # installer / bundle
```

Headless smoke test (decode + export without the UI):

```bash
cd src-tauri
cargo run --example develop -- "path/to/photo.CR3" out.jpg [edits.json] [max_long_edge]
```

Prerequisites: Rust (rustup), Bun, and on Windows the MSVC Build Tools + WebView2 (built into Windows 11).

## Releases and automatic updates

Installed apps check GitHub Releases at launch and offer to install newer versions.

```bash
bun run release 0.2.0     # or: bun run release patch|minor|major
```

That bumps the version in package.json, tauri.conf.json and Cargo.toml, commits, tags `v0.2.0`
and pushes. The `release` GitHub Action then builds macOS (Apple silicon + Intel) and Windows
installers, signs the update bundles and publishes the release with `latest.json`.

One-time setup: add the updater private key as the repository secret
`TAURI_SIGNING_PRIVATE_KEY` (and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, empty if none).
The public key lives in `tauri.conf.json`. Without an Apple Developer certificate the Mac build
is ad-hoc signed; add the `APPLE_*` secrets for a notarised build.

## Shortcuts

| Key | Action |
| --- | --- |
| Ctrl+O | Open images |
| Ctrl+E | Export |
| Ctrl+[ / Ctrl+] | Rotate left / right |
| `\` (hold) | Show the unedited original |
| Scroll | Zoom |
| Drag | Pan |
| Double-click | Toggle fit / 1:1 |
| Double-click a slider label | Reset that slider |

## Known limitations

- Samsung phone DNGs (linear 3-channel with a 12-bit white-level tag but 16-bit data) decode to a
  blank image in `rawler` 0.8 itself, so they render blank here too. Canon CR3, Sony ARW, and
  camera JPEG/TIFF are verified.
- 4-colour sensors (RGBE / CYGM) are rejected.
- Temperature/tint are RGB-gain approximations, not Kelvin-accurate.
- Input ICC profiles are ignored; the display is assumed to be sRGB.

## Debugging the live UI without a mouse

WebView2 exposes the DevTools protocol if you launch the app with a private profile:

```powershell
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=9222"
$env:WEBVIEW2_USER_DATA_FOLDER = "$env:TEMP\darkroom-wv2"
.\src-tauri\target\debug\darkroom.exe "C:\photos\IMG_0001.CR3"
```

Then `http://127.0.0.1:9222/json` lists the page and any CDP client can evaluate JS and capture
screenshots (needs `bun run dev` running for the dev build).

## Roadmap

- Crop / straighten
- S-Log2 / S-Log3 input transforms and `.cube` LUTs
- Lens corrections, noise reduction, clarity / dehaze
- Local adjustments (brush, gradient, luminosity masks) and ML masks
- Catalog: folder import, ratings, flags, filtering
- ICC-aware input and soft-proofing, Display P3 / Adobe RGB output
