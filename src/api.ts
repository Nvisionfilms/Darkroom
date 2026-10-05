import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  EditParams,
  Preset,
  ExportRequest,
  ToneMatch,
  ImageInfo,
  MonitorInfo,
  MonitorShot,
  PreviewImage,
  TetherStatus,
  WatermarkInfo,
} from "./types";

// ---- tethered capture ----

export async function pickFolder(title = "Choose the folder your camera software saves into"): Promise<string | null> {
  const result = await open({ multiple: false, directory: true, title });
  if (!result) return null;
  return Array.isArray(result) ? result[0] : result;
}

export async function startTether(folder: string): Promise<TetherStatus> {
  return invoke<TetherStatus>("start_tether", { folder });
}

export async function stopTether(): Promise<TetherStatus> {
  return invoke<TetherStatus>("stop_tether");
}

export async function tetherStatus(): Promise<TetherStatus> {
  return invoke<TetherStatus>("tether_status");
}

// ---- phone monitor ----

export async function startMonitor(): Promise<MonitorInfo> {
  return invoke<MonitorInfo>("start_monitor");
}

export async function stopMonitor(): Promise<MonitorInfo> {
  return invoke<MonitorInfo>("stop_monitor");
}

export async function monitorStatus(): Promise<MonitorInfo> {
  return invoke<MonitorInfo>("monitor_status");
}

export async function publishShot(shot: MonitorShot): Promise<number> {
  return invoke<number>("publish_shot", { shot });
}

/** JPEG bytes travel as the raw request body, not as JSON. */
export async function publishFrame(jpeg: Uint8Array): Promise<number> {
  return invoke<number>("publish_frame", jpeg);
}

/**
 * A path the decoder can open for whatever the file picker returned. On the
 * desktop that is the path itself; on Android the picker returns content://
 * handles, which are copied into the app's own storage first.
 */
export interface LibraryImport {
  session: string;
  files: string[];
}

/** Copy photos into a new session folder inside the library folder. */
export async function importToLibrary(library: string, session: string, paths: string[]): Promise<LibraryImport> {
  return invoke<LibraryImport>("import_to_library", { library, session, paths });
}

export interface LibrarySession {
  name: string;
  path: string;
  count: number;
}

export async function listSessions(library: string): Promise<LibrarySession[]> {
  return invoke<LibrarySession[]>("list_sessions", { library });
}

export async function listSessionPhotos(path: string): Promise<string[]> {
  return invoke<string[]>("list_session_photos", { path });
}

export async function importPhoto(uri: string, ext?: string): Promise<string> {
  return invoke<string>("import_photo", { uri, ext: ext ?? null });
}

export async function openImage(path: string): Promise<ImageInfo> {
  return invoke<ImageInfo>("open_image", { path });
}

export async function getPreview(width: number, height: number, noiseSigma: number, noiseShadow = 0): Promise<PreviewImage> {
  const buf = await invoke<ArrayBuffer>("get_preview");
  // `data` is deliberately non-enumerable: React's dev-mode performance
  // tracking serialises component props, and walking a multi-million-element
  // typed array froze the UI for seconds on every load.
  const img = { width, height, noiseSigma, noiseShadow } as PreviewImage;
  Object.defineProperty(img, "data", { value: new Uint16Array(buf), enumerable: false, writable: false });
  return img;
}

/**
 * A filmstrip thumbnail for a file that has not been opened yet. RAW files
 * use the camera's own embedded preview, so this is quick enough to run over
 * a whole folder.
 */
export async function getThumbnail(path: string): Promise<string> {
  return invoke<string>("get_thumbnail", { path });
}

export async function saveEdits(path: string, edits: EditParams): Promise<void> {
  await invoke("save_edits", { path, edits });
}

export async function exportImage(req: ExportRequest): Promise<string> {
  return invoke<string>("export_image", { req });
}

/**
 * Write the current look as a .cube 3D LUT. Returns the names of the settings a
 * LUT cannot carry that this photo was actually using, so the caller can say so.
 */
export async function exportCube(outPath: string, params: EditParams, lut: number[], size: number, title: string): Promise<string[]> {
  return invoke<string[]>("export_cube", { outPath, params, lut, size, title });
}

/** Export a photo other than the one open in the viewer (batch export). */
export async function exportPath(path: string, req: ExportRequest): Promise<string> {
  return invoke<string>("export_path", { path, req });
}

/**
 * The release a phone could install, or null where the app updates itself.
 * Read by Rust: a fetch from the page would be cross-origin and refused.
 */
export async function mobileUpdate(): Promise<unknown | null> {
  return invoke<unknown | null>("mobile_update");
}

/** The edits saved beside a photo, without decoding the photo. */
export async function readEdits(path: string): Promise<EditParams | null> {
  return invoke<EditParams | null>("read_edits", { path });
}

/** Which of these photos are flagged for export. */
export async function markedPhotos(paths: string[]): Promise<string[]> {
  return invoke<string[]>("marked_photos", { paths });
}

/** Apply a preset to several photos at once; returns how many were written. */
export async function applyEdits(paths: string[], settings: unknown): Promise<number> {
  return invoke<number>("apply_edits", { paths, settings });
}

/** Decode a watermark image on the Rust side; returns its size. */
export async function openWatermark(path: string): Promise<WatermarkInfo> {
  return invoke<WatermarkInfo>("open_watermark", { path });
}

