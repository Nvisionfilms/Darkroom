import { useState } from "react";
import { exportImage, pickSavePath } from "../api";
import { buildLut } from "../curve";
import type { EditParams, ExportFormat, ImageInfo } from "../types";

interface Props {
  image: ImageInfo;
  params: EditParams;
  onClose: () => void;
}

function stripExt(path: string): string {
  const i = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > slash ? path.slice(0, i) : path;
}

export function ExportDialog({ image, params, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>("jpeg");
  const [quality, setQuality] = useState(92);
  const [bitDepth, setBitDepth] = useState<8 | 16>(16);
  const [resize, setResize] = useState(false);
  const [longEdge, setLongEdge] = useState(2048);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const ext = format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : "png";

  const run = async () => {
    setMessage(null);
    const out = await pickSavePath(`${stripExt(image.path)}-edit.${ext}`, ext);
    if (!out) return;
    setBusy(true);
    try {
      const lut = Array.from(buildLut(params.curves));
      const written = await exportImage({
        outPath: out,
        format,
        quality,
        bitDepth: format === "jpeg" ? 8 : bitDepth,
        maxLongEdge: resize ? longEdge : null,
        params,
        lut,
      });
      setMessage(`Saved ${written}`);
    } catch (e) {
      setMessage(`Export failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Export</h2>
        <label className="field">
          <span>Format</span>
          <select value={format} onChange={(e) => setFormat(e.target.value as ExportFormat)}>
            <option value="jpeg">JPEG</option>
            <option value="png">PNG</option>
            <option value="tiff">TIFF</option>
          </select>
        </label>
        {format === "jpeg" ? (
          <label className="field">
            <span>Quality</span>
            <input type="range" min={50} max={100} value={quality} onChange={(e) => setQuality(+e.target.value)} />
            <b>{quality}</b>
          </label>
        ) : (
          <label className="field">
            <span>Bit depth</span>
            <select value={bitDepth} onChange={(e) => setBitDepth(+e.target.value as 8 | 16)}>
              <option value={8}>8-bit</option>
              <option value={16}>16-bit</option>
            </select>
          </label>
        )}
        <label className="field">
          <span>Resize</span>
          <input type="checkbox" checked={resize} onChange={(e) => setResize(e.target.checked)} />
          <input
            type="number"
            min={64}
            max={20000}
            value={longEdge}
            disabled={!resize}
            onChange={(e) => setLongEdge(+e.target.value)}
          />
          <em>px long edge</em>
        </label>
        <div className="field">
          <span>Source</span>
          <em>
            {image.width} × {image.height}
          </em>
        </div>
        {message && <div className="export-msg">{message}</div>}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
          <button className="primary" onClick={run} disabled={busy}>
            {busy ? "Exporting…" : "Export…"}
          </button>
        </div>
      </div>
    </div>
  );
}
