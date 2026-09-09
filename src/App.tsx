import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  getPreview,
  loadSession,
  monitorStatus,
  openImage,
  pickFolder,
  pickImages,
  publishFrame,
  publishShot,
  saveEdits,
  saveSession,
  startMonitor,
  startTether,
  deletePreset,
  findHealSource,
  listPresets,
  openLook,
  pickCube,
  savePreset,
  startupFile,
  stopMonitor,
  stopTether,
  supportedExtensions,
  tetherStatus,
} from "./api";
import { MonitorPanel } from "./components/MonitorPanel";
import { TetherPanel } from "./components/TetherPanel";
import { MaskPanel } from "./components/MaskPanel";
import { HealPanel } from "./components/HealPanel";
import { LensPanel } from "./components/LensPanel";
import { TransformPanel } from "./components/TransformPanel";
import { PROFILES } from "./profiles";
import { LookRow } from "./components/LookRow";
import { PresetPanel } from "./components/PresetPanel";
import { nextGuide, type GuideKind } from "./components/CropGuides";
import type { CaptureFn, MaskApi } from "./components/ViewerCore";
import { encodeRaster, whiteBalanceFor, type BrushSettings } from "./mask";
import { detectSubject } from "./subject";
import { aspectRatio, CropPanel, fitAspect } from "./components/CropPanel";
import { CurveEditor } from "./components/CurveEditor";
import { ExportDialog } from "./components/ExportDialog";
import { Histogram } from "./components/Histogram";
import { GradingPanel } from "./components/GradingPanel";
import { HslPanel } from "./components/HslPanel";
import { InspectorSection } from "./components/InspectorSection";
import { MirrorPanel } from "./components/MirrorPanel";
import { Slider } from "./components/Slider";
import { AboutDialog } from "./components/AboutDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdater } from "./updater";
import { getVersion } from "@tauri-apps/api/app";
import { Viewer } from "./components/Viewer";
import { WatermarkPanel } from "./components/WatermarkPanel";
import { buildLut } from "./curve";
import {
  defaultParams,
  newHealSpot,
  newMask,
  presetSettings,
  type EditParams,
  type Histogram as Hist,
  type ImageInfo,
  type HealSpot,
  type Mask,
  type MaskKind,
  type MonitorInfo,
  type Preset,
  type PreviewImage,
  type TetherStatus,
} from "./types";
import "./App.css";

type InspectorKey =
  | "tone"
  | "color"
  | "curves"
  | "hsl"
  | "grading"
  | "detail"
  | "denoise"
  | "crop"
  | "mirror"
  | "watermark"
  | "tether"
  | "monitor"
  | "masks"
  | "lens"
  | "transform"
  | "heal"
  | "presets";

const TETHER_FOLDER_KEY = "darkroom.tetherFolder";
const GUIDE_KEY = "darkroom.guide";
const AUTO_NR_KEY = "darkroom.autoNr";

/**
 * Noise-reduction sliders from the measured noise level. Deterministic: the
 * same photo always gets the same values.
 */
function autoNoise(sigma: number): Pick<EditParams, "denoiseLuma" | "denoiseChroma" | "denoiseDetail"> {
  return {
    denoiseLuma: Math.max(0, Math.min(70, Math.round(sigma * 1100))),
    denoiseChroma: Math.max(20, Math.min(80, Math.round(20 + sigma * 1500))),
    denoiseDetail: 50,
  };
}

function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}
/** how many filmstrip thumbnails the phone page receives */
const MONITOR_STRIP = 60;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

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
    lensProfile: null,
  };
}

/**
 * RAW files start with Darkroom's Standard develop profile. Already-developed
 * bitmap files should not silently receive a second contrast curve, sharpening
 * pass, or colour denoise just by being opened.
 */
function defaultParamsForImage(info: ImageInfo | null): EditParams {
  const p = defaultParams();
  if (info && info.metadata.kind !== "raw") {
    p.baseContrast = 0;
    p.sharpen = 0;
    p.denoiseChroma = 0;
  }
  return p;
}

/**
 * Auto Edit is deliberately a simple deterministic develop recipe. It only
 * changes normal Darkroom sliders; it does not generate, replace, mask, or
 * invent image content.
 */
