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
- Motion Trails retain the legacy `mirror` sidecar key only for backwards compatibility with existing `.drk.json` edits.

## Development

```bash
bun install
bun run tauri dev
bun run tauri build
```

## Release notes

See `docs/windows-release.md` for the Windows installer validation path, `docs/product-audit.md` for the product/architecture roadmap, and `docs/color-science.md` for the color pipeline.
