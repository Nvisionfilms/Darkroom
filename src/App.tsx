import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getPreview, openImage, pickImages, saveEdits, startupFile, supportedExtensions } from "./api";
import { CurveEditor } from "./components/CurveEditor";
import { ExportDialog } from "./components/ExportDialog";
import { Histogram } from "./components/Histogram";
import { GradingPanel } from "./components/GradingPanel";
import { HslPanel } from "./components/HslPanel";
import { MirrorPanel } from "./components/MirrorPanel";
import { Slider } from "./components/Slider";
import { UpdateBanner } from "./components/UpdateBanner";
import { Viewer } from "./components/Viewer";
import { WatermarkPanel } from "./components/WatermarkPanel";
import { buildLut } from "./curve";
import { defaultParams, type EditParams, type Histogram as Hist, type ImageInfo, type PreviewImage } from "./types";
import "./App.css";

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

function metaLine(info: ImageInfo): string {
  const m = info.metadata;
  const parts: string[] = [];
  if (m.camera) parts.push(m.camera);
  if (m.lens) parts.push(m.lens);
  const exp: string[] = [];
  if (m.focalLength) exp.push(`${Math.round(m.focalLength)}mm`);
  if (m.fNumber) exp.push(`f/${m.fNumber.toFixed(1).replace(/\.0$/, "")}`);
  if (m.exposureTime) exp.push(m.exposureTime);
  if (m.iso) exp.push(`ISO ${m.iso}`);
  if (exp.length) parts.push(exp.join("  "));
  parts.push(`${info.width} × ${info.height}`);
  return parts.join("   ·   ");
}

function placeholder(path: string): ImageInfo {
  return {
    path,
    width: 0,
    height: 0,
    previewWidth: 0,
    previewHeight: 0,
    noiseSigma: 0,
    metadata: { kind: "" },
    edits: null,
    thumbnail: "",
  };
}

