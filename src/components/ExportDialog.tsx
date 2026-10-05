import { useEffect, useState } from "react";
import { exportImage, exportPath, pickFolder, pickSavePath, readEdits, watermarkLibrary, type WatermarkMark } from "../api";
import { withMark, type MarkChoice } from "../exportMark";
import { buildLut } from "../curve";
import { defaultParams, type EditParams, type ExportFormat, type ImageInfo } from "../types";

interface Props {
  image: ImageInfo;
  params: EditParams;
  /**
   * Export these photos instead of the open one, each with the edits saved
   * beside it. The open photo's settings are not used.
   */
  batch?: string[] | null;
  onClose: () => void;
}

function stripExt(path: string): string {
  const i = path.lastIndexOf(".");
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i > slash ? path.slice(0, i) : path;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export function ExportDialog({ image, params, batch, onClose }: Props) {
  const [format, setFormat] = useState<ExportFormat>("jpeg");
  const [quality, setQuality] = useState(92);
  const [bitDepth, setBitDepth] = useState<8 | 16>(16);
  const [resize, setResize] = useState(false);
  const [longEdge, setLongEdge] = useState(2048);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // "photo" keeps each photo's own saved watermark, which for a batch is usually
  // none; choosing a mark here puts it on all of them
  const [mark, setMark] = useState<MarkChoice>("photo");
  const [marks, setMarks] = useState<WatermarkMark[]>([]);
  useEffect(() => {
    watermarkLibrary().then(setMarks).catch(() => {});
  }, []);

  const ext = format === "jpeg" ? "jpg" : format === "tiff" ? "tif" : "png";

  const settings = {
    format,
    quality,
    bitDepth: (format === "jpeg" ? 8 : bitDepth) as 8 | 16,
    maxLongEdge: resize ? longEdge : null,
  };

  const runOne = async () => {
    const out = await pickSavePath(`${stripExt(image.path)}-edit.${ext}`, ext);
    if (!out) return;
    setBusy(true);
    try {
      const written = await exportImage({
        outPath: out,
        ...settings,
        params: withMark(params, mark, params.watermark),
        lut: Array.from(buildLut(params.curves)),
      });
      setMessage(`Saved ${written}`);
    } catch (e) {
      setMessage(`Export failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  // Each photo is exported with its own saved edits, one at a time: a RAW
  // takes hundreds of megabytes to develop, so running a folder of them at
  // once would be a good way to run out of memory.
  const runBatch = async (paths: string[]) => {
    const dir = await pickFolder("Choose where to save the exported photos");
    if (!dir) return;
    setBusy(true);
    const failed: string[] = [];
    let done = 0;
    for (const path of paths) {
      setMessage(`Exporting ${done + 1} of ${paths.length}: ${fileName(path)}…`);
      try {
        // Each photo keeps its own edits; the watermark is the one thing chosen
        // here, placed like the open photo's and measured against each photo's
        // own cropped frame
        const edits = withMark((await readEdits(path)) ?? defaultParams(), mark, params.watermark);
        const name = fileName(stripExt(path));
        await exportPath(path, {
          outPath: `${dir}/${name}-edit.${ext}`,
          ...settings,
          params: edits,
          lut: Array.from(buildLut(edits.curves)),
        });
        done += 1;
      } catch (e) {
        failed.push(`${fileName(path)}: ${String(e)}`);
      }
    }
    setBusy(false);
    setMessage(
      failed.length
        ? `Exported ${done} of ${paths.length} to ${dir}. Failed: ${failed.join("; ")}`
        : `Exported ${done} photo${done === 1 ? "" : "s"} to ${dir}`,
    );
  };

  const run = async () => {
    setMessage(null);
    if (batch && batch.length) await runBatch(batch);
    else await runOne();
  };

  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>{batch && batch.length ? `Export ${batch.length} photos` : "Export"}</h2>
        {batch && batch.length > 0 && (
          <div className="hint">
            Each photo is exported with its own saved edits, into a folder you choose.
          </div>
        )}
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
        <label className="field">
          <span>Watermark</span>
          <select value={mark} onChange={(e) => setMark(e.target.value)}>
            <option value="photo">As set on each photo</option>
            <option value="none">None</option>
            {marks.map((m) => (
              <option key={m.path} value={m.path}>
                {m.name} on every photo
              </option>
            ))}
          </select>
        </label>
        {mark !== "photo" && mark !== "none" && (
          <div className="hint">
            Placed and sized like the one on the photo you have open, so put it where you want it first. A corner stays
            a corner on photos of every shape and crop.
          </div>
        )}
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
