import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { EditParams, ExportRequest, ImageInfo, PreviewImage } from "./types";

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

export async function startupFile(): Promise<string | null> {
  return invoke<string | null>("startup_file");
}

export async function supportedExtensions(): Promise<string[]> {
  return invoke<string[]>("supported_extensions");
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
