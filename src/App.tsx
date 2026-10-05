import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  getPreview,
  getThumbnail,
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
  autoLook,
  exportCube,
  listPresets,
  matchTone,
  pickSavePath,
  importPhoto,
  applyEdits,
  markedPhotos,
  openBlend,
  openLook,
  pickCube,
  platform,
  pickPhoto,
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
import { detectLookInput } from "./camlog";
import { LookRow } from "./components/LookRow";
import { PresetPanel } from "./components/PresetPanel";
import { DoubleExposurePanel } from "./components/DoubleExposurePanel";
import { nextGuide, type GuideKind } from "./components/CropGuides";
import type { CaptureFn, MaskApi } from "./components/ViewerCore";
import { encodeRaster, whiteBalanceFor, type BrushSettings } from "./mask";
import { detectSubject } from "./subject";
import { aspectRatio, CropPanel, fitAspect } from "./components/CropPanel";
import { CurveEditor } from "./components/CurveEditor";
import { ExportDialog } from "./components/ExportDialog";
import { Scopes, SCOPE_LABELS, type ScopeKind } from "./components/Scopes";
import { GradingPanel } from "./components/GradingPanel";
import { HslPanel } from "./components/HslPanel";
import { InspectorSection, SectionFilter } from "./components/InspectorSection";
import { PHONE_TABS, usePhone, type PhoneTabId } from "./phone";
import { useHistory } from "./history";
import { MirrorPanel } from "./components/MirrorPanel";
import { StarPanel } from "./components/StarPanel";
import { dropGoesToBlend, firstPhoto } from "./dropTarget";
import { ToneMatchPanel } from "./components/ToneMatchPanel";
import { blendTune, tuneOf, withTune } from "./toneMatch";
import { VignettePanel } from "./components/VignettePanel";
import { Slider } from "./components/Slider";
import { AboutDialog } from "./components/AboutDialog";
import { UpdateBanner } from "./components/UpdateBanner";
import { useUpdater } from "./updater";
import { getVersion } from "@tauri-apps/api/app";
import { Viewer } from "./components/Viewer";
import { WatermarkPanel } from "./components/WatermarkPanel";
import { buildLut } from "./curve";
import {
  defaultBlend,
  defaultParams,
  newHealSpot,
  newMask,
  presetSettings,
  subtractInsertAt,
  type EditParams,
  type ToneMatch,
  type Tune,
  type Histogram as Hist,
  type ImageInfo,
  type HealSpot,
  type Mask,
  type MaskKind,
  type MaskMode,
  type MonitorInfo,
  type Preset,
  type PreviewImage,
  type TetherStatus,
} from "./types";
import "./App.css";
import "./Studio.css";

/**
 * A trail being switched on picks up the mask the photo already has, which is
 * what people mean by "trail the subject"; with no masks it echoes the frame.
 */
function trailMask(p: EditParams): string {
  if (p.mirror.mask && p.masks.some((m) => m.id === p.mirror.mask && m.mode !== "subtract")) return p.mirror.mask;
  return p.masks.find((m) => m.mode !== "subtract" && m.enabled)?.id ?? "";
}

type InspectorKey =
  | "tone"
  | "color"
  | "curves"
  | "hsl"
  | "grading"
  | "detail"
  | "denoise"
  | "grain"
  | "crop"
  | "mirror"
  | "watermark"
  | "tether"
  | "monitor"
  | "masks"
  | "lens"
  | "transform"
  | "heal"
  | "blend"
  | "star"
  | "vignette"
  | "match"
  | "presets";

/** The inspector section each phone tab opens, the rest start collapsed. */
const PHONE_TAB_OPENS: Record<PhoneTabId, InspectorKey> = {
  light: "tone",
  color: "color",
  curves: "curves",
  detail: "detail",
  effects: "blend",
  optics: "lens",
  crop: "crop",
  masks: "masks",
  repair: "heal",
  presets: "presets",
};

type WorkspaceId = "edit" | "effects" | "masks" | "connect" | "crop" | "repair";
const WORKSPACES: Record<WorkspaceId, { label: string; hint: string; sections: ReadonlySet<string> }> = {
  edit: { label: "Edit", hint: "Light, color & finishing", sections: new Set(["Tone", "Color", "Curves", "HSL", "Color Grading", "Tone Match", "Detail", "Noise Reduction", "Presets", "Lens Corrections", "Transform"]) },
  effects: { label: "Effects", hint: "Shape light. Create movement.", sections: new Set(["Grain", "Motion Trails", "Double Exposure", "Vignette", "Starburst", "Watermark"]) },
  masks: { label: "Masks", hint: "Precision, where it matters", sections: new Set(["Masks", "Motion Trails"]) },
  connect: { label: "Connect", hint: "Capture & phone monitoring", sections: new Set(["Tethered Capture", "Phone Monitor"]) },
  crop: { label: "Crop", hint: "Compose your frame", sections: new Set(["Crop & Straighten", "Transform", "Lens Corrections"]) },
  repair: { label: "Repair", hint: "Heal & clone real pixels", sections: new Set(["Object Remover"]) },
};
function workspaceFor(key: InspectorKey): WorkspaceId {
  if (["grain", "mirror", "blend", "vignette", "star", "watermark"].includes(key)) return "effects";
  if (key === "masks") return "masks";
  if (key === "tether" || key === "monitor") return "connect";
  if (key === "crop") return "crop";
  if (key === "heal") return "repair";
  return "edit";
}

const TETHER_FOLDER_KEY = "darkroom.tetherFolder";
const PHOTO_FOLDER_KEY = "darkroom.photoFolder";
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
    denoiseDetail: 35,
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
    noiseShadow: 0,
    metadata: { kind: "" },
    edits: null,
    thumbnail: "",
    lensProfile: null,
  };
}

/**
 * RAW files start with NFrame Studio's Standard develop profile. Already-developed
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
 * changes normal NFrame Studio sliders; it does not generate, replace, mask, or
 * invent image content.
 */
/**
 * The one-click recipe. Deterministic, built from ordinary develop sliders, and
 * not generative: it adds, removes and invents nothing.
 *
 * It sets these values rather than raising the ones already there. Raising them
 * meant that on a photo you had already worked on - which is most of them by the
 * time you reach for Auto - every value was already past the floor and the
 * button did nothing at all. Setting them makes it do the same thing every time
 * and on every photo, and undo takes it back.
 */
