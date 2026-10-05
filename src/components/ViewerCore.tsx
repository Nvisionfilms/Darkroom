import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Renderer, type View } from "../gl/Renderer";
import { getBlendPixels, getLookPixels, getWatermarkPixels, openBlend, openLook, openWatermark } from "../api";
import {
  brushRaster,
  decodeRaster,
  emptyRect,
  f16ToNumber,
  maskGroupAlpha,
  rectValid,
  strokeStart,
  strokeTo,
  type BrushSettings,
  type StrokeCursor,
} from "../mask";
import { canvasToSource, makeWarp, sourceToCanvas, warpIsIdentity } from "../geometry";
import { healKey, healPlane, MAX_PATH, resamplePath } from "../heal";
import {
  cropIsIdentity,
  type Crop,
  type EditParams,
  type HealSpot,
  type Histogram,
  type Mask,
  type Mirror,
  type PreviewImage,
  type Stroke,
  type Watermark,
} from "../types";
import type { GuideKind } from "./CropGuides";
import { CropOverlay } from "./CropOverlay";
import { HealOverlay } from "./HealOverlay";
import { MaskOverlay } from "./MaskOverlay";
import { MirrorOverlay, type Mapper } from "./MirrorOverlay";
import { WatermarkOverlay } from "./WatermarkOverlay";

/**
 * Renders the developed picture and returns it as a JPEG. By default the
 * crop and rotation are applied (what the user sees); `full` gives the whole
 * unrotated image, which mask rasters need.
 */
export type CaptureFn = (opts?: { full?: boolean }) => Promise<Blob | null>;

/** Access to mask rasters held by the renderer (subject detection writes through this). */
export interface MaskApi {
  size(): { w: number; h: number };
  setRaster(id: string, data: Uint8Array, key: string): void;
}

/** Long edge of the picture sent to the phone monitor. */
const CAPTURE_MAX_EDGE = 1600;

interface Props {
  image: PreviewImage | null;
  params: EditParams;
  lut: Float32Array;
  /** filled in with a CaptureFn while the viewer is mounted (phone monitor) */
  captureRef?: React.MutableRefObject<CaptureFn | null>;
  maskApiRef?: React.MutableRefObject<MaskApi | null>;
  /**
   * Filled in with the image-to-screen mapping while the viewer is mounted, for
   * a parent that has to line something up with the photo on screen - the
   * Motion Trails compositor lining a mask up with it. `needMapper` asks for it
   * to be built even when no tool of this viewer's own needs it.
   */
  mapperRef?: React.MutableRefObject<Mapper | null>;
  needMapper?: boolean;
  /** mask being edited: its handles are shown and it can be painted */
  selectedMaskId?: string | null;
  /** paint the selected mask's weight in red */
  showMask?: boolean;
  brush?: BrushSettings;
  onMaskChange?: (m: Mask) => void;
  /** white-balance eyedropper: next click reports the linear colour under it */
  wbPick?: boolean;
  onPickWb?: (rgb: [number, number, number]) => void;
  guide?: GuideKind;
  guideFlip?: number;
  /** show the watermark's frame and handles: it is being placed right now */
  watermarkEdit?: boolean;
  /** object remover: clicking the photo places a spot */
  healTool?: boolean;
  healRadius?: number;
  selectedSpotId?: string | null;
  onSelectSpot?: (id: string | null) => void;
  /** `path` is the drag, in normalised image coordinates; a click gives one point */
  onAddSpot?: (x: number, y: number, path: [number, number][]) => void;
  onSpotChange?: (s: HealSpot) => void;
  /** clockwise degrees, applied even in before/after mode */
  rotation: number;
  /** when set, the mirror window handles are drawn and editable */
  mirror?: Mirror | null;
  onMirrorChange?: (m: Mirror) => void;
  watermark?: Watermark | null;
  onWatermarkChange?: (w: Watermark) => void;
  crop?: Crop | null;
  cropMode?: boolean;
  cropAspect?: number | null;
  onCropChange?: (c: Crop) => void;
  onHistogram: (h: Histogram, frame: { data: Uint8Array; width: number; height: number } | null) => void;
  onZoom: (label: string) => void;
}

/** Rotation-aware mapping between image pixels and display pixels (see Renderer.draw). */
function rotationCoeffs(rotation: number, W: number, H: number) {
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      return { px: [0, -H, H], py: [W, 0, 0] };
    case 180:
      return { px: [-W, 0, W], py: [0, -H, H] };
    case 270:
      return { px: [0, H, 0], py: [-W, 0, W] };
    default:
      return { px: [W, 0, 0], py: [0, H, 0] };
  }
}

