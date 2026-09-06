# Darkroom

A standalone desktop RAW photo editor in the spirit of Lightroom / Luminar.

Darkroom uses Tauri 2, Rust for RAW decode/export, React/TypeScript for the desktop UI, and WebGL2 for real-time develop preview.

## Current product behavior

- **Motion Trails**: repeated semi-transparent directional echoes from the existing developed image. Controls: Amount, Direction, Distance, Copies, Fade, Blur, and Opacity.
- **Auto Edit**: a deterministic one-click recipe over normal develop controls such as contrast, highlights/shadows, vibrance/saturation, texture/clarity, denoise, and sharpening. Every result remains editable. It is not generative AI and never adds, removes, or replaces image content.
- Motion Trails remain serialized under the legacy `mirror` sidecar key for backwards compatibility with existing `.drk.json` edits.

## Development

```bash
bun install
bun run tauri dev
bun run tauri build
```

## Release notes

See `docs/windows-release.md` for the Windows installer validation path, `docs/product-audit.md` for the product/architecture roadmap, and `docs/color-science.md` for the color pipeline.