/**
 * Auto, read from the photo: the tone and colour sliders come from what the
 * photo actually is (see tonematch.rs auto), and what is left is the part that is
 * a matter of taste rather than of measurement - a little vibrance, local
 * contrast, sharpening - which stays constant, with the noise reduction following
 * the noise.
 */
const AUTO_VIBRANCE = 18;

function applyAutoLook(p: EditParams, tune: Tune, noiseSigma: number): EditParams {
  const autoLuma = Math.round(clamp(10 + noiseSigma * 900, 10, 45));
  return {
    ...withTune(p, tune),
    // twin of AUTO_VIBRANCE in tonematch.rs: the photo is measured with it in
    // place, so it has to be the same number
    vibrance: AUTO_VIBRANCE,
    texture: 15,
    clarity: 20,
    sharpen: 55,
    denoiseLuma: autoLuma,
    denoiseChroma: 30,
    denoiseDetail: 35,
  };
}

/** The fixed recipe, for when the photo cannot be read. */
function applyAutoEdit(p: EditParams, noiseSigma: number): EditParams {
  const autoLuma = Math.round(clamp(10 + noiseSigma * 900, 10, 45));
  return {
    ...p,
    contrast: 22,
    highlights: -22,
    shadows: 20,
    vibrance: 25,
    saturation: 8,
    texture: 15,
    clarity: 20,
    sharpen: 55,
    denoiseLuma: autoLuma,
    denoiseChroma: 30,
    // matches the noise reduction default: Detail puts noise back, and this
    // used to push it to 55, undoing most of what the sliders had just removed
    denoiseDetail: 35,
  };
}

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceId>("edit");
  const [stripVisible, setStripVisible] = useState(true);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [files, setFiles] = useState<ImageInfo[]>([]);
  const [current, setCurrent] = useState<ImageInfo | null>(null);
  const [preview, setPreview] = useState<PreviewImage | null>(null);
  // every change to the develop settings is a step you can take back
  const history = useHistory<EditParams>(defaultParams());
  const params = history.value;
  const setParams = history.set;
  const [before, setBefore] = useState(false);
  const [hist, setHist] = useState<Hist | null>(null);
  // the downsampled developed frame the scopes measure, read back with the
  // histogram so they cost nothing extra on the GPU
  const [scopeFrame, setScopeFrame] = useState<{ data: Uint8Array; width: number; height: number } | null>(null);
  const [scope, setScope] = useState<ScopeKind>("histogram");
  const [skinLine, setSkinLine] = useState(true);
  const [zoom, setZoom] = useState("");
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showExport, setShowExport] = useState(false);
  const [cropMode, setCropMode] = useState(false);
  const [aspectKey, setAspectKey] = useState("free");
  const [showAbout, setShowAbout] = useState(false);
  // the folder Open Photos starts in; empty means "wherever you were last"
  const [photoFolder, setPhotoFolder] = useState(() => {
    try {
      return localStorage.getItem(PHOTO_FOLDER_KEY) ?? "";
    } catch {
      return "";
    }
  });
  // filmstrip selection: what the batch actions work on. The photo being
  // edited is always in it, so the actions apply to what you can see.
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const selectAnchor = useRef<string | null>(null);
  const [batchExport, setBatchExport] = useState<string[] | null>(null);
  // photos flagged as finished and wanted in the next export
  const [marked, setMarked] = useState<ReadonlySet<string>>(new Set());
  const [notice, setNotice] = useState<string | null>(null);
  // A notice is a receipt - "applied to 12 photos" - so it takes itself away.
  // An error stays until it is read and dismissed.
  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(t);
  }, [notice]);
  // phone layout: the open tool sheet, and the photo library screen
  const phone = usePhone();
  const [phoneTab, setPhoneTab] = useState<PhoneTabId | null>(null);
  const [phoneLibrary, setPhoneLibrary] = useState(false);
  // right-click (long-press on a phone) menu on a filmstrip thumbnail
  const [thumbMenu, setThumbMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [version, setVersion] = useState("");
  const [openSections, setOpenSections] = useState<Record<InspectorKey, boolean>>({
    tone: true,
    color: false,
    curves: false,
    hsl: false,
    grading: false,
    detail: false,
    denoise: false,
    grain: false,
    crop: false,
    mirror: false,
    watermark: false,
    tether: false,
    monitor: false,
    masks: false,
    lens: false,
    transform: false,
    heal: false,
    blend: false,
    star: false,
    vignette: false,
    match: false,
    presets: false,
  });
  // phones are updated by whatever installed them, never by themselves
  const [platformInfo, setPlatformInfo] = useState({ os: "", updates: true });
  useEffect(() => {
    platform().then(setPlatformInfo).catch(() => {});
  }, []);
  const updater = useUpdater(version, platformInfo.updates, platformInfo.os);
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
  const masksRef = useRef<Mask[]>([]);
  // read by changeShowMask, which must not be rebuilt on every mask edit
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
  const [blendBusy, setBlendBusy] = useState(false);
  const [blendDrop, setBlendDrop] = useState(false);
  const blendZone = useRef<HTMLDivElement | null>(null);
  // read by the drag-and-drop listener, which is set up once
  const blendOpenRef = useRef(false);
  // the drop listener is set up once, so it reaches the latest handler this way
  const runToneMatchRef = useRef<((p?: string) => Promise<void>) | null>(null);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [cubeBusy, setCubeBusy] = useState(false);
  // a tone match in progress: the reference, what the sliders were before, and
  // the solver's answer, so strength can back it off and undo can put it back
  const [toneMatch, setToneMatch] = useState<{
    name: string;
    path: string;
    before: Tune;
    result: ToneMatch;
    strength: number;
  } | null>(null);
  const [matchBusy, setMatchBusy] = useState(false);
  const matchOpenRef = useRef(false);
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

  masksRef.current = params.masks;
  blendOpenRef.current = openSections.blend;
  matchOpenRef.current = openSections.match;
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

  // Saving is held back until the previous session has been restored, so an
  // empty first render cannot wipe it. After that an empty list is a real
  // state - the user removed the last photo - and must be saved.
  const sessionReady = useRef(false);
  useEffect(() => {
    if (!sessionReady.current) {
      if (!files.length) return;
      sessionReady.current = true;
    }
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
      const pv = await getPreview(info.previewWidth, info.previewHeight, info.noiseSigma, info.noiseShadow);
      performance.measure("ipc.get_preview", { start: t1 });
      setCurrent(info);
      setPreview(pv);
      setSelected(new Set([info.path]));
      selectAnchor.current = info.path;
      setCropMode(false);
      setAspectKey("free");
      setSelectedMaskId(null);
      setWbPick(false);
      setHealTool(false);
      setSelectedSpotId(null);
      let p = info.edits ?? defaultParamsForImage(info);
      if (!info.edits && autoNrRef.current && info.metadata.kind === "raw") p = { ...p, ...autoNoise(info.noiseSigma) };
      // the lens calibration is derived from the file rather than user data,
      // so always take the freshly resolved one
      p = { ...p, lensProfile: info.lensProfile };
      history.reset(p);
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
    const picked = await pickImages(extensions.length ? extensions : ["*"], photoFolder);
    if (!picked.length) return;
    // One at a time: on a phone each is copied into app storage, and RAW files
    // are tens of megabytes. On the desktop this returns the paths unchanged.
    const paths: string[] = [];
    for (const uri of picked) {
      try {
        paths.push(await importPhoto(uri));
      } catch (e) {
        setError(`Could not open that photo: ${String(e)}`);
      }
    }
    if (!paths.length) return;
    setPhoneLibrary(false);
    setFiles((prev) => {
      const next = [...prev];
      for (const p of paths) if (!next.some((f) => f.path === p)) next.push(placeholder(p));
      return next;
    });
    await load(paths[0]);
  }, [extensions, load, photoFolder]);

  /**
   * Take photos out of the filmstrip and the saved session. The files on disk
   * are never touched. If one of them was being edited, a neighbour opens so
   * the viewer is never left showing something the strip no longer lists.
   */
  const removeFromFilmstrip = useCallback(
    (paths: string[]) => {
      setThumbMenu(null);
      const gone = new Set(paths);
      const at = files.findIndex((f) => gone.has(f.path));
      if (at < 0) return;
      const rest = files.filter((f) => !gone.has(f.path));
      setFiles(rest);
      setSelected((prev) => new Set([...prev].filter((p) => !gone.has(p))));
      if (!current || !gone.has(current.path)) return;
      if (!rest.length) {
        setCurrent(null);
        setPreview(null);
        return;
      }
      void load(rest[Math.min(at, rest.length - 1)].path);
    },
    [files, current, load],
  );

  /** Ctrl/Cmd click picks photos out, Shift click takes a run of them. */
  const clickThumb = useCallback(
    (path: string, e: React.MouseEvent) => {
      if (e.shiftKey && selectAnchor.current) {
        const from = files.findIndex((f) => f.path === selectAnchor.current);
        const to = files.findIndex((f) => f.path === path);
        if (from >= 0 && to >= 0) {
          const [lo, hi] = from < to ? [from, to] : [to, from];
          setSelected(new Set(files.slice(lo, hi + 1).map((f) => f.path)));
          return;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(path)) next.delete(path);
          else next.add(path);
          return next;
        });
        selectAnchor.current = path;
        return;
      }
      selectAnchor.current = path;
      setPhoneLibrary(false);
      if (current?.path !== path) void load(path);
      else setSelected(new Set([path]));
    },
    [files, current, load],
  );

  const selectAll = useCallback(() => {
    setSelected(new Set(files.map((f) => f.path)));
  }, [files]);

  const refreshMarks = useCallback(() => {
    const paths = files.map((f) => f.path);
    if (!paths.length) {
      setMarked(new Set());
      return;
    }
    markedPhotos(paths)
      .then((m) => setMarked(new Set(m)))
      .catch(() => {});
  }, [files]);

  useEffect(refreshMarks, [refreshMarks]);

  /**
   * Flag the selection as finished, so you can move on to the next photo and
   * still find everything that is ready to export. The flag is written into
   * each photo's sidecar, which needs no decoding.
   */
  const toggleMark = useCallback(async () => {
    const paths = [...selected];
    if (!paths.length) return;
    const turningOn = !paths.every((p) => marked.has(p));
    try {
      await applyEdits(paths, { marked: turningOn });
      setMarked((prev) => {
        const next = new Set(prev);
        for (const p of paths) {
          if (turningOn) next.add(p);
          else next.delete(p);
        }
        return next;
      });
      // the open photo keeps its flag in the settings it is editing
      if (current && selected.has(current.path)) setParams((p) => ({ ...p, marked: turningOn }));
      setNotice(turningOn ? `Marked ${paths.length} for export` : `Unmarked ${paths.length}`);
    } catch (e) {
      setError(`Could not mark: ${String(e)}`);
    }
  }, [selected, marked, current]);

  const selectMarked = useCallback(() => {
    setSelected(new Set(files.map((f) => f.path).filter((p) => marked.has(p))));
  }, [files, marked]);

  /**
   * Apply a preset to every selected photo by rewriting their sidecars, which
   * needs no decoding. The open photo also gets it in the viewer, so the
   * change is visible rather than only on disk.
   */
  const applyPresetToSelection = useCallback(
    async (preset: Preset) => {
      const paths = [...selected];
      if (!paths.length) return;
      try {
        const n = await applyEdits(paths, preset.settings);
        if (current && selected.has(current.path)) setParams((p) => ({ ...p, ...preset.settings }));
        setNotice(`Applied "${preset.name}" to ${n} photo${n === 1 ? "" : "s"}`);
      } catch (e) {
        setError(`Could not apply the preset: ${String(e)}`);
      }
    },
    [selected, current],
  );

  // the menu closes on the next click, a scroll, or Escape
  useEffect(() => {
    if (!thumbMenu) return;
    const close = () => setThumbMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("wheel", close, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("wheel", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [thumbMenu]);

  const choosePhotoFolder = useCallback(async () => {
    const f = await pickFolder("Choose the folder your photos live in");
    if (!f) return;
    setPhotoFolder(f);
    try {
      localStorage.setItem(PHOTO_FOLDER_KEY, f);
    } catch {
      /* private mode */
    }
  }, []);

  const clearPhotoFolder = useCallback(() => {
    setPhotoFolder("");
    try {
      localStorage.removeItem(PHOTO_FOLDER_KEY);
    } catch {
      /* private mode */
    }
  }, []);

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

  /**
   * Show mask paints the selected mask's area red. Ticking it with nothing
   * selected used to paint nothing at all, which reads exactly like a broken
   * mask - so it picks the last ordinary mask up for you. Selecting a mask
   * shows its whole group, its subtractions included, which is the only way to
   * see whether a subtraction took.
   */
  const changeShowMask = useCallback((on: boolean) => {
    setShowMask(on);
    if (!on) return;
    setSelectedMaskId((cur) => {
      if (cur) return cur;
      const list = masksRef.current;
      for (let i = list.length - 1; i >= 0; i--) if (list[i].mode !== "subtract") return list[i].id;
      return cur;
    });
  }, []);

  const runDetectSubject = useCallback(
    async (id: string, mainOnly = true) => {
      const api = maskApiRef.current;
      const capture = captureRef.current;
      if (!api || !capture) return;
      setDetecting(true);
      try {
        const blob = await capture({ full: true });
        if (!blob) throw new Error("no picture to analyse");
        const { w, h } = api.size();
        const raster = await detectSubject(blob, w, h, mainOnly);
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
    (kind: MaskKind, mode: MaskMode = "add") => {
      const m = newMask(kind, params.masks, mode);
      // a subtraction joins the group it cuts into - the one holding the
      // selected mask - so the stack stays readable top to bottom
      const from = params.masks.findIndex((x) => x.id === selectedMaskId);
      const at =
        mode === "subtract"
          ? subtractInsertAt(params.masks, from < 0 ? params.masks.length - 1 : from)
          : params.masks.length;
      setParams((p) => {
        const masks = p.masks.slice();
        masks.splice(Math.min(at, masks.length), 0, m);
        return { ...p, masks };
      });
      setSelectedMaskId(m.id);
      setShowMask(kind !== "linear" && kind !== "radial");
      revealSection("masks");
      if (kind === "subject") void runDetectSubject(m.id);
    },
    [params.masks, selectedMaskId, runDetectSubject],
  );

  // ---- filmstrip thumbnails ----
  // Files arrive as placeholders (session restore, Browse, a tethered burst).
  // Their thumbnails are generated in the background, a few at a time, so the
  // strip fills in without anyone having to click each frame.
  const thumbSeen = useRef(new Set<string>());
  const thumbBusy = useRef(0);
  const thumbQueue = useRef<string[]>([]);

  const pumpThumbnails = useCallback(() => {
    const MAX_PARALLEL = 3;
    while (thumbBusy.current < MAX_PARALLEL && thumbQueue.current.length > 0) {
      const path = thumbQueue.current.shift()!;
      thumbBusy.current += 1;
      getThumbnail(path)
        .then((thumbnail) => {
          setFiles((prev) => prev.map((f) => (f.path === path && !f.thumbnail ? { ...f, thumbnail } : f)));
        })
        .catch(() => {
          // unreadable or unsupported file: leave the placeholder in place
        })
        .finally(() => {
          thumbBusy.current -= 1;
          pumpThumbnails();
        });
    }
  }, []);

  useEffect(() => {
    let queued = false;
    for (const f of files) {
      if (f.thumbnail || thumbSeen.current.has(f.path)) continue;
      thumbSeen.current.add(f.path);
      thumbQueue.current.push(f.path);
      queued = true;
    }
    if (queued) pumpThumbnails();
  }, [files, pumpThumbnails]);

  // ---- creative look (.cube) ----
  const loadLook = useCallback(async () => {
    setLookBusy(true);
    try {
      const picked = await pickCube();
      if (!picked) return;
      const path = await importPhoto(picked, "cube");
      const info = await openLook(path);
      const input = detectLookInput(`${info.name} ${path.split(/[\\/]/).pop() ?? ""}`);
      setParams((p) => ({ ...p, look: { enabled: true, path, name: info.name, amount: p.look.amount || 100, input } }));
    } catch (e) {
      setError(`Could not read the .cube file: ${String(e)}`);
    } finally {
      setLookBusy(false);
    }
  }, []);

  // ---- double exposure ----
  // The second picture arrives either from the file dialog or from a file
  // dragged onto the panel. Rust decodes it (RAW included) and keeps a
  // preview-sized copy; the export reads the original again at full size.
  const loadBlend = useCallback(
    async (dropped?: string) => {
      setBlendBusy(true);
      try {
        const picked = dropped ?? (await pickPhoto(extensions.length ? extensions : ["*"], photoFolder));
        if (!picked) return;
        const path = await importPhoto(picked);
        const info = await openBlend(path);
        setParams((p) => ({
          ...p,
          blend: { ...defaultBlend(), ...p.blend, enabled: true, path, name: info.name },
        }));
        setOpenSections((prev) => ({ ...prev, blend: true }));
      } catch (e) {
        setError(`Could not read that photo: ${String(e)}`);
      } finally {
        setBlendBusy(false);
      }
    },
    [extensions, photoFolder],
  );

  // Files dragged in from the desktop. Tauri owns the drag and drop, so the
  // webview never sees an HTML dragover; the pointer position comes in
  // physical pixels and is matched against the drop zone's own box.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    // While the Double Exposure section is open the whole window takes the drop
    // (see dropTarget.ts); the box is the window, not the little zone.
    const over = (x: number, y: number) =>
      dropGoesToBlend(
        blendOpenRef.current || matchOpenRef.current,
        x,
        y,
        { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight },
        window.devicePixelRatio || 1,
      );
    void getCurrentWebview()
      .onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "over" || p.type === "enter") {
          setBlendDrop(over(p.position.x, p.position.y));
        } else if (p.type === "drop") {
          const hit = over(p.position.x, p.position.y);
          setBlendDrop(false);
          // the first thing dropped that is a photo, not just the first thing
          const photo = hit ? firstPhoto(p.paths, extensions) : null;
          if (hit && p.paths.length && !photo) setError("That is not a photo NFrame Studio can open.");
          if (photo) {
            if (blendOpenRef.current) void loadBlend(photo);
            else void runToneMatchRef.current?.(photo);
          }
        } else {
          setBlendDrop(false);
        }
      })
      .then((f) => {
        if (cancelled) f();
        else un = f;
      });
    return () => {
      cancelled = true;
      un?.();
    };
  }, [loadBlend, extensions]);

  // ---- develop presets ----
  /**
   * Match the photo to a reference picture. The solver starts from the sliders
   * as they were before any earlier match, not from the matched ones, so trying
   * another reference does not build on the last.
   */
  const runToneMatch = useCallback(
    async (dropped?: string) => {
      if (!current) return;
      setMatchBusy(true);
      try {
        const picked = dropped ?? (await pickPhoto(extensions.length ? extensions : ["*"], photoFolder));
        if (!picked) return;
        const path = await importPhoto(picked);
        const before = toneMatch ? toneMatch.before : tuneOf(params);
        const base = withTune(params, before);
        const result = await matchTone(path, base, [...buildLut(base.curves)]);
        setToneMatch({ name: fileName(path), path, before, result, strength: 100 });
        setParams((p) => withTune(p, result.values));
        setOpenSections((prev) => ({ ...prev, match: true }));
      } catch (e) {
        setError(`Could not match to that picture: ${String(e)}`);
      } finally {
        setMatchBusy(false);
      }
    },
    [current, extensions, photoFolder, toneMatch, params],
  );

  runToneMatchRef.current = runToneMatch;

  const setMatchStrength = useCallback(
    (percent: number) => {
      if (!toneMatch) return;
      setToneMatch({ ...toneMatch, strength: percent });
      setParams((p) => withTune(p, blendTune(toneMatch.before, toneMatch.result.values, percent / 100)));
    },
    [toneMatch],
  );

  const clearToneMatch = useCallback(() => {
    if (!toneMatch) return;
    setParams((p) => withTune(p, toneMatch.before));
    setToneMatch(null);
  }, [toneMatch]);

  // a match belongs to the photo it was made for
  useEffect(() => {
    setToneMatch(null);
  }, [current?.path]);

  /**
   * Write the look as a .cube 3D LUT. A LUT is a colour-for-colour lookup, so it
   * can only carry what depends on a pixel's own colour; whatever had to be left
   * behind is named in the notice rather than quietly dropped.
   */
  const saveCube = useCallback(
    async (size: number) => {
      if (!current) return;
      const base = fileName(current.path).replace(/\.[^.]+$/, "");
      const out = await pickSavePath(`${base}.cube`, "cube");
      if (!out) return;
      setCubeBusy(true);
      try {
        const left = await exportCube(out, params, [...buildLut(params.curves)], size, base);
        setNotice(
          left.length
            ? `Wrote ${fileName(out)}. A LUT cannot carry ${left.join(", ")} - those stay in NFrame Studio.`
            : `Wrote ${fileName(out)}. It carries the whole look.`,
        );
      } catch (e) {
        setError(`Could not write the LUT: ${String(e)}`);
      } finally {
        setCubeBusy(false);
      }
    },
    [current, params],
  );

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
    async (x: number, y: number, path: [number, number][] = []) => {
      const spot = { ...newHealSpot(x, y, healRadius, healKind), path };
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
      } else {
        // Done means done: drop the selection too, or its ring stays on the
        // photo covering the repair it just made
        setSelectedSpotId(null);
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
  const autoEdit = useCallback(async () => {
    if (!current) return;
    try {
      const m = await autoLook(params, [...buildLut(params.curves)]);
      setParams((p) => applyAutoLook(p, m.values, current.noiseSigma));
    } catch {
      // the photo could not be read; the fixed recipe is better than nothing
      setParams((p) => applyAutoEdit(p, current.noiseSigma));
    }
    setOpenSections((prev) => ({ ...prev, tone: true, color: true, detail: true, denoise: true }));
  }, [current, params]);

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
      // a ratio is something you frame with, so show the frame
      if (ratio !== null) setCropMode(true);
      setParams((p) => ({ ...p, crop: fitAspect(ratio, current.width, current.height, { ...p.crop, enabled: true }) }));
    },
    [current],
  );

  const toggleSection = useCallback((key: InspectorKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const revealSection = useCallback((key: InspectorKey) => {
    setWorkspace(workspaceFor(key));
    setOpenSections((prev) => ({ ...prev, [key]: true }));
  }, []);

  useEffect(() => {
    if (cropMode) revealSection("crop");
  }, [cropMode, revealSection]);

  useEffect(() => {
    // the test harness drives the app through this handle; doubleExpose is
    // loadBlend without the file dialog it cannot click
    (window as unknown as { __darkroom?: unknown }).__darkroom = {
      load,
      autoEdit,
      doubleExpose: (path: string) => loadBlend(path),
      toneMatch: (path: string) => runToneMatchRef.current?.(path),
      capture: (opts?: { full?: boolean }) => captureRef.current?.(opts) ?? null,
    };
  }, [load, autoEdit, loadBlend]);

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
      if (command && (e.key === "z" || e.key === "Z")) {
        e.preventDefault();
        if (e.shiftKey) history.redo();
        else history.undo();
        return;
      }
      if (command && (e.key === "y" || e.key === "Y")) {
        e.preventDefault();
        history.redo();
        return;
      }
      if (!command && (e.key === "m" || e.key === "M") && selected.size) {
        e.preventDefault();
        void toggleMark();
        return;
      }
      if (command && (e.key === "a" || e.key === "A")) {
        e.preventDefault();
        selectAll();
        return;
      }
      if ((e.key === "Delete" || e.key === "Backspace") && selected.size && !cropMode) {
        e.preventDefault();
        removeFromFilmstrip([...selected]);
        return;
      }
      if (e.key === "\\") {
        setBefore(true);
        e.preventDefault();
      } else if (e.key === "Escape" && wbPick) {
        e.preventDefault();
        setWbPick(false);
      } else if (e.key === "Escape" && selectedMaskId && !cropMode) {
        e.preventDefault();
        setSelectedMaskId(null);
      } else if (e.key.toLowerCase() === "m" && !command && params.masks.length > 0) {
        e.preventDefault();
        changeShowMask(!showMask);
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
    history,
    selected,
    selectAll,
    removeFromFilmstrip,
    toggleMark,
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

  // ---- phone layout ----
  const phoneSections = useMemo(
    () => new Set(phoneTab ? (PHONE_TABS.find((t) => t.id === phoneTab)?.sections ?? []) : []),
    [phoneTab],
  );
  const choosePhoneTab = useCallback(
    (id: PhoneTabId) => {
      const next = phoneTab === id ? null : id;
      // crop is a mode of the viewer, not only a panel
      if ((next === "crop") !== cropMode) toggleCropMode();
      setPhoneTab(next);
      if (next) setOpenSections((prev) => ({ ...prev, [PHONE_TAB_OPENS[next]]: true }));
    },
    [phoneTab, cropMode, toggleCropMode],
  );
  const closePhoneSheet = useCallback(() => {
    if (cropMode) toggleCropMode();
    setPhoneTab(null);
  }, [cropMode, toggleCropMode]);
  // no photo open: the phone starts on its library
  const showPhoneLibrary = phone && (phoneLibrary || (!current && !loading));
  const phoneTabLabel = PHONE_TABS.find((t) => t.id === phoneTab)?.label ?? "";

  const thumbButton = (f: ImageInfo) => (
    <button
      key={f.path}
      className={
        "thumb" + (current?.path === f.path ? " active" : "") + (selected.has(f.path) ? " picked" : "")
      }
      title={f.path}
      onClick={(e) => clickThumb(f.path, e)}
      onContextMenu={(e) => {
        e.preventDefault();
        if (!selected.has(f.path)) setSelected(new Set([f.path]));
        setThumbMenu({ x: e.clientX, y: e.clientY, path: f.path });
      }}
    >
      {f.thumbnail ? <img src={f.thumbnail} alt="" /> : <span className="thumb-placeholder">…</span>}
      {marked.has(f.path) && (
        <span className="thumb-mark" title="Marked for export">
          ⚑
        </span>
      )}
      <span className="thumb-name">{fileName(f.path)}</span>
    </button>
  );

  return (
    <div className={"app" + (!stripVisible && !phone ? " strip-hidden" : "") + (phone ? " phone" : "") + (phone && phoneTab ? " sheet-open" : "")}>
      {phone && (
        <header className="phone-topbar">
          <button type="button" className="phone-icon" onClick={() => setPhoneLibrary(true)} aria-label="Photos">
            ▦
          </button>
          <div className="phone-title">
            <strong>{loading ? `Loading ${loading}…` : current ? fileName(current.path) : "NFrame Studio"}</strong>
          </div>
          <button
            type="button"
            className={"phone-icon" + (before ? " active" : "")}
            onPointerDown={() => setBefore(true)}
            onPointerUp={() => setBefore(false)}
            onPointerLeave={() => setBefore(false)}
            onPointerCancel={() => setBefore(false)}
            disabled={!current}
            aria-label="Hold to see the original"
            title="Hold to see the original"
          >
            ◧
          </button>
          <button type="button" className="phone-icon" onClick={() => rotate(90)} disabled={!current} aria-label="Rotate">
            ↻
          </button>
          <button type="button" className="phone-icon" onClick={autoEdit} disabled={!current} aria-label="Auto edit">
            ✦
          </button>
          <button className="primary phone-export" onClick={() => setShowExport(true)} disabled={!current}>
            Export
          </button>
        </header>
      )}
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">N<span className="brand-spark">✦</span></span>
          <span className="brand-copy">
            <strong>NFrame Studio</strong>
            <small>by NVision</small>
          </span>
        </div>

        <div className="file-context">
          <strong>{current ? fileName(current.path) : "No photo selected"}</strong>
          <span>{loading ? `Loading ${loading}…` : current ? metaLine(current) : "Open a RAW or bitmap image to begin"}</span>
        </div>

        <div className="top-actions">
          <span className="zoom-pill">{zoom || "Fit"}</span>
          <button
            className="icon-button"
            onClick={history.undo}
            disabled={!current || !history.canUndo}
            title="Undo (Ctrl+Z)"
          >
            ↩
          </button>
          <button
            className="icon-button"
            onClick={history.redo}
            disabled={!current || !history.canRedo}
            title="Redo (Ctrl+Shift+Z)"
          >
            ↪
          </button>
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
          <button type="button" className={workspace === "edit" && !cropMode && !healTool ? "active" : ""} onClick={() => { setCropMode(false); setHealTool(false); setSelectedMaskId(null); revealSection("tone"); }}>
            <span className="tool-glyph">☷</span><span>Edit</span>
          </button>
          <button type="button" className={cropMode ? "active" : ""} onClick={toggleCropMode} disabled={!current}>
            <span className="tool-glyph">⌗</span><span>Crop</span>
          </button>
          <button
            type="button"
            className={workspace === "masks" && !cropMode && !healTool ? "active" : ""}
            onClick={() => { setCropMode(false); setHealTool(false); revealSection("masks"); }}
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
            className={workspace === "effects" && !cropMode && !healTool ? "active" : ""}
            onClick={() => {
              setCropMode(false); setHealTool(false); setSelectedMaskId(null);
              revealSection("star");
            }}
            disabled={!current}
          >
            <span className="tool-glyph">✦</span><span>Effects</span>
          </button>
          <button
            type="button"
            className={(workspace === "connect" && !cropMode && !healTool ? "active " : "") + (tether.active || monitor?.active ? "live" : "")}
            onClick={() => {
              setCropMode(false); setHealTool(false); setSelectedMaskId(null);
              revealSection("tether");
              revealSection("monitor");
            }}
            title="Shoot into NFrame Studio and watch on a phone"
          >
            <span className="tool-glyph">⌁</span><span>Connect</span>
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
              <span className="workspace-caption">{WORKSPACES[cropMode ? "crop" : healTool ? "repair" : workspace].label} workspace</span>
            </div>
            <div className="viewer-toolbar-group">
              <button onClick={reset} disabled={!current}>Reset edit</button>
              <button type="button" onClick={() => setStripVisible((v) => !v)} aria-pressed={stripVisible} title="Toggle photo filmstrip">{stripVisible ? "Hide photos" : "Show photos"}</button>
            </div>
          </div>

          <Viewer
            image={preview}
            params={shownParams}
            beforeParams={defaults}
            lut={shownLut}
            captureRef={captureRef}
            maskApiRef={maskApiRef}
            watermarkEdit={openSections.watermark}
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
            onHistogram={(h, f) => {
              setHist(h);
              setScopeFrame(f);
            }}
            onZoom={setZoom}
          />
        </div>

        <SectionFilter.Provider value={phone ? phoneSections : WORKSPACES[cropMode ? "crop" : healTool ? "repair" : workspace].sections}>
        <aside className="panel">
          {phone && (
            <div className="sheet-head">
              <strong>{phoneTabLabel}</strong>
              <button type="button" onClick={reset} disabled={!current}>
                Reset
              </button>
              <button type="button" className="sheet-close" onClick={closePhoneSheet} aria-label="Close">
                ⌄
              </button>
            </div>
          )}
          <div className="inspector-top">
            <div>
              <strong>{WORKSPACES[cropMode ? "crop" : healTool ? "repair" : workspace].label}</strong>
              <span>{WORKSPACES[cropMode ? "crop" : healTool ? "repair" : workspace].hint}</span>
            </div>
            <button onClick={reset} disabled={!current}>Reset all</button>
          </div>

          <div className={"histogram-card" + (workspace === "connect" ? " hidden" : "")}>
            <div className="histogram-head">
              <span className="scope-tabs">
                {SCOPE_LABELS.map((s) => (
                  <button key={s.id} className={"tab" + (scope === s.id ? " active" : "")} onClick={() => setScope(s.id)}>
                    {s.label}
                  </button>
                ))}
              </span>
              {scope === "vector" ? (
                <label className="scope-skin" title="The line complexions sit on, whatever the complexion">
                  <input type="checkbox" checked={skinLine} onChange={(e) => setSkinLine(e.target.checked)} />
                  Skin
                </label>
              ) : (
                <span>{current?.metadata.iso ? `ISO ${current.metadata.iso}` : "RGB"}</span>
              )}
            </div>
            <Scopes kind={scope} hist={hist} frame={scopeFrame} skinLine={skinLine} />
          </div>

          {!phone && workspace === "effects" && !cropMode && !healTool && (
            <div className="effect-launcher" aria-label="Creative effects">
              {([ ["star", "Starburst", "✧", "Turn highlights into light"], ["mirror", "Motion Trails", "≋", "Echo movement through a mask"], ["blend", "Double Exposure", "◈", "Layer a second photograph"] ] as const).map(([key, label, glyph, hint]) => (
                <button key={key} type="button" onClick={() => { revealSection(key); window.requestAnimationFrame(() => document.querySelector(`[data-section="${label}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" })); }}>
                  <span aria-hidden="true">{glyph}</span><strong>{label}</strong><small>{hint}</small>
                </button>
              ))}
            </div>
          )}
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

          <InspectorSection title="Tone Match" open={openSections.match} onToggle={() => toggleSection("match")}>
            <ToneMatchPanel
              disabled={!current}
              busy={matchBusy}
              match={toneMatch}
              strip={files.map((f) => ({ path: f.path, name: fileName(f.path) }))}
              currentPath={current?.path ?? null}
              onPick={() => void runToneMatch()}
              onPickFromStrip={(path) => void runToneMatch(path)}
              onStrength={setMatchStrength}
              onClear={clearToneMatch}
            />
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
            <Slider label="Detail" value={params.denoiseDetail} min={0} max={100} defaultValue={35} onChange={set("denoiseDetail")} />
            <div className="hint">
              Luminance and Color decide how hard the noise is smoothed; Detail puts back whatever looks more like
              texture than noise, so turning it down removes more and turning it up keeps more. Judge fine noise at 1:1
              or in the exported file.
            </div>
          </InspectorSection>

          <InspectorSection title="Grain" open={openSections.grain} onToggle={() => toggleSection("grain")}>
            <Slider
              label="Amount"
              value={params.grain.amount}
              min={0}
              max={100}
              onChange={(v) => set("grain")({ ...params.grain, amount: v })}
            />
            <Slider
              label="Size"
              value={params.grain.size}
              min={0}
              max={100}
              defaultValue={40}
              onChange={(v) => set("grain")({ ...params.grain, size: v })}
            />
            <Slider
              label="Color"
              value={params.grain.colour}
              min={0}
              max={100}
              onChange={(v) => set("grain")({ ...params.grain, colour: v })}
            />
            <div className="hint">
              Grain is drawn at the picture's own scale, so a fit-to-window view understates it. Judge it at 1:1.
            </div>
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
              onExportCube={(size) => void saveCube(size)}
              cubeBusy={cubeBusy}
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
              // Choosing Heal or Clone is choosing to retouch, so it starts the tool.
              // It only set the mode before, and tapping it looked like nothing
              // had happened.
              onKind={(k) => {
                setHealKind(k);
                if (!healTool) toggleHealTool();
              }}
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
              onShowMask={changeShowMask}
              onBrush={setBrush}
              onDetectSubject={(id, mainOnly) => void runDetectSubject(id, mainOnly)}
            />
          </InspectorSection>

          <InspectorSection title="Motion Trails" open={openSections.mirror} onToggle={() => toggleSection("mirror")}>
            <label className="feature-toggle">
              <span>
                <strong>Enable trails</strong>
                <small>Directional echoes of a masked subject, or of the whole frame. No AI manipulation.</small>
              </span>
              <input
                type="checkbox"
                checked={params.mirror.enabled}
                onChange={(e) => set("mirror")({ ...params.mirror, enabled: e.target.checked, mask: trailMask(params) })}
              />
            </label>
            <MirrorPanel mirror={params.mirror} masks={params.masks} onChange={set("mirror")} />
          </InspectorSection>

          <InspectorSection
            title="Double Exposure"
            open={openSections.blend}
            onToggle={() => toggleSection("blend")}
            note={params.blend.path ? <span className="section-note">1</span> : undefined}
          >
            <div ref={blendZone}>
              <DoubleExposurePanel
                blend={params.blend}
                busy={blendBusy}
                dropping={blendDrop}
                strip={files.map((f) => ({ path: f.path, name: fileName(f.path) }))}
                currentPath={current?.path ?? null}
                onPick={() => void loadBlend()}
                onPickFromStrip={(path) => void loadBlend(path)}
                onChange={set("blend")}
              />
            </div>
          </InspectorSection>

          <InspectorSection title="Vignette" open={openSections.vignette} onToggle={() => toggleSection("vignette")}>
            <label className="feature-toggle">
              <span>
                <strong>Enable vignette</strong>
                <small>Darken or lighten towards the corners. Follows the crop.</small>
              </span>
              <input
                type="checkbox"
                checked={params.vignette.enabled}
                onChange={(e) => set("vignette")({ ...params.vignette, enabled: e.target.checked })}
              />
            </label>
            <VignettePanel vignette={params.vignette} onChange={set("vignette")} />
          </InspectorSection>

          <InspectorSection title="Starburst" open={openSections.star} onToggle={() => toggleSection("star")}>
            <label className="feature-toggle">
              <span>
                <strong>Enable starburst</strong>
                <small>A cross-screen lens filter: highlights grow stars. No AI manipulation.</small>
              </span>
              <input
                type="checkbox"
                checked={params.star.enabled}
                onChange={(e) => set("star")({ ...params.star, enabled: e.target.checked })}
              />
            </label>
            <StarPanel star={params.star} onChange={set("star")} masks={params.masks} />
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
        </SectionFilter.Provider>
      </div>

      {phone && (
        <nav className="phone-tabs" aria-label="Edit tools">
          {PHONE_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={phoneTab === t.id ? "active" : ""}
              onClick={() => choosePhoneTab(t.id)}
              disabled={!current}
            >
              <span className="tool-glyph">{t.glyph}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </nav>
      )}

      {showPhoneLibrary && (
        <div className="phone-library">
          <header>
            <div>
              <strong>Photos</strong>
              <span>{files.length ? `${files.length} photo${files.length === 1 ? "" : "s"}` : "Nothing open yet"}</span>
            </div>
            <button type="button" className="phone-icon" onClick={() => setShowAbout(true)} aria-label="Settings">
              ⚙
            </button>
            {current && (
              <button type="button" onClick={() => setPhoneLibrary(false)}>
                Done
              </button>
            )}
          </header>
          <button type="button" className="primary phone-open" onClick={openFiles}>
            + Open photos
          </button>
          <div className="phone-library-grid">{files.map(thumbButton)}</div>
          {files.length > 0 && <div className="hint">Press and hold a photo to remove it.</div>}
        </div>
      )}

      <footer className="filmstrip">
        <div className="filmstrip-summary">
          <div className="filmstrip-count">
            <span className="filmstrip-grid">▦</span>
            <span>
              {files.length === 0
                ? "No photos open"
                : `${currentIndex >= 0 ? currentIndex + 1 : 0} of ${files.length} photo${files.length === 1 ? "" : "s"}`}
            </span>
          </div>
          {files.length > 0 && (
            <div className="filmstrip-actions">
              <div className="filmstrip-selected">
                {selected.size} selected
                <button type="button" className="tab" onClick={selectAll} title="Ctrl+A">
                  All
                </button>
              </div>
              <button
                type="button"
                className={selected.size && [...selected].every((p) => marked.has(p)) ? "active" : ""}
                onClick={() => void toggleMark()}
                disabled={!selected.size}
                title="Flag as finished and ready to export (M)"
              >
                ⚑ Mark
              </button>
              <button
                type="button"
                className="tab"
                onClick={selectMarked}
                disabled={!marked.size}
                title="Select everything flagged for export"
              >
                Marked {marked.size || ""}
              </button>
              <button type="button" onClick={() => setBatchExport([...selected])} disabled={!selected.size}>
                Export {selected.size > 1 ? selected.size : ""}…
              </button>
              <select
                className="filmstrip-preset"
                value=""
                disabled={!selected.size || !presets.length}
                title={presets.length ? "Apply a preset to the selected photos" : "Save a preset first"}
                onChange={(e) => {
                  const p = presets.find((x) => x.name === e.target.value);
                  e.currentTarget.value = "";
                  if (p) void applyPresetToSelection(p);
                }}
              >
                <option value="">Apply preset…</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="tab"
                onClick={() => removeFromFilmstrip([...selected])}
                disabled={!selected.size}
                title="Take them out of the filmstrip. The files stay on disk."
              >
                Remove
              </button>
            </div>
          )}
        </div>
        <div className="filmstrip-track">
          {files.length === 0 && <span className="hint">Browse to open RAW, JPEG, PNG, or TIFF images.</span>}
          {files.map(thumbButton)}
        </div>
      </footer>

      {thumbMenu && (
        <div
          className="thumb-menu"
          style={
            thumbMenu.y > 180
              ? { left: Math.min(thumbMenu.x, window.innerWidth - 220), top: thumbMenu.y - 8 }
              : { left: Math.min(thumbMenu.x, window.innerWidth - 220), top: thumbMenu.y + 8, transform: "none" }
          }
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="thumb-menu-path" title={thumbMenu.path}>
            {selected.size > 1 ? `${selected.size} photos` : fileName(thumbMenu.path)}
          </div>
          <button
            type="button"
            onClick={() => removeFromFilmstrip(selected.size > 1 ? [...selected] : [thumbMenu.path])}
          >
            Remove from filmstrip
          </button>
          <div className="thumb-menu-note">The file stays on disk.</div>
        </div>
      )}

      {!showAbout && <UpdateBanner status={updater.status} onInstall={updater.install} onDismiss={updater.dismiss} />}
      {showAbout && (
        <AboutDialog
          version={version}
          status={updater.status}
          canUpdate={platformInfo.updates}
          os={platformInfo.os}
          photoFolder={photoFolder}
          onPickPhotoFolder={() => void choosePhotoFolder()}
          onClearPhotoFolder={clearPhotoFolder}
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
      {batchExport && current && (
        <ExportDialog image={current} params={params} batch={batchExport} onClose={() => setBatchExport(null)} />
      )}
      {notice && (
        <div className="toast notice" onClick={() => setNotice(null)}>
          {notice}
        </div>
      )}
    </div>
  );
}