/** RGBA8 pixels of the watermark loaded with openWatermark. */
export async function getWatermarkPixels(): Promise<Uint8Array> {
  const buf = await invoke<ArrayBuffer>("get_watermark_pixels");
  return new Uint8Array(buf);
}

/** Parse a .cube file on the Rust side; returns its name and lattice size. */
export async function openLook(path: string): Promise<{ path: string; name: string; size: number }> {
  return invoke<{ path: string; name: string; size: number }>("open_look", { path });
}

/** The loaded look as RGBA half floats for a WebGL2 3D texture. */
export async function getLookPixels(): Promise<Uint16Array> {
  const buf = await invoke<ArrayBuffer>("get_look_pixels");
  return new Uint16Array(buf);
}

/**
 * Decode the second picture of a double exposure on the Rust side; returns
 * its name and the size of the preview copy.
 */
export async function openBlend(path: string): Promise<{ path: string; name: string; width: number; height: number }> {
  return invoke<{ path: string; name: string; width: number; height: number }>("open_blend", { path });
}

/** The loaded second picture as linear RGB half floats, as getPreview gives. */
export async function getBlendPixels(): Promise<Uint16Array> {
  const buf = await invoke<ArrayBuffer>("get_blend_pixels");
  return new Uint16Array(buf);
}

/** One photo, for the double exposure. */
export async function pickPhoto(extensions: string[], startIn?: string | null): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    title: "Choose the second photo",
    defaultPath: startIn || undefined,
    filters: [
      { name: "Images", extensions },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!result) return null;
  return Array.isArray(result) ? result[0] : result;
}

export async function pickCube(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    title: "Choose a .cube look-up table",
    filters: [{ name: "Cube LUT", extensions: ["cube", "CUBE"] }],
  });
  if (!result) return null;
  return Array.isArray(result) ? result[0] : result;
}

// ---- develop presets ----

export async function listPresets(): Promise<Preset[]> {
  return invoke<Preset[]>("list_presets");
}

export async function savePreset(name: string, settings: unknown): Promise<Preset> {
  return invoke<Preset>("save_preset", { name, settings });
}

export async function deletePreset(name: string): Promise<void> {
  await invoke("delete_preset", { name });
}

/**
 * Find the sliders that make the open photo look like a reference picture. The
 * answer is nine ordinary slider values, so it stays editable and undoable.
 */
export async function matchTone(path: string, params: EditParams, lut: number[]): Promise<ToneMatch> {
  return invoke<ToneMatch>("match_tone", { path, params, lut });
}

/** How to look after the open photo, worked out from the photo itself. */
export async function autoLook(params: EditParams, lut: number[]): Promise<ToneMatch> {
  return invoke<ToneMatch>("auto_look", { params, lut });
}

/** A watermark saved in the library. */
export interface WatermarkMark {
  name: string;
  path: string;
}

export async function watermarkLibrary(): Promise<WatermarkMark[]> {
  return invoke<WatermarkMark[]>("watermark_library");
}

/** Copy an image into the library. A copy, so it outlives the original. */
export async function watermarkSave(path: string, name?: string): Promise<WatermarkMark> {
  return invoke<WatermarkMark>("watermark_save", { path, name: name ?? null });
}

export async function watermarkDelete(name: string): Promise<void> {
  return invoke<void>("watermark_delete", { name });
}

export async function pickWatermark(): Promise<string | null> {
  const result = await open({
    multiple: false,
    directory: false,
    filters: [{ name: "Watermark image", extensions: ["png", "jpg", "jpeg", "webp", "tif", "tiff"] }],
  });
  if (!result) return null;
  return Array.isArray(result) ? result[0] : result;
}

export interface Session {
  files: string[];
  current: string | null;
}

export async function loadSession(): Promise<Session> {
  return invoke<Session>("load_session");
}

export async function saveSession(session: Session): Promise<void> {
  await invoke("save_session", { session });
}

export async function startupFile(): Promise<string | null> {
  return invoke<string | null>("startup_file");
}

export interface PlatformInfo {
  os: string;
  /** false on phones, which cannot update themselves */
  updates: boolean;
}

export async function platform(): Promise<PlatformInfo> {
  return invoke<PlatformInfo>("platform");
}

export async function supportedExtensions(): Promise<string[]> {
  return invoke<string[]>("supported_extensions");
}

/**
 * Pick a source patch for an object-remover spot. `avoid` lists the other
 * spots as [x, y, radius] so sources are not taken from them.
 */
export async function findHealSource(
  x: number,
  y: number,
  radius: number,
  avoid: [number, number, number][],
): Promise<[number, number]> {
  return invoke<[number, number]>("find_heal_source", { x, y, radius, avoid });
}

/** `startIn` is the user's photos folder, when they have set one. */
export async function pickImages(extensions: string[], startIn?: string | null): Promise<string[]> {
  const result = await open({
    multiple: true,
    directory: false,
    defaultPath: startIn || undefined,
    filters: [
      { name: "Images", extensions },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (!result) return [];
  return Array.isArray(result) ? result : [result];
}

export async function pickSavePath(defaultPath: string, ext: string): Promise<string | null> {
  return save({
    defaultPath,
    filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
  });
}
