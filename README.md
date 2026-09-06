# Darkroom

A standalone desktop RAW photo editor in the spirit of Lightroom / Luminar.
Tauri 2 shell, Rust core (decode + export), React/TypeScript UI, WebGL2 real-time develop pipeline.

## Product behavior

- **Motion Trails** creates repeated directional ghost echoes from the existing developed photo, with Amount, Direction, Distance, Copies, Fade, Blur, and Opacity controls.
- **Auto Edit** is a deterministic one-click recipe over normal develop sliders (contrast, highlights/shadows, vibrance/saturation, texture/clarity, denoise, sharpening). It is not generative AI and never adds, removes, or replaces image content.
- Motion Trails retain the legacy `mirror` sidecar key only for backwards compatibility with existing `.drk.json` edits.

See `docs/product-audit.md`, `docs/color-science.md`, and `docs/windows-release.md` for the detailed product, color, and release notes.
