# Darkroom product + architecture audit

## Product position

Darkroom should remain a standalone desktop RAW photo editor. It does not need to become a module inside another NVision application. The strongest product direction is a focused develop environment: fast open, fast edit, clean visual hierarchy, non-destructive sidecars, and high-quality export.

## What is already strong

- Native desktop shell with Tauri 2.
- Rust RAW decode and full-resolution export.
- WebGL2 real-time preview.
- Non-destructive sidecar edits.
- DaVinci Wide Gamut working pipeline.
- Curves, HSL, color grading, texture/clarity, denoise, crop/straighten, mirror window, watermark, and sharpening.
- Session restore and updater support.
- CPU export and GPU preview are intentionally designed to match.

## Current product gaps, in priority order

### P0 — daily workflow

1. **Library / folder browser**
   - Folder import without copying files.
   - Grid + filmstrip views.
   - Ratings, flags, color labels.
   - Filter by rating, flag, file type, camera, date.

2. **Copy / paste / sync edits**
   - Copy the current develop settings.
   - Paste to selected photos.
   - Sync only chosen groups such as tone, color, crop, detail.

3. **Presets**
   - User presets.
   - Import/export preset files.
   - Preview preset on hover later.

4. **Batch export**
   - Export selected photos.
   - Filename templates.
   - Resize, quality, format, watermark, destination.

5. **History / snapshots**
   - Undo/redo that survives more than one slider action.
   - Named snapshots or virtual copies.

### P1 — professional develop tools

- Lens distortion and vignetting correction.
- Chromatic aberration / defringe.
- Geometry / perspective correction.
- Linear gradient, radial gradient, brush masks.
- Luminance and color-range masks.
- Heal / clone / remove tool.
- Dehaze.
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

## AI roadmap

AI should reduce repetitive work, not replace the develop engine.

### AI Phase 1 — useful and local-first

- **Auto Develop:** recommend exposure, white balance, highlights/shadows and contrast while keeping every adjustment editable.
- **Subject / sky / background masks:** generate masks, then feed them into normal local-adjustment controls.
- **Smart culling:** score focus, closed eyes, duplicate frames and obvious misses.
- **Noise model recommendation:** estimate an appropriate denoise starting point from ISO / sensor noise.

### AI Phase 2 — creative acceleration

- **Edit by description:** translate instructions such as “cool the shadows, protect skin, bring the sky down half a stop” into normal Darkroom parameters and masks.
- **Style match:** analyze a reference image and propose a non-destructive grade rather than baking a generated look into pixels.
- **Relight / depth-aware dodge and burn:** use segmentation/depth to generate editable masks.

### AI Phase 3 — generative tools

- Object removal / generative fill.
- Generative expand after crop.
- Background replacement.

Generative features should be clearly separated from normal RAW development because they alter image content rather than only develop it.

## Architecture findings

### 1. App.tsx owns too many responsibilities

The current React root coordinates file open, session restore, autosave, keyboard shortcuts, editor state, updater state, toolbar, viewer, inspector, and filmstrip. This makes UI changes riskier than they need to be.

Recommended split:

- `usePhotoSession()` — open files, current image, session restore.
- `useDevelopState()` — edit params, reset, autosave, undo/redo.
- `useDarkroomShortcuts()` — platform-aware shortcuts.
- `WorkspaceShell` — top bar, rail, filmstrip.
- `DevelopInspector` — controls only.

This PR starts the UI separation by extracting a reusable inspector accordion without changing the image-processing contract.

### 2. Rust stores one decoded document at a time

`AppState.loaded` holds one image. The React UI can show many open files, but switching images replaces the Rust-side decoded image. That is simple and memory-efficient, but it limits prefetching, background exports and fast multi-select workflows.

Recommended evolution: a small LRU document cache keyed by canonical file path, with an explicit document id passed to preview/export commands.

### 3. CPU and GPU develop code are twins

The same math exists in Rust and WebGL shaders. This is good for output parity but creates a drift risk.

Add golden-image tests that render a fixed input through both pipelines and compare within a small tolerance. Also centralize constants / transfer-function parameters where practical.

### 4. Sidecars beside source files are convenient but brittle

Writing `<image>.drk.json` next to the source can fail in read-only folders and can clutter delivered/client folders.

Recommended option:

- default: sidecar next to image for portability;
- optional: app-managed catalog storage for read-only or managed workflows.

### 5. CSP is disabled

`csp: null` is acceptable for an early local prototype but should be tightened before adding cloud AI, auth, external content, or remote APIs.

### 6. Color management needs a product boundary

The current pipeline assumes sRGB for bitmap input and display. Before marketing Darkroom as a professional color-managed replacement, ICC input/display and soft proofing need to be completed.

## UI direction in this PR

The new workspace follows the approved concept:

- standalone Darkroom identity;
- left tool rail;
- large central canvas;
- bottom filmstrip;
- right inspector with a persistent histogram;
- collapsed develop groups so only the controls needed now are visible;
- quieter top toolbar with the current file centered;
- no fake catalog, star-rating, AI or preset functionality added before the underlying behavior exists.

## Recommended next implementation sequence

1. Stabilize Windows installer + code signing.
2. Merge the workspace cleanup after CI passes.
3. Extract photo-session and develop-state hooks.
4. Add undo/redo + copy/paste/sync edits.
5. Add folder library, ratings and filtering.
6. Add batch export and presets.
7. Add local masks.
8. Add AI masking / auto develop only after the normal masking and parameter systems are stable.
