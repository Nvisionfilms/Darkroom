# Darkroom product + architecture audit

## Product position

Darkroom should remain a standalone desktop RAW photo editor. It should not become a module inside another NVision application.

The strongest product direction is a focused develop environment: fast open, fast edit, clean visual hierarchy, non-destructive sidecars, distinctive practical effects, and high-quality export.

## What is already strong

- Native desktop shell with Tauri 2.
- Rust RAW decode and full-resolution export.
- WebGL2 real-time develop pipeline.
- Non-destructive sidecar edits.
- DaVinci Wide Gamut working pipeline.
- Curves, HSL, color grading, texture/clarity, denoise, crop/straighten, watermark, and sharpening.
- Session restore and updater support.
- The scene/develop CPU and GPU paths are intentionally designed to match.
- Motion Trails now provide a distinctive post-develop effect based entirely on the existing image.
- Auto Edit provides a fast one-click starting point without introducing generative image manipulation.

## Product boundaries

### Auto Edit is not generative AI

The Auto Edit button is intentionally simple. It applies a deterministic starting recipe to normal Darkroom controls such as:

- contrast;
- highlights and shadows;
- vibrance and saturation;
- texture and clarity;
- luminance/chroma noise reduction;
- sharpening.

Auto Edit must remain fully editable after it runs. It does not generate pixels, replace objects, alter faces, remove backgrounds, create masks, or interpret text prompts.

The product can market this as a fast automatic enhancement feature, but the implementation should stay transparent: it is a convenience layer over existing controls.

### Motion Trails is an image effect, not a mirror tool

The old Mirror Window concept did not match the intended creative effect. Darkroom now treats that feature as **Motion Trails**.

Motion Trails creates repeated, semi-transparent directional echoes from the already-developed image. User-facing controls are:

- Amount
- Direction
- Distance
- Copies
- Fade
- Blur
- Opacity

The effect is deterministic and uses only pixels already present in the photo. It does not hallucinate or synthesize new subject content.

The current preview disables the old mirror shader and composites directional copies of the finished viewer canvas. Full-resolution export applies a CPU Motion Trails pass after normal develop/sharpen processing. Both paths use the same user-facing parameters and the same repeated-echo model.

For backward compatibility, the current `.drk.json` wire format still stores Motion Trails under the legacy `mirror` key. This should remain an implementation detail; the UI and documentation should call the feature Motion Trails.

## Current product gaps, in priority order

### P0 — daily workflow

1. **Library / folder browser**
   - Folder import without copying files.
   - Grid + filmstrip views.
   - Ratings, flags, color labels.
   - Filter by rating, flag, file type, camera, and date.

2. **Undo / redo / history**
   - Reliable multi-step undo/redo across sliders and tools.
   - Named snapshots or virtual copies later.

3. **Copy / paste / sync edits**
   - Copy current develop settings.
   - Paste to selected photos.
   - Sync only chosen groups such as tone, color, crop, detail, or effects.

4. **Batch export**
   - Export selected photos.
   - Filename templates.
   - Resize, quality, format, watermark, destination.

5. **Presets**
   - User presets.
   - Import/export preset files.
   - Preview preset on hover later.

### P1 — professional develop tools

- Lens distortion and vignetting correction.
- Chromatic aberration / defringe.
- Geometry / perspective correction.
- Dehaze.
- Linear gradient, radial gradient, and brush local adjustments.
- Luminance and color-range masks implemented as normal editing tools.
- Heal / clone / remove tool based on explicit user sampling or deterministic image processing.
- Better camera profiles and Kelvin-aware white balance.
- ICC-aware input and display output.
- Soft proofing and wider-gamut export.

### P2 — higher-end workflow

- Compare / survey view.
- Stacking and burst grouping.
- Metadata editor and copyright templates.
- Search by EXIF / filename / date.
- Tethered capture.
- External editor handoff.

## Architecture findings

### 1. App.tsx owns too many responsibilities

The React root still coordinates file open, session restore, autosave, keyboard shortcuts, editor state, updater state, toolbar, viewer, inspector, and filmstrip.

Recommended split:

- `usePhotoSession()` — open files, current image, session restore.
- `useDevelopState()` — edit params, reset, autosave, undo/redo.
- `useDarkroomShortcuts()` — platform-aware shortcuts.
- `WorkspaceShell` — top bar, rail, filmstrip.
- `DevelopInspector` — controls only.

The current workspace branch starts this cleanup by extracting reusable inspector sections and separating the Viewer wrapper from the existing core renderer.

### 2. Rust stores one decoded document at a time

`AppState.loaded` currently holds one image. The React UI can show many open files, but switching images replaces the Rust-side decoded image.

That is simple and memory-efficient, but it limits prefetching, background exports, and fast multi-select workflows.

Recommended evolution: a small LRU document cache keyed by canonical file path, with an explicit document id passed to preview/export commands.

### 3. Scene/develop CPU and GPU code are twins

The same develop math exists in Rust and WebGL shaders. This supports preview/export parity but creates drift risk.

Add golden-image tests that render a fixed input through both paths and compare within a small tolerance. Centralize shared constants and transfer-function parameters where practical.

Motion Trails is intentionally a separate post-develop stage. Preview currently composites repeated frames on a canvas while export performs a deterministic CPU equivalent. Those paths should receive their own visual parity tests before the effect is considered final.

### 4. Legacy `mirror` storage is technical debt

Motion Trails currently reuse the old `mirror` sidecar object so existing `.drk.json` files do not break.

This is acceptable during the transition, but a future sidecar schema version should introduce a properly named `motionTrails` object plus a migration path from old sidecars.

Do not silently break existing edits just to rename the field.

### 5. Sidecars beside source files are convenient but brittle

Writing `<image>.drk.json` next to the source can fail in read-only folders and can clutter delivered/client folders.

Recommended options:

- default: sidecar next to image for portability;
- optional: app-managed catalog storage for read-only or managed workflows.

### 6. CSP is disabled

`csp: null` is acceptable for an early local prototype but should be tightened before adding any remote account, cloud, or external-service features.

### 7. Color management needs a clear product boundary

The current pipeline assumes sRGB for bitmap input and display. Before marketing Darkroom as a fully color-managed professional replacement, ICC input/display and soft proofing need to be completed.

## UI direction

The workspace direction is:

- standalone Darkroom identity;
- left tool rail;
- large central canvas;
- bottom filmstrip;
- right inspector with a persistent histogram;
- collapsed editing groups so only current controls are visible;
- quieter top toolbar with current file context;
- visible Auto Edit button as a convenience feature;
- Motion Trails grouped under Effects;
- no fake generative-AI controls or prompt UI.

## Recommended next implementation sequence

1. Stabilize Windows installer behavior and add trusted Windows code signing before broad public release.
2. Finish and merge the workspace cleanup after CI passes.
3. Add undo/redo and a durable edit history.
4. Extract photo-session and develop-state hooks from `App.tsx`.
5. Add copy/paste/sync edits.
6. Add folder library, ratings, flags, and filtering.
7. Add batch export.
8. Add user presets.
9. Add lens/geometry corrections and dehaze.
10. Add local adjustment tools.
11. Add CPU/preview visual parity tests for Motion Trails and golden-image tests for the develop pipeline.

Darkroom does not need generative image manipulation to be useful or differentiated. Its competitive value can come from speed, clean workflow, strong color/develop tools, practical automation, and creative effects that remain under the photographer's control.
