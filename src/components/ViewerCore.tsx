import { useCallback, useEffect, useRef, useState } from "react";
import { Renderer, type View } from "../gl/Renderer";
import { getWatermarkPixels, openWatermark } from "../api";
import { cropIsIdentity, type Crop, type EditParams, type Histogram, type Mirror, type PreviewImage, type Watermark } from "../types";
import { CropOverlay } from "./CropOverlay";
import { MirrorOverlay, type Mapper } from "./MirrorOverlay";
import { WatermarkOverlay } from "./WatermarkOverlay";

interface Props {
  image: PreviewImage | null;
  params: EditParams;
  lut: Float32Array;
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
  onHistogram: (h: Histogram) => void;
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
      r.runDevelop(params);
      developDirty.current = false;
      histPending.current = true;
    }
    r.draw(viewRef.current, params.sharpen, rotRef.current, cropRef.current, cropModeRef.current);
    onZoom(zoomLabel());
    if (mirror?.enabled || watermark?.enabled || cropMode) setOverlayTick((t) => t + 1);
    // read the histogram only once the GPU is done, so the UI never waits on it
    if (histPending.current) {
      if (r.histogramReady()) {
        histPending.current = false;
        onHistogram(r.readHistogram());
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
      (window as unknown as { __renderer?: Renderer }).__renderer = rendererRef.current;
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

  const onWheel = (e: React.WheelEvent) => {
    const r = rendererRef.current;
    const c = canvasRef.current;
    if (!r || !c || !r.imgW) return;
    e.preventDefault();
    const rect = c.getBoundingClientRect();
    const d = dpr();
    const mx = (e.clientX - rect.left) * d;
    const my = (e.clientY - rect.top) * d;
    const v = viewRef.current;
    const dsz = r.displaySize(rotRef.current, cropRef.current, cropModeRef.current);
    const fitScale = Math.min(c.width / dsz.w, c.height / dsz.h);
    const k = Math.exp(-e.deltaY * 0.0015);
    const ns = Math.max(fitScale * 0.25, Math.min(8 * d, v.scale * k));
    const kk = ns / v.scale;
    v.x = mx - (mx - v.x) * kk;
    v.y = my - (my - v.y) * kk;
    v.scale = ns;
    fitRef.current = false;
    clampView();
    requestRender();
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    dragging.current = { x: e.clientX, y: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const dgg = dragging.current;
    if (!dgg) return;
    const d = dpr();
    viewRef.current.x = dgg.vx + (e.clientX - dgg.x) * d;
    viewRef.current.y = dgg.vy + (e.clientY - dgg.y) * d;
    fitRef.current = false;
    clampView();
    requestRender();
  };
  const onPointerUp = () => {
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
  if ((cropMode || mirror?.enabled || (watermark?.enabled && watermark.path)) && rr && rr.imgW && image) {
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
    // source coords <-> canvas coords (rotate about the centre by the straighten angle)
    const toScreen = (ix: number, iy: number): [number, number] => {
      const rx = ix - cx;
      const ry = iy - cy;
      return canvasToScreen(cx + ca * rx + sa * ry, cy - sa * rx + ca * ry);
    };
    const toImage = (sxs: number, sys: number): [number, number] => {
      const [sx, sy] = screenToCanvas(sxs, sys);
      const rx = sx - cx;
      const ry = sy - cy;
      return [cx + ca * rx - sa * ry, cy + sa * rx + ca * ry];
    };
    mapper = {
      toScreen,
      toImage,
      canvasToScreen,
      screenToCanvas,
      scale: v.scale / d,
      screenRotation: (((rotation % 360) + 360) % 360) - (active ? crop!.angle : 0),
      width: W,
      height: H,
    };
  }

  return (
    <div
      ref={wrapRef}
      className="viewer"
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
    >
      <canvas ref={canvasRef} />
      {mapper && cropMode && crop && onCropChange && (
        <CropOverlay crop={crop} aspect={cropAspect} mapper={mapper} onChange={onCropChange} />
      )}
      {mapper && !cropMode && mirror?.enabled && onMirrorChange && (
        <MirrorOverlay mirror={mirror} mapper={mapper} onChange={onMirrorChange} />
      )}
      {mapper && !cropMode && watermark?.enabled && watermark.path && onWatermarkChange && (
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