export function Viewer({
  image,
  params,
  lut,
  captureRef,
  maskApiRef,
  mapperRef: outerMapperRef,
  needMapper = false,
  selectedMaskId = null,
  showMask = false,
  brush,
  onMaskChange,
  wbPick = false,
  onPickWb,
  guide = "thirds",
  guideFlip = 0,
  healTool = false,
  watermarkEdit = false,
  healRadius = 0.03,
  selectedSpotId = null,
  onSelectSpot,
  onAddSpot,
  onSpotChange,
  rotation,
  mirror,
  onMirrorChange,
  watermark,
  onWatermarkChange,
  crop,
  cropMode = false,
  cropAspect = null,
  onCropChange,
  onHistogram,
  onZoom,
}: Props) {
  const [overlayTick, setOverlayTick] = useState(0);
  const [wmAspect, setWmAspect] = useState(1);
  const wmLoaded = useRef("");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
  const fitRef = useRef(true);
  const rotRef = useRef(0);
  rotRef.current = rotation;
  const cropRef = useRef<Crop | null>(null);
  cropRef.current = crop ?? null;
  const cropModeRef = useRef(false);
  cropModeRef.current = cropMode;
  const paramsRef = useRef(params);
  paramsRef.current = params;
  // lens + perspective geometry, recomputed only when its inputs change
  const warp = useMemo(
    () => (image ? makeWarp(params.transform, params.lens, params.lensProfile, image.width, image.height) : null),
    [image, params.transform, params.lens, params.lensProfile],
  );
  const warpRef = useRef(warp);
  warpRef.current = warp;
  const showMaskId = showMask && selectedMaskId ? selectedMaskId : null;
  const showMaskRef = useRef<string | null>(null);
  showMaskRef.current = showMaskId;
  const selectedMask: Mask | null = selectedMaskId ? (params.masks.find((m) => m.id === selectedMaskId) ?? null) : null;
  const mapperRef = useRef<Mapper | null>(null);
  /** strokes array each brush raster was built from (reference equality) */
  const brushCache = useRef(new Map<string, Stroke[]>());
  /** raster data URL each subject raster was decoded from */
  const rasterKey = useRef(new Map<string, string>());
  const paint = useRef<{
    id: string;
    stroke: Stroke;
    cursor: StrokeCursor;
    data: Uint8Array;
    settings: BrushSettings;
    w: number;
    h: number;
  } | null>(null);
  const [brushPos, setBrushPos] = useState<[number, number] | null>(null);
  const developDirty = useRef(true);
  const frame = useRef<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dragging = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);

  const dpr = () => window.devicePixelRatio || 1;

  const zoomLabel = useCallback(() => {
    const r = rendererRef.current;
    if (!r || !r.imgW) return "";
    const pct = Math.round((viewRef.current.scale / dpr()) * 100);
    return fitRef.current ? `Fit (${pct}%)` : `${pct}%`;
  }, []);

  const fit = useCallback(() => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    if (!r || !c || !r.imgW) return;
    const d = r.displaySize(rotRef.current, cropRef.current, cropModeRef.current);
    const s = Math.min(c.width / d.w, c.height / d.h);
    viewRef.current = {
      scale: s,
      x: (c.width - d.w * s) / 2,
      y: (c.height - d.h * s) / 2,
    };
    fitRef.current = true;
  }, []);

  const clampView = useCallback(() => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    if (!r || !c) return;
    const v = viewRef.current;
    const d = r.displaySize(rotRef.current, cropRef.current, cropModeRef.current);
    const w = d.w * v.scale;
    const h = d.h * v.scale;
    if (w <= c.width) v.x = (c.width - w) / 2;
    else v.x = Math.min(0, Math.max(c.width - w, v.x));
    if (h <= c.height) v.y = (c.height - h) / 2;
    else v.y = Math.min(0, Math.max(c.height - h, v.y));
  }, []);

  const zoom100 = useCallback(() => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    if (!r || !c || !r.imgW) return;
    const v = viewRef.current;
    const ns = dpr(); // one preview image pixel per CSS pixel
    const mx = c.width / 2;
    const my = c.height / 2;
    const kk = ns / Math.max(1e-6, v.scale);
    v.x = mx - (mx - v.x) * kk;
    v.y = my - (my - v.y) * kk;
    v.scale = ns;
    fitRef.current = false;
    clampView();
  }, [clampView]);

  // The render closure captures the latest props, but is reached through a
  // ref so that requestRender (and every effect that depends on it) stays
  // stable across slider changes. Otherwise the image/rotation effects would
  // re-run on each edit and reset the zoom.
  const renderRef = useRef<() => void>(() => {});
  renderRef.current = () => {
    const r = rendererRef.current;
    if (!r) return;
    // shaders still compiling on the driver's background thread: retry soon
    let ok = true;
    try {
      ok = r.ready();
    } catch (e) {
      setError(String(e));
      return;
    }
    if (!ok) {
      onZoom("Preparing GPU…");
      window.setTimeout(() => requestRender(), 60);
      return;
    }
    if (developDirty.current) {
      r.runDevelop(params, showMaskRef.current);
      developDirty.current = false;
      histPending.current = true;
    }
    r.draw(viewRef.current, params.sharpen, rotRef.current, cropRef.current, cropModeRef.current, warpRef.current);
    onZoom(zoomLabel());
    if (mirror?.enabled || watermark?.enabled || cropMode || selectedMaskId || wbPick) setOverlayTick((t) => t + 1);
    // read the histogram only once the GPU is done, so the UI never waits on it
    if (histPending.current) {
      if (r.histogramReady()) {
        histPending.current = false;
        onHistogram(r.readHistogram(), r.scopeFrame());
      } else {
        requestRender();
      }
    }
  };
  const histPending = useRef(false);

  const requestRender = useCallback(() => {
    if (frame.current === null) {
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        renderRef.current();
      });
    }
  }, []);

  // create renderer once
  useEffect(() => {
    const canvas = canvasRef.current!;
    try {
      rendererRef.current = new Renderer(canvas);
      // only the main viewer claims the debug hook; the Before comparison
      // layer would otherwise overwrite it with its own renderer
      if (captureRef) (window as unknown as { __renderer?: Renderer }).__renderer = rendererRef.current;
    } catch (e) {
      setError(String(e));
      return;
    }
    const wrap = wrapRef.current!;
    const resize = () => {
      const d = dpr();
      const w = Math.max(1, Math.round(wrap.clientWidth * d));
      const h = Math.max(1, Math.round(wrap.clientHeight * d));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        if (fitRef.current) fit();
        else clampView();
        requestRender();
      }
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();
    return () => {
      ro.disconnect();
      rendererRef.current?.dispose();
      rendererRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // image changed
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (image) {
      r.setImage(image);
      fit();
    }
    developDirty.current = true;
    requestRender();
  }, [image, fit, requestRender]);

  // lut changed
  useEffect(() => {
    rendererRef.current?.setLut(lut);
    developDirty.current = true;
    requestRender();
  }, [lut, requestRender]);

  // params changed
  useEffect(() => {
    developDirty.current = true;
    requestRender();
  }, [params, requestRender]);

  // the area a masked starburst takes its lights from
  const starMaskId = params.star.enabled ? params.star.mask : "";
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !image || !r.imgW) return;
    if (!starMaskId) {
      r.setStarMask(null, 1, 1);
      developDirty.current = true;
      requestRender();
      return;
    }
    let cancelled = false;
    const long = 384;
    const gw = r.imgW >= r.imgH ? long : Math.max(1, Math.round((long * r.imgW) / r.imgH));
    const gh = r.imgW >= r.imgH ? Math.max(1, Math.round((long * r.imgH) / r.imgW)) : long;
    r.setStarMask(null, 1, 1); // nothing until the mask is ready
    maskGroupAlpha(params.masks, starMaskId, gw, gh, null).then((a) => {
      const rr = rendererRef.current;
      if (cancelled || !rr) return;
      rr.setStarMask(a ? a.data : null, gw, gh);
      developDirty.current = true;
      requestRender();
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [starMaskId, params.masks, image, requestRender]);

  // mask overlay (red) on/off or a different mask selected
  useEffect(() => {
    developDirty.current = true;
    requestRender();
  }, [showMaskId, requestRender]);

  // keep the renderer's brush/subject rasters in step with the mask list
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !image || !r.imgW) return;
    let dirty = false;
    const { w, h } = r.maskSize();
    for (const m of params.masks) {
      if (m.kind === "brush") {
        if (!r.hasRaster(m.id) || brushCache.current.get(m.id) !== m.strokes) {
          r.setMaskRaster(m.id, brushRaster(m.strokes, w, h));
          brushCache.current.set(m.id, m.strokes);
          dirty = true;
        }
      } else if (m.kind === "subject" && m.raster) {
        if (!r.hasRaster(m.id) || rasterKey.current.get(m.id) !== m.raster) {
          const key = m.raster;
          rasterKey.current.set(m.id, key);
          decodeRaster(key, w, h)
            .then((data) => {
              const rr = rendererRef.current;
              if (!rr || rasterKey.current.get(m.id) !== key) return;
              rr.setMaskRaster(m.id, data);
              developDirty.current = true;
              requestRender();
            })
            .catch(() => {});
        }
      }
    }
    if (dirty) {
      developDirty.current = true;
      requestRender();
    }
  }, [params.masks, image, requestRender]);

  // creative look: parse the .cube on the Rust side and upload the lattice
  const lookPath = params.look.path;
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (!lookPath) {
      r.setLook("", 0, null);
      developDirty.current = true;
      requestRender();
      return;
    }
    if (r.hasLook(lookPath)) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await openLook(lookPath);
        const px = await getLookPixels();
        if (cancelled || !rendererRef.current) return;
        rendererRef.current.setLook(lookPath, info.size, px);
        developDirty.current = true;
        requestRender();
      } catch (e) {
        if (!cancelled) setError(`Could not load the look: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lookPath, requestRender]);

  // double exposure: decode the second picture on the Rust side and upload it
  const blendPath = params.blend.path;
  useEffect(() => {
    const r = rendererRef.current;
    if (!r) return;
    if (!blendPath) {
      r.setBlend("", 0, 0, null);
      developDirty.current = true;
      requestRender();
      return;
    }
    if (r.hasBlend(blendPath)) return;
    let cancelled = false;
    (async () => {
      try {
        const info = await openBlend(blendPath);
        const px = await getBlendPixels();
        if (cancelled || !rendererRef.current) return;
        rendererRef.current.setBlend(blendPath, info.width, info.height, px);
        developDirty.current = true;
        requestRender();
      } catch (e) {
        if (!cancelled) setError(`Could not load the second photo: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [blendPath, requestRender]);

  // object remover: hand the spots and their colour matches to the renderer
  const spotsKey = healKey(params.heal);
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || !image) return;
    const offsets = params.heal.map((s) => healPlane(image, s));
    r.setHeal(params.heal, offsets, spotsKey);
    developDirty.current = true;
    requestRender();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotsKey, image, requestRender]);

  // let the app push rasters in (subject detection)
  useEffect(() => {
    if (!maskApiRef) return;
    maskApiRef.current = {
      size: () => rendererRef.current?.maskSize() ?? { w: 1, h: 1 },
      setRaster: (id, data, key) => {
        const r = rendererRef.current;
        if (!r) return;
        r.setMaskRaster(id, data);
        rasterKey.current.set(id, key);
        developDirty.current = true;
        requestRender();
      },
    };
    return () => {
      maskApiRef.current = null;
    };
  }, [maskApiRef, requestRender]);

  // ---- brush painting ----
  const brushDown = (e: React.PointerEvent) => {
    const r = rendererRef.current;
    const mp = mapperRef.current;
    const m = selectedMask;
    if (e.button !== 0 || !r || !mp || !m || m.kind !== "brush" || !brush) return;
    e.stopPropagation();
    e.preventDefault();
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const [ix, iy] = mp.toImage(e.clientX - rect.left, e.clientY - rect.top);
    const { w, h } = r.maskSize();
    let data = r.getRaster(m.id);
    if (!data) {
      data = brushRaster(m.strokes, w, h);
      r.setMaskRaster(m.id, data);
      brushCache.current.set(m.id, m.strokes);
    }
    const settings: BrushSettings = { ...brush, erase: brush.erase !== e.altKey };
    const nx = ix / r.imgW;
    const ny = iy / r.imgH;
    const dirty = emptyRect();
    const cursor = strokeStart(data, w, h, settings, nx, ny, dirty);
    if (rectValid(dirty)) r.updateMaskRaster(m.id, dirty);
    paint.current = {
      id: m.id,
      stroke: { x: [nx], y: [ny], size: settings.size, feather: settings.feather, flow: settings.flow, erase: settings.erase },
      cursor,
      data,
      settings,
      w,
      h,
    };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
    developDirty.current = true;
    requestRender();
  };
  const brushMove = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    setBrushPos([e.clientX - rect.left, e.clientY - rect.top]);
    const p = paint.current;
    const r = rendererRef.current;
    const mp = mapperRef.current;
    if (!p || !r || !mp) return;
    e.stopPropagation();
    const [ix, iy] = mp.toImage(e.clientX - rect.left, e.clientY - rect.top);
    const nx = ix / r.imgW;
    const ny = iy / r.imgH;
    const dirty = emptyRect();
    strokeTo(p.data, p.w, p.h, p.settings, p.cursor, nx, ny, dirty);
    p.stroke.x.push(nx);
    p.stroke.y.push(ny);
    if (rectValid(dirty)) {
      r.updateMaskRaster(p.id, dirty);
      developDirty.current = true;
      requestRender();
    }
  };
  const brushUp = (e: React.PointerEvent) => {
    const p = paint.current;
    if (!p) return;
    e.stopPropagation();
    paint.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const m = paramsRef.current.masks.find((x) => x.id === p.id);
    if (!m || !onMaskChange) return;
    const strokes = [...m.strokes, p.stroke];
    brushCache.current.set(m.id, strokes); // the raster already contains this stroke
    onMaskChange({ ...m, strokes });
  };

  // ---- object remover: click to place a spot, or drag to paint one ----
  // A drag records the path the brush swept, so a wire or a line marking can be
  // followed instead of being covered with a row of circles. A click is just a
  // path of one point, which is the disc it always was.
  const paintSpot = useRef<[number, number][] | null>(null);
  const spotPoint = (e: React.PointerEvent): [number, number] | null => {
    const mp = mapperRef.current;
    const r = rendererRef.current;
    if (!mp || !r) return null;
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const [ix, iy] = mp.toImage(e.clientX - rect.left, e.clientY - rect.top);
    if (ix < 0 || iy < 0 || ix >= r.imgW || iy >= r.imgH) return null;
    return [ix / r.imgW, iy / r.imgH];
  };
  const spotDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !onAddSpot) return;
    const p = spotPoint(e);
    if (!p) return;
    e.stopPropagation();
    e.preventDefault();
    paintSpot.current = [p];
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
  };
  const spotMove = (e: React.PointerEvent) => {
    const path = paintSpot.current;
    if (!path) return;
    e.stopPropagation();
    const p = spotPoint(e);
    if (!p) return;
    const last = path[path.length - 1];
    // a point every third of a brush width keeps the path light
    const step = Math.max(healRadius * 0.6, 0.002);
    if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= step) path.push(p);
  };
  const spotUp = (e: React.PointerEvent) => {
    const path = paintSpot.current;
    if (!path) return;
    e.stopPropagation();
    paintSpot.current = null;
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    const simple = resamplePath(path, MAX_PATH);
    const mid = simple[Math.floor(simple.length / 2)];
    onAddSpot?.(mid[0], mid[1], simple.length > 1 ? simple : []);
  };

  // ---- white balance eyedropper ----
  const pickWb = (e: React.MouseEvent) => {
    const mp = mapperRef.current;
    const r = rendererRef.current;
    if (!mp || !r || !image || !onPickWb) return;
    e.stopPropagation();
    const rect = (e.currentTarget as Element).getBoundingClientRect();
    const [ix, iy] = mp.toImage(e.clientX - rect.left, e.clientY - rect.top);
    const W = image.width;
    const H = image.height;
    const cx = Math.round(ix);
    const cy = Math.round(iy);
    if (cx < 0 || cy < 0 || cx >= W || cy >= H) return;
    let rr = 0;
    let gg = 0;
    let bb = 0;
    let n = 0;
    for (let y = Math.max(0, cy - 2); y <= Math.min(H - 1, cy + 2); y++) {
      for (let x = Math.max(0, cx - 2); x <= Math.min(W - 1, cx + 2); x++) {
        const i = (y * W + x) * 3;
        rr += f16ToNumber(image.data[i]);
        gg += f16ToNumber(image.data[i + 1]);
        bb += f16ToNumber(image.data[i + 2]);
        n++;
      }
    }
    if (n > 0) onPickWb([rr / n, gg / n, bb / n]);
  };

  // watermark file changed: decode it in Rust and upload the pixels
  const wmPath = watermark?.path ?? "";
  useEffect(() => {
    const r = rendererRef.current;
    if (!r || wmLoaded.current === wmPath) return;
    if (!wmPath) {
      wmLoaded.current = "";
      r.setWatermark("", 1, 1, null);
      developDirty.current = true;
      requestRender();
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const info = await openWatermark(wmPath);
        const px = await getWatermarkPixels();
        if (cancelled || !rendererRef.current) return;
        rendererRef.current.setWatermark(wmPath, info.width, info.height, px);
        wmLoaded.current = wmPath;
        setWmAspect(info.width / Math.max(1, info.height));
        developDirty.current = true;
        requestRender();
      } catch (e) {
        if (!cancelled) setError(`Could not load watermark: ${String(e)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [wmPath, requestRender]);

  // crop mode or crop output size changed: refit
  const cropKey = crop ? `${cropMode}|${cropIsIdentity(crop)}|${crop.w.toFixed(4)}|${crop.h.toFixed(4)}|${crop.angle}` : "";
  useEffect(() => {
    fit();
    requestRender();
  }, [cropKey, fit, requestRender]);

  // rotation changed: refit so the whole image stays visible
  useEffect(() => {
    fit();
    requestRender();
  }, [rotation, fit, requestRender]);

  // Phone monitor: draw a fit view, copy the picture out, then put the user's
  // own view straight back. All of it happens before the frame is composited,
  // so nothing flickers on screen.
  useEffect(() => {
    if (!captureRef) return;
    captureRef.current = (opts) =>
      new Promise<Blob | null>((resolve) => {
        const r = rendererRef.current;
        const c = canvasRef.current;
        let ok = false;
        try {
          ok = !!r && !!c && r.imgW > 0 && r.ready();
        } catch {
          ok = false;
        }
        if (!ok || !r || !c) {
          resolve(null);
          return;
        }
        const p = paramsRef.current;
        const full = !!opts?.full;
        if (developDirty.current || showMaskRef.current) {
          // the phone/subject picture must never carry the red mask overlay
          r.runDevelop(p, null);
          developDirty.current = !!showMaskRef.current;
          histPending.current = true;
        }
        const rot = full ? 0 : rotRef.current;
        const crop = full ? null : cropRef.current;
        const d = r.displaySize(rot, crop, false);
        const s = Math.min(c.width / d.w, c.height / d.h);
        const fitView: View = { scale: s, x: (c.width - d.w * s) / 2, y: (c.height - d.h * s) / 2 };
        r.draw(fitView, p.sharpen, rot, crop, false, warpRef.current);
        const w = Math.max(1, Math.round(d.w * s));
        const h = Math.max(1, Math.round(d.h * s));
        const k = Math.min(1, CAPTURE_MAX_EDGE / Math.max(w, h));
        const out = document.createElement("canvas");
        out.width = Math.max(1, Math.round(w * k));
        out.height = Math.max(1, Math.round(h * k));
        const ctx = out.getContext("2d");
        if (ctx) {
          ctx.drawImage(c, fitView.x, fitView.y, w, h, 0, 0, out.width, out.height);
          out.toBlob((b) => resolve(b), "image/jpeg", 0.86);
        } else {
          resolve(null);
        }
        if (showMaskRef.current) r.runDevelop(p, showMaskRef.current);
        developDirty.current = false;
        r.draw(viewRef.current, p.sharpen, rotRef.current, cropRef.current, cropModeRef.current, warpRef.current);
      });
    return () => {
      captureRef.current = null;
    };
  }, [captureRef]);

  // Controls outside the WebGL canvas (the mockup-style Fit / 100% buttons)
  // use one event so both Before and After canvases stay aligned.
  useEffect(() => {
    const onZoomRequest = (event: Event) => {
      const mode = (event as CustomEvent<"fit" | "100">).detail;
      if (mode === "fit") fit();
      else if (mode === "100") zoom100();
      else return;
      requestRender();
    };
    window.addEventListener("darkroom:zoom", onZoomRequest as EventListener);
    return () => window.removeEventListener("darkroom:zoom", onZoomRequest as EventListener);
  }, [fit, zoom100, requestRender]);

  /** Zoom by `k` about a point on screen (client px). Wheel and pinch share it. */
  const zoomAbout = (k: number, clientX: number, clientY: number) => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    if (!r || !c || !r.imgW) return;
    const rect = c.getBoundingClientRect();
    const d = dpr();
    const mx = (clientX - rect.left) * d;
    const my = (clientY - rect.top) * d;
    const v = viewRef.current;
    const dsz = r.displaySize(rotRef.current, cropRef.current, cropModeRef.current);
    const fitScale = Math.min(c.width / dsz.w, c.height / dsz.h);
    const ns = Math.max(fitScale * 0.25, Math.min(8 * d, v.scale * k));
    const kk = ns / v.scale;
    v.x = mx - (mx - v.x) * kk;
    v.y = my - (my - v.y) * kk;
    v.scale = ns;
    fitRef.current = false;
    clampView();
    requestRender();
  };

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomAbout(Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  };

  // Two fingers pinch to zoom and pan together. A mouse only ever has one
  // pointer, so the desktop never reaches this.
  const touches = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ dist: number; mx: number; my: number } | null>(null);
  const pinchState = () => {
    const [a, b] = [...touches.current.values()];
    return { dist: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    if (touches.current.size === 2) {
      // a second finger turns the drag into a pinch
      dragging.current = null;
      pinch.current = pinchState();
      return;
    }
    if (touches.current.size > 2) return;
    dragging.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (touches.current.has(e.pointerId)) touches.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const p = pinch.current;
    if (p && touches.current.size === 2) {
      const now = pinchState();
      if (p.dist > 0) zoomAbout(now.dist / p.dist, now.mx, now.my);
      const d = dpr();
      viewRef.current.x += (now.mx - p.mx) * d;
      viewRef.current.y += (now.my - p.my) * d;
      clampView();
      requestRender();
      pinch.current = now;
      return;
    }
    const dgg = dragging.current;
    if (!dgg) return;
    const d = dpr();
    viewRef.current.x = dgg.vx + (e.clientX - dgg.x) * d;
    viewRef.current.y = dgg.vy + (e.clientY - dgg.y) * d;
    fitRef.current = false;
    clampView();
    requestRender();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    touches.current.delete(e.pointerId);
    if (touches.current.size < 2) pinch.current = null;
    // lifting one finger of a pinch should not jump into a drag
    dragging.current = null;
  };
  const onDoubleClick = () => {
    if (fitRef.current) zoom100();
    else fit();
    requestRender();
  };

  // mapper for the overlay (recomputed each render; overlayTick forces updates after pan/zoom)
  let mapper: Mapper | null = null;
  const rr = rendererRef.current;
  const maskTool = !cropMode && !!selectedMask;
  // The rings are the tool's handles, so they go when the tool does. Leaving
  // them up after Done hid the very repair they had just made, which read as
  // the repair not having happened at all.
  const healActive = !cropMode && (healTool || (!!selectedSpotId && params.heal.length > 0));
  if (
    (cropMode || needMapper || mirror?.enabled || (watermarkEdit && watermark?.enabled && watermark.path) || maskTool || wbPick || healActive) &&
    rr &&
    rr.imgW &&
    image
  ) {
    void overlayTick;
    const d = dpr();
    const v = viewRef.current;
    const W = rr.imgW;
    const H = rr.imgH;
    const out = rr.cropSize(crop, cropMode);
    const active = !!crop && crop.enabled && !cropIsIdentity(crop);
    const ang = active ? (crop!.angle * Math.PI) / 180 : 0;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const cx = W / 2;
    const cy = H / 2;
    const x0 = active && !cropMode ? Math.max(0, Math.min(1, crop!.x)) * W : 0;
    const y0 = active && !cropMode ? Math.max(0, Math.min(1, crop!.y)) * H : 0;
    const { px, py } = rotationCoeffs(rotation, out.w, out.h);
    // straightened-canvas coords -> screen
    const canvasToScreen = (sx: number, sy: number): [number, number] => {
      const u = (sx - x0) / out.w;
      const vv = (sy - y0) / out.h;
      const dx = px[0] * u + px[1] * vv + px[2];
      const dy = py[0] * u + py[1] * vv + py[2];
      return [(v.x + dx * v.scale) / d, (v.y + dy * v.scale) / d];
    };
    const screenToCanvas = (sxs: number, sys: number): [number, number] => {
      const dx = (sxs * d - v.x) / v.scale;
      const dy = (sys * d - v.y) / v.scale;
      let u: number;
      let vv: number;
      switch (((rotation % 360) + 360) % 360) {
        case 90:
          u = dy / out.w;
          vv = 1 - dx / out.h;
          break;
        case 180:
          u = 1 - dx / out.w;
          vv = 1 - dy / out.h;
          break;
        case 270:
          u = 1 - dy / out.w;
          vv = dx / out.h;
          break;
        default:
          u = dx / out.w;
          vv = dy / out.h;
      }
      return [x0 + u * out.w, y0 + vv * out.h];
    };
    // source coords <-> canvas coords: the lens/perspective warp (when any is
    // active), then the straighten rotation about the centre
    const wp = warp && !warpIsIdentity(warp) ? warp : null;
    const toScreen = (ix: number, iy: number): [number, number] => {
      const [wx, wy] = wp ? sourceToCanvas(wp, ix, iy) : [ix, iy];
      const rx = wx - cx;
      const ry = wy - cy;
      return canvasToScreen(cx + ca * rx + sa * ry, cy - sa * rx + ca * ry);
    };
    const toImage = (sxs: number, sys: number): [number, number] => {
      const [sx, sy] = screenToCanvas(sxs, sys);
      const rx = sx - cx;
      const ry = sy - cy;
      const px = cx + ca * rx - sa * ry;
      const py = cy + sa * rx + ca * ry;
      return wp ? canvasToSource(wp, px, py) : [px, py];
    };
    mapper = {
      toScreen,
      toImage,
      canvasToScreen,
      screenToCanvas,
      outX: x0,
      outY: y0,
      outW: out.w,
      outH: out.h,
      scale: v.scale / d,
      screenRotation: (((rotation % 360) + 360) % 360) - (active ? crop!.angle : 0),
      width: W,
      height: H,
    };
  }
  mapperRef.current = mapper;
  if (outerMapperRef) outerMapperRef.current = mapper;
  const brushRadiusCss = mapper && brush ? ((brush.size * Math.max(mapper.width, mapper.height)) / 2) * mapper.scale : 0;

  return (
    <div
      ref={wrapRef}
      className="viewer"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={(e) => {
        if (healTool) {
          const r = (e.currentTarget as Element).getBoundingClientRect();
          setBrushPos([e.clientX - r.left, e.clientY - r.top]);
        }
        onPointerMove(e);
      }}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} />
      {mapper && cropMode && crop && onCropChange && (
        <CropOverlay crop={crop} aspect={cropAspect} mapper={mapper} guide={guide} guideFlip={guideFlip} onChange={onCropChange} />
      )}
      {mapper && maskTool && selectedMask && onMaskChange && (selectedMask.kind === "linear" || selectedMask.kind === "radial") && (
        <MaskOverlay mask={selectedMask} mapper={mapper} onChange={onMaskChange} />
      )}
      {mapper && maskTool && selectedMask?.kind === "brush" && brush && (
        <svg
          className="mirror-overlay brush-overlay"
          onPointerDown={brushDown}
          onPointerMove={brushMove}
          onPointerUp={brushUp}
          onPointerCancel={brushUp}
          onPointerLeave={() => setBrushPos(null)}
        >
          <rect className="brush-surface" x={0} y={0} width="100%" height="100%" />
          {brushPos && (
            <circle cx={brushPos[0]} cy={brushPos[1]} r={brushRadiusCss} className={"brush-cursor" + (brush.erase ? " erase" : "")} />
          )}
        </svg>
      )}
      {mapper && healActive && onSpotChange && onSelectSpot && (
        <svg className={"mirror-overlay heal-overlay" + (healTool ? " placing" : "")}>
          {healTool && (
            <rect
              className="heal-surface"
              x={0}
              y={0}
              width="100%"
              height="100%"
              onPointerDown={spotDown}
              onPointerMove={spotMove}
              onPointerUp={spotUp}
              onPointerCancel={spotUp}
            />
          )}
          <HealOverlay
            spots={params.heal}
            selectedId={selectedSpotId}
            mapper={mapper}
            onSelect={onSelectSpot}
            onChange={onSpotChange}
          />
          {healTool && brushPos && (
            <circle
              cx={brushPos[0]}
              cy={brushPos[1]}
              r={healRadius * Math.max(mapper.width, mapper.height) * mapper.scale}
              className="heal-cursor"
            />
          )}
        </svg>
      )}
      {mapper && wbPick && (
        <svg className="mirror-overlay wb-overlay" onClick={pickWb}>
          <rect className="wb-surface" x={0} y={0} width="100%" height="100%" />
        </svg>
      )}
      {mapper && !cropMode && mirror?.enabled && onMirrorChange && (
        <MirrorOverlay mirror={mirror} mapper={mapper} onChange={onMirrorChange} />
      )}
      {mapper && !cropMode && watermarkEdit && watermark?.enabled && watermark.path && onWatermarkChange && (
        <WatermarkOverlay watermark={watermark} aspect={wmAspect} mapper={mapper} onChange={onWatermarkChange} />
      )}
      {error && <div className="viewer-error">{error}</div>}
      {!image && !error && (
        <div className="viewer-empty">
          <div className="viewer-empty-title">Darkroom</div>
          <div>Open a RAW (CR2, CR3, ARW, NEF, DNG, RAF…), JPEG, PNG or TIFF to begin.</div>
          <div className="hint">Ctrl+O to open · scroll to zoom · drag to pan · double-click for 1:1 · hold \ for before</div>
        </div>
      )}
    </div>
  );
}