function applyAutoEdit(p: EditParams, noiseSigma: number): EditParams {
  const autoLuma = Math.round(clamp(8 + noiseSigma * 850, 8, 35));
  return {
    ...p,
    contrast: Math.max(p.contrast, 12),
    highlights: Math.min(p.highlights, -10),
    shadows: Math.max(p.shadows, 10),
    vibrance: Math.max(p.vibrance, 14),
    saturation: Math.max(p.saturation, 5),
    texture: Math.max(p.texture, 8),
    clarity: Math.max(p.clarity, 12),
    sharpen: Math.max(p.sharpen, 45),
    denoiseLuma: Math.max(p.denoiseLuma, autoLuma),
    denoiseChroma: Math.max(p.denoiseChroma, 30),
    denoiseDetail: Math.max(p.denoiseDetail, 55),
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
  const [cropMode, setCropMode] = useState(false);
  const [aspectKey, setAspectKey] = useState("free");
  const [showAbout, setShowAbout] = useState(false);
  const [version, setVersion] = useState("");
  const [openSections, setOpenSections] = useState<Record<InspectorKey, boolean>>({
    tone: true,
    color: false,
    curves: false,
    hsl: false,
    grading: false,
    detail: false,
    denoise: false,
    crop: false,
    mirror: false,
    watermark: false,
    tether: false,
    monitor: false,
    masks: false,
    lens: false,
    transform: false,
    heal: false,
    presets: false,
  });
  const updater = useUpdater(version);
  const saveTimer = useRef<number | null>(null);
  const pendingSave = useRef<{ path: string; params: EditParams } | null>(null);

  // tethered capture + phone monitor
  const [tether, setTether] = useState<TetherStatus>({ active: false, folder: "", count: 0 });
  const [tetherFolder, setTetherFolder] = useState(() => {
    try {
      return localStorage.getItem(TETHER_FOLDER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  const [autoOpen, setAutoOpen] = useState(true);
  const autoOpenRef = useRef(true);
  autoOpenRef.current = autoOpen;
  const [monitor, setMonitor] = useState<MonitorInfo | null>(null);
  const captureRef = useRef<CaptureFn | null>(null);
  const loadingRef = useRef(false);
  /** newest tethered shot that arrived while another one was still loading */
  const tetherQueue = useRef<string | null>(null);
  const loadRef = useRef<(path: string) => Promise<void>>(async () => {});

  // masks, eyedropper, guides, auto noise reduction
  const [selectedMaskId, setSelectedMaskId] = useState<string | null>(null);
  const [showMask, setShowMask] = useState(false);
  const [brush, setBrush] = useState<BrushSettings>({ size: 0.08, feather: 50, flow: 100, erase: false });
  const [detecting, setDetecting] = useState(false);
  const maskApiRef = useRef<MaskApi | null>(null);
  const [wbPick, setWbPick] = useState(false);
  const [guide, setGuide] = useState<GuideKind>(() => readPref(GUIDE_KEY, "thirds") as GuideKind);
  const [guideFlip, setGuideFlip] = useState(0);
  const [autoNr, setAutoNr] = useState(() => readPref(AUTO_NR_KEY, "0") === "1");
  // object remover
  const [healTool, setHealTool] = useState(false);
  const [healRadius, setHealRadius] = useState(0.03);
  const [healKind, setHealKind] = useState<"heal" | "clone">("heal");
  const [selectedSpotId, setSelectedSpotId] = useState<string | null>(null);
  const [healBusy, setHealBusy] = useState(false);
  // creative look (.cube) and saved presets
  const [lookBusy, setLookBusy] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const autoNrRef = useRef(autoNr);
  autoNrRef.current = autoNr;

  useEffect(() => {
    getVersion().then(setVersion).catch(() => setVersion("dev"));
  }, []);

  useEffect(() => {
    supportedExtensions()
      .then(setExtensions)
      .catch(() => setExtensions(["jpg", "jpeg", "png", "tif", "tiff", "dng", "cr2", "cr3", "arw", "nef", "raf"]));
  }, []);

  const lut = useMemo(() => buildLut(params.curves), [params.curves]);
  const defaults = useMemo(() => defaultParamsForImage(current), [current?.metadata.kind]);
  const defaultLut = useMemo(() => buildLut(defaults.curves), [defaults]);
  const shownParams = before ? defaults : params;
  const shownLut = before ? defaultLut : lut;

  // Non-destructive sidecar autosave, debounced while sliders are moving.
  useEffect(() => {
    if (!current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    const path = current.path;
    pendingSave.current = { path, params };
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      pendingSave.current = null;
      saveEdits(path, params).catch((e) => setError(`Could not save edits: ${String(e)}`));
    }, 400);
    return () => {
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
    };
  }, [params, current]);

  useEffect(() => {
    const flush = () => {
      const p = pendingSave.current;
      if (!p) return;
      pendingSave.current = null;
      void saveEdits(p.path, p.params);
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("beforeunload", flush);
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    if (!files.length) return;
    const t = window.setTimeout(() => {
      saveSession({ files: files.map((f) => f.path), current: current?.path ?? null }).catch(() => {});
    }, 300);
    return () => window.clearTimeout(t);
  }, [files, current]);

  const load = useCallback(async (path: string) => {
    loadingRef.current = true;
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
      setCropMode(false);
      setSelectedMaskId(null);
      setWbPick(false);
      setHealTool(false);
      setSelectedSpotId(null);
      let p = info.edits ?? defaultParamsForImage(info);
      if (!info.edits && autoNrRef.current && info.metadata.kind === "raw") p = { ...p, ...autoNoise(info.noiseSigma) };
      // the lens calibration is derived from the file rather than user data,
      // so always take the freshly resolved one
      p = { ...p, lensProfile: info.lensProfile };
      setParams(p);
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
      loadingRef.current = false;
      // a burst of tethered shots: skip straight to the newest one
      const next = tetherQueue.current;
      if (next) {
        tetherQueue.current = null;
        void loadRef.current(next);
      }
    }
  }, []);
  loadRef.current = load;

  // ---- tethered capture ----
  useEffect(() => {
    const un = listen<{ path: string; count: number }>("tether://file", (e) => {
      const p = e.payload.path;
      setTether((t) => ({ ...t, count: e.payload.count }));
      setFiles((prev) => (prev.some((f) => f.path === p) ? prev : [...prev, placeholder(p)]));
      if (!autoOpenRef.current) return;
      if (loadingRef.current) tetherQueue.current = p;
      else void loadRef.current(p);
    });
    return () => {
      un.then((f) => f()).catch(() => {});
    };
  }, []);

  const chooseTetherFolder = useCallback(async () => {
    const f = await pickFolder();
    if (!f) return;
    setTetherFolder(f);
    try {
      localStorage.setItem(TETHER_FOLDER_KEY, f);
    } catch {
      /* private mode etc. */
    }
  }, []);

  const toggleTether = useCallback(async () => {
    try {
      if (tether.active) {
        setTether(await stopTether());
        return;
      }
      let folder = tetherFolder;
      if (!folder) {
        const f = await pickFolder();
        if (!f) return;
        folder = f;
        setTetherFolder(f);
        try {
          localStorage.setItem(TETHER_FOLDER_KEY, f);
        } catch {
          /* ignore */
        }
      }
      setTether(await startTether(folder));
    } catch (e) {
      setError(`Tethering: ${String(e)}`);
    }
  }, [tether.active, tetherFolder]);

  // ---- phone monitor ----
  const toggleMonitor = useCallback(async () => {
    try {
      if (monitor?.active) {
        await stopMonitor();
        setMonitor(null);
      } else {
        setMonitor(await startMonitor());
      }
    } catch (e) {
      setError(`Phone monitor: ${String(e)}`);
    }
  }, [monitor?.active]);

  // The Rust side keeps watching/serving across a webview reload; pick that up.
  useEffect(() => {
    tetherStatus()
      .then((t) => {
        if (t.active) setTether(t);
      })
      .catch(() => {});
    monitorStatus()
      .then((m) => {
        if (m.active) setMonitor(m);
      })
      .catch(() => {});
  }, []);

  // viewer count refresh
  useEffect(() => {
    if (!monitor?.active) return;
    const id = window.setInterval(() => {
      monitorStatus()
        .then((m) => setMonitor(m.active ? m : null))
        .catch(() => {});
    }, 5000);
    return () => window.clearInterval(id);
  }, [monitor?.active]);

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

  const reset = useCallback(() => setParams(defaultParamsForImage(current)), [current]);

  // ---- masks ----
  const selectedMask = selectedMaskId ? (params.masks.find((m) => m.id === selectedMaskId) ?? null) : null;

  const changeMask = useCallback(
    (m: Mask) => {
      setParams((p) => {
        const prev = p.masks.find((x) => x.id === m.id);
        // touching a slider hides the red overlay so the effect is visible
        if (prev && prev.adjust !== m.adjust) setShowMask(false);
        return { ...p, masks: p.masks.map((x) => (x.id === m.id ? m : x)) };
      });
    },
    [],
  );

  const deleteMask = useCallback((id: string) => {
    setParams((p) => ({ ...p, masks: p.masks.filter((x) => x.id !== id) }));
    setSelectedMaskId((s) => (s === id ? null : s));
  }, []);

  const runDetectSubject = useCallback(
    async (id: string) => {
      const api = maskApiRef.current;
      const capture = captureRef.current;
      if (!api || !capture) return;
      setDetecting(true);
      try {
        const blob = await capture({ full: true });
        if (!blob) throw new Error("no picture to analyse");
        const { w, h } = api.size();
        const raster = await detectSubject(blob, w, h);
        const key = encodeRaster(raster, w, h);
        api.setRaster(id, raster, key);
        setParams((p) => ({ ...p, masks: p.masks.map((x) => (x.id === id ? { ...x, raster: key } : x)) }));
      } catch (e) {
        setError(`Subject detection failed: ${String(e)}`);
      } finally {
        setDetecting(false);
      }
    },
    [],
  );

  const addMask = useCallback(
    (kind: MaskKind) => {
      const m = newMask(kind, params.masks);
      setParams((p) => ({ ...p, masks: [...p.masks, m] }));
      setSelectedMaskId(m.id);
      setShowMask(kind !== "linear" && kind !== "radial");
      revealSection("masks");
      if (kind === "subject") void runDetectSubject(m.id);
    },
    [params.masks, runDetectSubject],
  );

  // ---- creative look (.cube) ----
  const loadLook = useCallback(async () => {
    setLookBusy(true);
    try {
      const path = await pickCube();
      if (!path) return;
      const info = await openLook(path);
      setParams((p) => ({ ...p, look: { enabled: true, path, name: info.name, amount: p.look.amount || 100 } }));
    } catch (e) {
      setError(`Could not read the .cube file: ${String(e)}`);
    } finally {
      setLookBusy(false);
    }
  }, []);

  // ---- develop presets ----
  const refreshPresets = useCallback(() => {
    listPresets()
      .then(setPresets)
      .catch((e) => setError(`Presets: ${String(e)}`));
  }, []);

  useEffect(refreshPresets, [refreshPresets]);

  const applyPreset = useCallback((preset: Preset) => {
    setParams((p) => ({ ...p, ...preset.settings }));
  }, []);

  const storePreset = useCallback(
    (name: string) => {
      savePreset(name, presetSettings(params))
        .then(refreshPresets)
        .catch((e) => setError(`Could not save the preset: ${String(e)}`));
    },
    [params, refreshPresets],
  );

  const removePreset = useCallback(
    (name: string) => {
      deletePreset(name)
        .then(refreshPresets)
        .catch((e) => setError(`Could not delete the preset: ${String(e)}`));
    },
    [refreshPresets],
  );

  // ---- object remover ----
  const addSpot = useCallback(
    async (x: number, y: number) => {
      const spot = newHealSpot(x, y, healRadius, healKind);
      const avoid: [number, number, number][] = params.heal.map((s) => [s.x, s.y, s.radius]);
      setParams((p) => ({ ...p, heal: [...p.heal, spot] }));
      setSelectedSpotId(spot.id);
      setHealBusy(true);
      try {
        const [sx, sy] = await findHealSource(x, y, healRadius, avoid);
        setParams((p) => ({ ...p, heal: p.heal.map((s) => (s.id === spot.id ? { ...s, sx, sy } : s)) }));
      } catch (e) {
        setError("Object remover: " + String(e));
      } finally {
        setHealBusy(false);
      }
    },
    [healRadius, healKind, params.heal],
  );

  const changeSpot = useCallback((s: HealSpot) => {
    setParams((p) => ({ ...p, heal: p.heal.map((x) => (x.id === s.id ? s : x)) }));
  }, []);

  const deleteSpot = useCallback((id: string) => {
    setParams((p) => ({ ...p, heal: p.heal.filter((x) => x.id !== id) }));
    setSelectedSpotId((s) => (s === id ? null : s));
  }, []);

  const repickSpot = useCallback(
    async (id: string) => {
      const spot = params.heal.find((s) => s.id === id);
      if (!spot) return;
      const avoid: [number, number, number][] = params.heal
        .filter((s) => s.id !== id)
        .map((s) => [s.x, s.y, s.radius]);
      setHealBusy(true);
      try {
        const [sx, sy] = await findHealSource(spot.x, spot.y, spot.radius, avoid);
        setParams((p) => ({ ...p, heal: p.heal.map((s) => (s.id === id ? { ...s, sx, sy } : s)) }));
      } catch (e) {
        setError("Object remover: " + String(e));
      } finally {
        setHealBusy(false);
      }
    },
    [params.heal],
  );

  const toggleHealTool = useCallback(() => {
    setHealTool((v) => {
      if (!v) {
        setOpenSections((prev) => ({ ...prev, heal: true }));
        setCropMode(false);
        setSelectedMaskId(null);
        setWbPick(false);
      }
      return !v;
    });
  }, []);

  // ---- white balance eyedropper ----
  const pickWb = useCallback((rgb: [number, number, number]) => {
    const wb = whiteBalanceFor(rgb[0], rgb[1], rgb[2]);
    setParams((p) => ({ ...p, temperature: wb.temperature, tint: wb.tint }));
    setWbPick(false);
  }, []);

  // ---- crop guides / auto NR prefs ----
  const changeGuide = useCallback((g: GuideKind) => {
    setGuide(g);
    writePref(GUIDE_KEY, g);
  }, []);
  const changeAutoNr = useCallback((v: boolean) => {
    setAutoNr(v);
    writePref(AUTO_NR_KEY, v ? "1" : "0");
  }, []);
  const applyAutoNr = useCallback(() => {
    if (!current) return;
    setParams((p) => ({ ...p, ...autoNoise(current.noiseSigma) }));
  }, [current]);
  const autoEdit = useCallback(() => {
    if (!current) return;
    setParams((p) => applyAutoEdit(p, current.noiseSigma));
    setOpenSections((prev) => ({ ...prev, tone: true, color: true, detail: true, denoise: true }));
  }, [current]);

  const rotate = useCallback(
    (deg: number) => setParams((p) => ({ ...p, rotation: (((p.rotation + deg) % 360) + 360) % 360 })),
    [],
  );

  const cropAspect = current ? aspectRatio(aspectKey, current.width, current.height) : null;
  const toggleCropMode = useCallback(() => {
    setCropMode((m) => {
      if (!m) setParams((p) => ({ ...p, crop: { ...p.crop, enabled: true } }));
      return !m;
    });
  }, []);
  const chooseAspect = useCallback(
    (key: string) => {
      setAspectKey(key);
      if (!current) return;
      const ratio = aspectRatio(key, current.width, current.height);
      setParams((p) => ({ ...p, crop: fitAspect(ratio, current.width, current.height, { ...p.crop, enabled: true }) }));
    },
    [current],
  );

  const toggleSection = useCallback((key: InspectorKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const revealSection = useCallback((key: InspectorKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: true }));
  }, []);

  useEffect(() => {
    if (cropMode) revealSection("crop");
  }, [cropMode, revealSection]);

  useEffect(() => {
    (window as unknown as { __darkroom?: unknown }).__darkroom = { load, autoEdit };
  }, [load, autoEdit]);

  const startedRef = useRef(false);
  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    startupFile()
      .then(async (p) => {
        if (p) {
          setFiles((prev) => (prev.some((f) => f.path === p) ? prev : [...prev, placeholder(p)]));
          void load(p);
          return;
        }
        const s = await loadSession();
        if (!s.files.length) return;
        setFiles((prev) => {
          const next = [...prev];
          for (const f of s.files) if (!next.some((x) => x.path === f)) next.push(placeholder(f));
          return next;
        });
        void load(s.current ?? s.files[0]);
      })
      .catch(() => {});
  }, [load]);

  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      const command = e.ctrlKey || e.metaKey;
      if (e.key === "\\") {
        setBefore(true);
        e.preventDefault();
      } else if (e.key === "Escape" && wbPick) {
        e.preventDefault();
        setWbPick(false);
      } else if (e.key === "Escape" && selectedMaskId && !cropMode) {
        e.preventDefault();
        setSelectedMaskId(null);
      } else if (e.key.toLowerCase() === "m" && !command && selectedMaskId) {
        e.preventDefault();
        setShowMask((v) => !v);
      } else if (e.key === "o" && !command && cropMode) {
        e.preventDefault();
        changeGuide(nextGuide(guide));
      } else if (e.key === "O" && !command && cropMode) {
        e.preventDefault();
        setGuideFlip((f) => (f + 1) % 4);
      } else if (e.key === "Escape" && healTool) {
        e.preventDefault();
        setHealTool(false);
      } else if ((e.key === "[" || e.key === "]") && !command && healTool) {
        e.preventDefault();
        const k = e.key === "]" ? 1.25 : 0.8;
        setHealRadius((r) => clamp(r * k, 0.003, 0.2));
      } else if (e.key.toLowerCase() === "r" && !command && current) {
        e.preventDefault();
        toggleHealTool();
      } else if ((e.key === "[" || e.key === "]") && !command && selectedMask?.kind === "brush") {
        e.preventDefault();
        const k = e.key === "]" ? 1.25 : 0.8;
        setBrush((b) => ({ ...b, size: clamp(b.size * k, 0.005, 0.4) }));
      } else if ((e.key === "Escape" || e.key === "Enter") && cropMode) {
        e.preventDefault();
        setCropMode(false);
      } else if (e.key.toLowerCase() === "c" && !command && current) {
        e.preventDefault();
        toggleCropMode();
      } else if (e.key === "1" && !command && current) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("darkroom:zoom", { detail: "100" }));
      } else if (e.key === "0" && !command && current) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("darkroom:zoom", { detail: "fit" }));
      } else if (command && e.key.toLowerCase() === "o") {
        e.preventDefault();
        void openFiles();
      } else if (command && e.key.toLowerCase() === "e" && current) {
        e.preventDefault();
        setShowExport(true);
      } else if (command && e.key === "[" && current) {
        e.preventDefault();
        rotate(-90);
      } else if (command && e.key === "]" && current) {
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
  }, [
    openFiles,
    current,
    rotate,
    cropMode,
    toggleCropMode,
    wbPick,
    selectedMaskId,
    selectedMask?.kind,
    guide,
    changeGuide,
    healTool,
    toggleHealTool,
  ]);

  const set =
    <K extends keyof EditParams>(key: K) =>
    (v: EditParams[K]) =>
      setParams((p) => ({ ...p, [key]: v }));

  const currentIndex = current ? files.findIndex((f) => f.path === current.path) : -1;

  // What the phone shows besides pixels: name, metadata line, filmstrip.
  const monitorOn = !!monitor?.active;
  useEffect(() => {
    if (!monitorOn) return;
    const recent = files.slice(-MONITOR_STRIP);
    publishShot({
      name: current ? fileName(current.path) : "",
      meta: current ? metaLine(current) : "",
      index: currentIndex >= 0 ? currentIndex + 1 : 0,
      total: files.length,
      thumbs: recent.map((f) => ({ name: fileName(f.path), src: f.thumbnail, active: current?.path === f.path })),
    }).catch(() => {});
  }, [monitorOn, files, current, currentIndex]);

  // The developed picture, re-sent once the edit settles.
  useEffect(() => {
    if (!monitorOn || !current || !preview) return;
    const t = window.setTimeout(async () => {
      const blob = await captureRef.current?.();
      if (!blob) return;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      publishFrame(bytes).catch(() => {});
    }, 350);
    return () => window.clearTimeout(t);
  }, [monitorOn, current, preview, params, lut]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">◢</span>
          <span className="brand-copy">
            <strong>Darkroom</strong>
            <small>RAW Photography. Deeper.</small>
          </span>
        </div>

        <div className="file-context">
          <strong>{current ? fileName(current.path) : "No photo selected"}</strong>
          <span>{loading ? `Loading ${loading}…` : current ? metaLine(current) : "Open a RAW or bitmap image to begin"}</span>
        </div>

        <div className="top-actions">
          <span className="zoom-pill">{zoom || "Fit"}</span>
          <button className="icon-button" onClick={() => rotate(-90)} disabled={!current} title="Rotate left">↶</button>
          <button className="icon-button" onClick={() => rotate(90)} disabled={!current} title="Rotate right">↷</button>
          <button
            className={"quiet-button" + (before ? " active" : "")}
            onPointerDown={() => setBefore(true)}
            onPointerUp={() => setBefore(false)}
            onPointerLeave={() => setBefore(false)}
            disabled={!current}
            title="Hold to show original (or hold \\)"
          >
            Original
          </button>
          <button
            className="quiet-button auto-edit-button"
            onClick={autoEdit}
            disabled={!current}
            title="Quick deterministic adjustment recipe: clarity, denoise, sharpening, contrast and saturation. No generative AI."
          >
            ✦ Auto Edit
          </button>
          <button className="primary export-button" onClick={() => setShowExport(true)} disabled={!current}>
            Export
          </button>
        </div>
      </header>

      <div className="main">
        <nav className="toolrail" aria-label="Workspace tools">
          <button type="button" onClick={openFiles} title="Open photos">
            <span className="tool-glyph">▧</span><span>Browse</span>
          </button>
          <button type="button" className={!cropMode ? "active" : ""} onClick={() => revealSection("tone")}>
            <span className="tool-glyph">☷</span><span>Develop</span>
          </button>
          <button type="button" className={cropMode ? "active" : ""} onClick={toggleCropMode} disabled={!current}>
            <span className="tool-glyph">⌗</span><span>Crop</span>
          </button>
          <button
            type="button"
            className={selectedMaskId ? "active" : ""}
            onClick={() => revealSection("masks")}
            disabled={!current}
            title="Local adjustments: gradients, brush, luminance range, subject"
          >
            <span className="tool-glyph">◐</span><span>Masks</span>
          </button>
          <button
            type="button"
            className={healTool ? "active" : ""}
            onClick={toggleHealTool}
            disabled={!current}
            title="Object remover: copy over something you do not want"
          >
            <span className="tool-glyph">✚</span><span>Repair</span>
          </button>
          <button
            type="button"
            onClick={() => {
              revealSection("mirror");
              revealSection("watermark");
            }}
            disabled={!current}
          >
            <span className="tool-glyph">✦</span><span>Effects</span>
          </button>
          <button
            type="button"
            className={tether.active || monitor?.active ? "live" : ""}
            onClick={() => {
              revealSection("tether");
              revealSection("monitor");
            }}
            title="Shoot into Darkroom and watch on a phone"
          >
            <span className="tool-glyph">⌁</span><span>Tether</span>
          </button>
          <button type="button" onClick={() => setShowExport(true)} disabled={!current}>
            <span className="tool-glyph">⇧</span><span>Export</span>
          </button>
          <span className="toolrail-spacer" />
          <button type="button" onClick={() => setShowAbout(true)}>
            <span className="tool-glyph">⚙</span><span>Settings</span>
          </button>
        </nav>

        <div className="viewer-shell">
          <div className="viewer-toolbar">
            <div className="viewer-toolbar-group">
              <button
                className={before ? "active" : ""}
                onPointerDown={() => setBefore(true)}
                onPointerUp={() => setBefore(false)}
                onPointerLeave={() => setBefore(false)}
                disabled={!current}
              >
                Hold Original
              </button>
              <span className="viewer-hint">\\</span>
            </div>
            <div className="viewer-toolbar-group">
              <button onClick={reset} disabled={!current}>Reset edit</button>
              <span className="viewer-zoom">{zoom}</span>
            </div>
          </div>

          <Viewer
            image={preview}
            params={shownParams}
            beforeParams={defaults}
            lut={shownLut}
            captureRef={captureRef}
            maskApiRef={maskApiRef}
            selectedMaskId={selectedMaskId}
            showMask={showMask}
            brush={brush}
            onMaskChange={changeMask}
            wbPick={wbPick}
            onPickWb={pickWb}
            guide={guide}
            guideFlip={guideFlip}
            healTool={healTool}
            healRadius={healRadius}
            selectedSpotId={selectedSpotId}
            onSelectSpot={setSelectedSpotId}
            onAddSpot={addSpot}
            onSpotChange={changeSpot}
            rotation={params.rotation}
            mirror={params.mirror}
            onMirrorChange={set("mirror")}
            watermark={params.watermark}
            onWatermarkChange={set("watermark")}
            crop={params.crop}
            cropMode={cropMode}
            cropAspect={cropAspect}
            onCropChange={set("crop")}
            onHistogram={setHist}
            onZoom={setZoom}
          />
        </div>

        <aside className="panel">
          <div className="inspector-top">
            <div>
              <strong>Edit</strong>
              <span>Non-destructive develop</span>
            </div>
            <button onClick={reset} disabled={!current}>Reset all</button>
          </div>

          <div className="histogram-card">
            <div className="histogram-head">
              <span>Histogram</span>
              <span>{current?.metadata.iso ? `ISO ${current.metadata.iso}` : "RGB"}</span>
            </div>
            <Histogram hist={hist} />
          </div>

          <InspectorSection title="Tone" shortcut="L" open={openSections.tone} onToggle={() => toggleSection("tone")}>
            <label className="field">
              <span>Profile</span>
              <select
                value={params.profile}
                title={PROFILES.find((x) => x.id === params.profile)?.hint}
                onChange={(e) => {
                  const id = e.target.value;
                  setParams((p) => ({ ...p, profile: id, baseContrast: id === "flat" ? 0 : 1 }));
                }}
              >
                {PROFILES.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </select>
            </label>
            <LookRow look={params.look} busy={lookBusy} onLoad={() => void loadLook()} onChange={set("look")} />
            <Slider label="Exposure" value={params.exposure} min={-5} max={5} step={0.05} onChange={set("exposure")} />
            <Slider label="Contrast" value={params.contrast} min={-100} max={100} onChange={set("contrast")} />
            <Slider label="Highlights" value={params.highlights} min={-100} max={100} onChange={set("highlights")} />
            <Slider label="Shadows" value={params.shadows} min={-100} max={100} onChange={set("shadows")} />
            <Slider label="Whites" value={params.whites} min={-100} max={100} onChange={set("whites")} />
            <Slider label="Blacks" value={params.blacks} min={-100} max={100} onChange={set("blacks")} />
          </InspectorSection>

          <InspectorSection title="Color" shortcut="C" open={openSections.color} onToggle={() => toggleSection("color")}>
            <div className="slider-with-tool">
              <Slider
                label="Temperature"
                value={params.temperature}
                min={-100}
                max={100}
                track="linear-gradient(90deg,#3e7be8,#777 50%,#f5b12b)"
                onChange={set("temperature")}
              />
              <button
                className={"eyedropper" + (wbPick ? " active" : "")}
                title="White balance eyedropper: click something neutral in the photo"
                disabled={!current}
                onClick={() => setWbPick((v) => !v)}
              >
                ✎
              </button>
            </div>
            <Slider
              label="Tint"
              value={params.tint}
              min={-100}
              max={100}
              track="linear-gradient(90deg,#46a758,#777 50%,#d6409f)"
              onChange={set("tint")}
            />
            <div className="divider" />
            <Slider label="Vibrance" value={params.vibrance} min={-100} max={100} onChange={set("vibrance")} />
            <Slider label="Saturation" value={params.saturation} min={-100} max={100} onChange={set("saturation")} />
          </InspectorSection>

          <InspectorSection title="Curves" shortcut="V" open={openSections.curves} onToggle={() => toggleSection("curves")}>
            <CurveEditor curves={params.curves} onChange={set("curves")} />
          </InspectorSection>

          <InspectorSection title="HSL" shortcut="H" open={openSections.hsl} onToggle={() => toggleSection("hsl")}>
            <HslPanel hsl={params.hsl} onChange={set("hsl")} />
          </InspectorSection>

          <InspectorSection title="Color Grading" shortcut="G" open={openSections.grading} onToggle={() => toggleSection("grading")}>
            <GradingPanel grading={params.grading} onChange={set("grading")} />
          </InspectorSection>

          <InspectorSection title="Detail" shortcut="D" open={openSections.detail} onToggle={() => toggleSection("detail")}>
            <Slider label="Texture" value={params.texture} min={-100} max={100} onChange={set("texture")} />
            <Slider label="Clarity" value={params.clarity} min={-100} max={100} onChange={set("clarity")} />
            <Slider label="Dehaze" value={params.dehaze} min={-100} max={100} onChange={set("dehaze")} />
            <Slider label="Sharpening" value={params.sharpen} min={0} max={150} defaultValue={25} onChange={set("sharpen")} />
          </InspectorSection>

          <InspectorSection
            title="Noise Reduction"
            shortcut="N"
            open={openSections.denoise}
            onToggle={() => toggleSection("denoise")}
            note={current && current.noiseSigma > 0 ? <span className="section-note">{(current.noiseSigma * 100).toFixed(2)}</span> : undefined}
          >
            <div className="nr-auto">
              <button onClick={applyAutoNr} disabled={!current} title="Set the sliders from the measured noise of this photo">
                Auto
              </button>
              <label>
                <input type="checkbox" checked={autoNr} onChange={(e) => changeAutoNr(e.target.checked)} />
                Apply to new RAW photos
              </label>
            </div>
            <Slider label="Luminance" value={params.denoiseLuma} min={0} max={100} onChange={set("denoiseLuma")} />
            <Slider label="Color" value={params.denoiseChroma} min={0} max={100} defaultValue={25} onChange={set("denoiseChroma")} />
            <Slider label="Detail" value={params.denoiseDetail} min={0} max={100} defaultValue={50} onChange={set("denoiseDetail")} />
            <div className="hint">Judge fine noise at 1:1 or in the exported file.</div>
          </InspectorSection>

          <InspectorSection title="Crop & Straighten" shortcut="C" open={openSections.crop} onToggle={() => toggleSection("crop")}>
            <CropPanel
              crop={params.crop}
              cropMode={cropMode}
              aspectKey={aspectKey}
              imageWidth={current?.width ?? 1}
              imageHeight={current?.height ?? 1}
              onChange={set("crop")}
              onAspect={chooseAspect}
              onToggleMode={toggleCropMode}
              guide={guide}
              onGuide={changeGuide}
            />
          </InspectorSection>

          <InspectorSection
            title="Presets"
            open={openSections.presets}
            onToggle={() => toggleSection("presets")}
            note={presets.length ? <span className="section-note">{presets.length}</span> : undefined}
          >
            <PresetPanel
              presets={presets}
              disabled={!current}
              onApply={applyPreset}
              onSave={storePreset}
              onDelete={removePreset}
            />
          </InspectorSection>

          <InspectorSection
            title="Lens Corrections"
            open={openSections.lens}
            onToggle={() => toggleSection("lens")}
            note={current?.lensProfile ? <span className="section-note">auto</span> : undefined}
          >
            <LensPanel
              lens={params.lens}
              profile={params.lensProfile}
              camera={current?.metadata.camera}
              lensName={current?.metadata.lens}
              onChange={set("lens")}
            />
          </InspectorSection>

          <InspectorSection title="Transform" open={openSections.transform} onToggle={() => toggleSection("transform")}>
            <TransformPanel transform={params.transform} onChange={set("transform")} />
          </InspectorSection>

          <InspectorSection
            title="Object Remover"
            shortcut="R"
            open={openSections.heal}
            onToggle={() => toggleSection("heal")}
            note={params.heal.length ? <span className="section-note">{params.heal.length}</span> : undefined}
          >
            <HealPanel
              spots={params.heal}
              selectedId={selectedSpotId}
              active={healTool}
              radius={healRadius}
              kind={healKind}
              busy={healBusy}
              onToggle={toggleHealTool}
              onRadius={setHealRadius}
              onKind={setHealKind}
              onSelect={setSelectedSpotId}
              onChange={changeSpot}
              onDelete={deleteSpot}
              onClear={() => setParams((p) => ({ ...p, heal: [] }))}
              onRepick={(id) => void repickSpot(id)}
            />
          </InspectorSection>

          <InspectorSection
            title="Masks"
            shortcut="K"
            open={openSections.masks}
            onToggle={() => {
              if (openSections.masks) setSelectedMaskId(null);
              toggleSection("masks");
            }}
            note={params.masks.length ? <span className="section-note">{params.masks.length}</span> : undefined}
          >
            <MaskPanel
              masks={params.masks}
              selectedId={selectedMaskId}
              showMask={showMask}
              brush={brush}
              detecting={detecting}
              onSelect={setSelectedMaskId}
              onAdd={addMask}
              onChange={changeMask}
              onDelete={deleteMask}
              onShowMask={setShowMask}
              onBrush={setBrush}
              onDetectSubject={(id) => void runDetectSubject(id)}
            />
          </InspectorSection>

          <InspectorSection title="Motion Trails" open={openSections.mirror} onToggle={() => toggleSection("mirror")}>
            <label className="feature-toggle">
              <span>
                <strong>Enable trails</strong>
                <small>Directional ghost echoes from the existing image. No AI manipulation.</small>
              </span>
              <input
                type="checkbox"
                checked={params.mirror.enabled}
                onChange={(e) => set("mirror")({ ...params.mirror, enabled: e.target.checked })}
              />
            </label>
            <MirrorPanel mirror={params.mirror} onChange={set("mirror")} />
          </InspectorSection>

          <InspectorSection title="Watermark" open={openSections.watermark} onToggle={() => toggleSection("watermark")}>
            <label className="feature-toggle">
              <span>
                <strong>Enable watermark</strong>
                <small>Place your image mark on the exported photo.</small>
              </span>
              <input
                type="checkbox"
                checked={params.watermark.enabled}
                disabled={!params.watermark.path}
                onChange={(e) => set("watermark")({ ...params.watermark, enabled: e.target.checked })}
              />
            </label>
            <WatermarkPanel watermark={params.watermark} onChange={set("watermark")} onError={setError} />
          </InspectorSection>

          <InspectorSection
            title="Tethered Capture"
            open={openSections.tether}
            onToggle={() => toggleSection("tether")}
            note={tether.active ? <span className="section-note live">LIVE</span> : undefined}
          >
            <TetherPanel
              status={tether}
              folder={tetherFolder}
              autoOpen={autoOpen}
              onChooseFolder={chooseTetherFolder}
              onToggle={toggleTether}
              onAutoOpen={setAutoOpen}
            />
          </InspectorSection>

          <InspectorSection
            title="Phone Monitor"
            open={openSections.monitor}
            onToggle={() => toggleSection("monitor")}
            note={monitor?.active ? <span className="section-note live">{monitor.viewers}</span> : undefined}
          >
            <MonitorPanel info={monitor} onToggle={toggleMonitor} />
          </InspectorSection>
        </aside>
      </div>

      <footer className="filmstrip">
        <div className="filmstrip-summary">
          <span className="filmstrip-grid">▦</span>
          <span>
            {files.length === 0
              ? "No photos open"
              : `${currentIndex >= 0 ? currentIndex + 1 : 0} of ${files.length} photo${files.length === 1 ? "" : "s"}`}
          </span>
        </div>
        <div className="filmstrip-track">
          {files.length === 0 && <span className="hint">Browse to open RAW, JPEG, PNG, or TIFF images.</span>}
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
        </div>
      </footer>

      {!showAbout && <UpdateBanner status={updater.status} onInstall={updater.install} onDismiss={updater.dismiss} />}
      {showAbout && (
        <AboutDialog
          version={version}
          status={updater.status}
          onCheck={updater.checkNow}
          onInstall={updater.install}
          onClose={() => setShowAbout(false)}
        />
      )}
      {error && (
        <div className="toast" onClick={() => setError(null)}>
          {error}
        </div>
      )}
      {showExport && current && <ExportDialog image={current} params={params} onClose={() => setShowExport(false)} />}
    </div>
  );
}
