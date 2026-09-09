import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type {
  EditParams,
  Preset,
  ExportRequest,
  ImageInfo,
  MonitorInfo,
  MonitorShot,
  PreviewImage,
  TetherStatus,
  WatermarkInfo,
} from "./types";

// ---- tethered capture ----

export async function pickFolder(): Promise<string | null> {
  const result = await open({ multiple: false, directory: true, title: "Choose the folder your camera software saves into" });
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

export async function openImage(path: string): Promise<ImageInfo> {
  return invoke<ImageInfo>("open_image", { path });
}

export async function getPreview(width: number, height: number, noiseSigma: number): Promise<PreviewImage> {
  const buf = await invoke<ArrayBuffer>("get_preview");
  // `data` is deliberately non-enumerable: React's dev-mode performance
  // tracking serialises component props, and walking a multi-million-element
  // typed array froze the UI for seconds on every load.
  const img = { width, height, noiseSigma } as PreviewImage;
  Object.defineProperty(img, "data", { value: new Uint16Array(buf), enumerable: false, writable: false });
  return img;
}

export async function saveEdits(path: string, edits: EditParams): Promise<void> {
  await invoke("save_edits", { path, edits });
}

export async function exportImage(req: ExportRequest): Promise<string> {
  return invoke<string>("export_image", { req });
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

export async function pickImages(extensions: string[]): Promise<string[]> {
  const result = await open({
    multiple: true,
    directory: false,
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
