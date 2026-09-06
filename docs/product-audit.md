# Darkroom product + architecture audit

## Product position

Darkroom should remain a standalone desktop RAW photo editor. It should not become a module inside another NVision application.

The strongest product direction is a focused develop environment: fast open, fast edit, clean visual hierarchy, non-destructive sidecars, distinctive practical effects, and high-quality export.

## Product boundaries

### Auto Edit

Auto Edit is a deterministic starting recipe over normal Darkroom controls (contrast, highlights/shadows, vibrance/saturation, texture/clarity, denoise, sharpening). Every adjustment remains editable. It does not generate, remove, replace, or invent image content.

### Motion Trails

Motion Trails creates repeated semi-transparent directional echoes from the existing developed image. Controls are Amount, Direction, Distance, Copies, Fade, Blur, and Opacity. It is not a mirror effect and it is not generative AI.

For sidecar compatibility, Motion Trails currently remain stored under the legacy `mirror` key in `.drk.json` files. A future sidecar schema can rename this with migration support.

## Priority workflow gaps

1. Folder library / browser with ratings, flags, labels, and filtering.
2. Undo / redo / history.
3. Copy / paste / sync edits.
4. Batch export.
5. User presets.
6. Lens, chromatic aberration, and geometry correction.
7. Dehaze and deterministic local-adjustment tools.
8. ICC-aware input/display and soft proofing.

## Architecture findings

- `App.tsx` still owns too many responsibilities. Split session, develop state, shortcuts, workspace shell, and inspector into separate modules.
- Rust currently stores one decoded image at a time. A small LRU document cache would improve multi-image workflows and background export later.
- CPU and WebGL scene/develop math need golden-image parity tests.
- Motion Trails preview and export are separate post-develop implementations and need visual parity tests.
- Sidecars next to source files are portable but brittle in read-only locations; optional app-managed storage would help.
- CSP is currently disabled and should be tightened before any remote account or service features.
- Professional color-management claims should wait for ICC-aware input/display and soft proofing.

## UI direction

- standalone Darkroom identity;
- left tool rail;
- large central canvas;
- bottom filmstrip;
- right inspector with persistent histogram;
- collapsible control groups;
- quieter top toolbar;
- visible Auto Edit convenience button;
- Motion Trails grouped under Effects;
- no generative-AI prompt or manipulation controls.

## Recommended next implementation sequence

1. Stabilize Windows installer behavior and add trusted Windows code signing before broad release.
2. Finish and merge the workspace cleanup after CI passes.
3. Add undo/redo and durable edit history.
4. Split `App.tsx` responsibilities.
5. Add copy/paste/sync edits.
6. Add folder library, ratings, flags, and filtering.
7. Add batch export and presets.
8. Add professional optical/color tools.
9. Add Motion Trails preview/export visual parity tests and scene/develop golden-image tests.

Darkroom does not need generative image manipulation to be differentiated. Its value can come from speed, clean workflow, strong RAW development, useful automation, and creative effects that remain under the photographer's control.