export default function App() {
  const [extensions, setExtensions] = useState<string[]>([]);
  const [files, setFiles] = useState<ImageInfo[]>([]);
  const [current, setCurrent] = useState<ImageInfo | null>(null);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  const [params, setParams] = useState<EditParams>(defaultParams());
  const [before, setBefore] = useState(false);
  const [hist, setHist] = useState<Hist | null>(null);
  const [zoom, setZoom] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const saveTimer = useRef<number | null>(null);

  useEffect(() => {
    supportedExtensions()
      .then(setExtensions)
      .catch(() => setExtensions(["jpg", "jpeg", "png", "tif", "tiff", "dng", "cr2", "cr3", "arw", "nef", "raf"]));
  }, []);

  const lut = useMemo(() => buildLut(params.curves), [params.curves]);
  const defaults = useMemo(() => defaultParams(), []);
  const defaultLut = useMemo(() => buildLut(defaults.curves), [defaults]);
  const shownParams = before ? defaults : params;
  const shownLut = before ? defaultLut : lut;

  // autosave edits to the sidecar (debounced)
  useEffect(() => {
    if (!current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const path = current.path;
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      saveEdits(path, params).catch((e) => setError(`Could not save edits: ${String(e)}`));
    }, 400);
    return () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [params, current]);

  const load = useCallback(async (path: string) => {
    setLoading(fileName(path));
    setError(null);
    try {
      const t0 = performance.now();
      const info = await openImage(path);
      performance.measure("ipc.open_image", { start: t0 });
      const t1 = performance.now();
      const pv = await getPreview(info.previewWidth, info.previewHeight, info.noiseSigma);
      performance.measure("ipc.get_preview", { start: t1 });
      setCurrent(info);
      setPreview(pv);
      setParams(info.edits ?? defaultParams());
      setFiles((prev) => {
        const i = prev.findIndex((f) => f.path === info.path);
        if (i === -1) return [...prev, info];
        const next = [...prev];
        next[i] = info;
        return next;
      });
    } catch (e) {
      setError(`Could not open ${fileName(path)}: ${String(e)}`);
    } finally {
      setLoading(null);
    }
  }, []);

  const openFiles = useCallback(async () => {
    const paths = await pickImages(extensions.length ? extensions : ["*"]);
    if (!paths.length) return;
    setFiles((prev) => {
      const next = [...prev];
      for (const p of paths) if (!next.some((f) => f.path === p)) next.push(placeholder(p));
      return next;
    });
    await load(paths[0]);
  }, [extensions, load]);

  const reset = useCallback(() => setParams(defaultParams()), []);
  const rotate = useCallback(
    (deg: number) => setParams((p) => ({ ...p, rotation: (((p.rotation + deg) % 360) + 360) % 360 })),
    [],
  );

  // dev hook for automation: window.__darkroom.load(path)
  useEffect(() => {
    (window as unknown as { __darkroom?: unknown }).__darkroom = { load };
  }, [load]);

  // open a file passed on the command line (once; StrictMode runs effects twice in dev)
  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startupFile()
      .then((p) => {
        if (p) {
          setFiles((prev) => (prev.some((f) => f.path === p) ? prev : [...prev, placeholder(p)]));
          void load(p);
        }
      })
      .catch(() => {});
  }, [load]);

  // keyboard shortcuts
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "\\") {
        setBefore(true);
        e.preventDefault();
      } else if (e.ctrlKey && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openFiles();
      } else if (e.ctrlKey && e.key.toLowerCase() === "e" && current) {
        e.preventDefault();
        setShowExport(true);
      } else if (e.ctrlKey && e.key === "[" && current) {
        e.preventDefault();
        rotate(-90);
      } else if (e.ctrlKey && e.key === "]" && current) {
        e.preventDefault();
        rotate(90);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.key === "\\") setBefore(false);
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, [openFiles, current, rotate]);

  const set =
    <K extends keyof EditParams>(key: K) =>
    (v: EditParams[K]) =>
      setParams((p) => ({ ...p, [key]: v }));

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">Darkroom</span>
        <button onClick={openFiles}>Open…</button>
        <button onClick={() => setShowExport(true)} disabled={!current}>
          Export…
        </button>
        <button onClick={reset} disabled={!current}>
          Reset
        </button>
        <span className="sep" />
        <button onClick={() => rotate(-90)} disabled={!current} title="Rotate left (Ctrl+[)">
          ⟲ Rotate
        </button>
        <button onClick={() => rotate(90)} disabled={!current} title="Rotate right (Ctrl+])">
          ⟳ Rotate
        </button>
        <button
          className={before ? "active" : ""}
          onPointerDown={() => setBefore(true)}
          onPointerUp={() => setBefore(false)}
          onPointerLeave={() => setBefore(false)}
          disabled={!current}
          title="Hold to see the original (or hold \)"
        >
          Before
        </button>
        <span className="spacer" />
        {loading && <span className="status">Loading {loading}…</span>}
        {current && !loading && <span className="status meta">{metaLine(current)}</span>}
        <span className="status zoom">{zoom}</span>
      </header>

      <div className="main">
        <Viewer
          image={preview}
          params={shownParams}
          lut={shownLut}
          rotation={params.rotation}
          mirror={params.mirror}
          onMirrorChange={set("mirror")}
          watermark={params.watermark}
          onWatermarkChange={set("watermark")}
          onHistogram={setHist}
          onZoom={setZoom}
        />

        <aside className="panel">
          <section>
            <Histogram hist={hist} />
          </section>

          <section>
            <h3>Basic</h3>
            <label className="field">
              <span>Profile</span>
              <select
                value={params.baseContrast >= 0.5 ? "standard" : "linear"}
                onChange={(e) => set("baseContrast")(e.target.value === "standard" ? 1 : 0)}
              >
                <option value="standard">Standard</option>
                <option value="linear">Linear (flat)</option>
              </select>
            </label>
            <Slider
              label="Temperature"
              value={params.temperature}
              min={-100}
              max={100}
              track="linear-gradient(90deg,#3e7be8,#888 50%,#f5b12b)"
              onChange={set("temperature")}
            />
            <Slider
              label="Tint"
              value={params.tint}
              min={-100}
              max={100}
              track="linear-gradient(90deg,#46a758,#888 50%,#d6409f)"
              onChange={set("tint")}
            />
            <div className="divider" />
            <Slider label="Exposure" value={params.exposure} min={-5} max={5} step={0.05} onChange={set("exposure")} />
            <Slider label="Contrast" value={params.contrast} min={-100} max={100} onChange={set("contrast")} />
            <Slider label="Highlights" value={params.highlights} min={-100} max={100} onChange={set("highlights")} />
            <Slider label="Shadows" value={params.shadows} min={-100} max={100} onChange={set("shadows")} />
            <Slider label="Whites" value={params.whites} min={-100} max={100} onChange={set("whites")} />
            <Slider label="Blacks" value={params.blacks} min={-100} max={100} onChange={set("blacks")} />
            <div className="divider" />
            <Slider label="Vibrance" value={params.vibrance} min={-100} max={100} onChange={set("vibrance")} />
            <Slider label="Saturation" value={params.saturation} min={-100} max={100} onChange={set("saturation")} />
          </section>

          <section>
            <h3>Tone Curve</h3>
            <CurveEditor curves={params.curves} onChange={set("curves")} />
          </section>

          <section>
            <h3>Color (HSL)</h3>
            <HslPanel hsl={params.hsl} onChange={set("hsl")} />
          </section>

          <section>
            <h3>Color Grading</h3>
            <GradingPanel grading={params.grading} onChange={set("grading")} />
          </section>

          <section>
            <h3>
              Mirror Window
              <label className="h3-toggle">
                <input
                  type="checkbox"
                  checked={params.mirror.enabled}
                  onChange={(e) => set("mirror")({ ...params.mirror, enabled: e.target.checked })}
                />
                on
              </label>
            </h3>
            <MirrorPanel mirror={params.mirror} onChange={set("mirror")} />
          </section>

          <section>
            <h3>
              Watermark
              <label className="h3-toggle">
                <input
                  type="checkbox"
                  checked={params.watermark.enabled}
                  disabled={!params.watermark.path}
                  onChange={(e) => set("watermark")({ ...params.watermark, enabled: e.target.checked })}
                />
                on
              </label>
            </h3>
            <WatermarkPanel watermark={params.watermark} onChange={set("watermark")} onError={setError} />
          </section>

          <section>
            <h3>Detail</h3>
            <Slider label="Texture" value={params.texture} min={-100} max={100} onChange={set("texture")} />
            <Slider label="Clarity" value={params.clarity} min={-100} max={100} onChange={set("clarity")} />
            <Slider
              label="Sharpening"
              value={params.sharpen}
              min={0}
              max={150}
              defaultValue={25}
              onChange={set("sharpen")}
            />
          </section>

          <section>
            <h3>
              Noise Reduction
              {current && current.noiseSigma > 0 && (
                <span className="h3-note" title="Estimated sensor noise (sigma in the sqrt-luma domain)">
                  noise {(current.noiseSigma * 100).toFixed(2)}
                </span>
              )}
            </h3>
            <Slider label="Luminance" value={params.denoiseLuma} min={0} max={100} onChange={set("denoiseLuma")} />
            <Slider
              label="Color"
              value={params.denoiseChroma}
              min={0}
              max={100}
              defaultValue={25}
              onChange={set("denoiseChroma")}
            />
            <Slider
              label="Detail"
              value={params.denoiseDetail}
              min={0}
              max={100}
              defaultValue={50}
              onChange={set("denoiseDetail")}
            />
            <div className="hint">Preview is downsampled; judge noise at 1:1 (double-click) or in the export.</div>
          </section>
        </aside>
      </div>

      <footer className="filmstrip">
        {files.length === 0 && <span className="hint">Opened images appear here.</span>}
        {files.map((f) => (
          <button
            key={f.path}
            className={"thumb" + (current?.path === f.path ? " active" : "")}
            title={f.path}
            onClick={() => current?.path !== f.path && load(f.path)}
          >
            {f.thumbnail ? <img src={f.thumbnail} alt="" /> : <span className="thumb-placeholder">…</span>}
            <span className="thumb-name">{fileName(f.path)}</span>
          </button>
        ))}
      </footer>

      <UpdateBanner />
      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {showExport && current && <ExportDialog image={current} params={params} onClose={() => setShowExport(false)} />}
    </div>
  );
}
