import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { buildLut } from "../curve";
import { maskGroupAlpha, maskGroupKey, type AlphaMap } from "../mask";
import { cropIsIdentity, defaultParams, type EditParams } from "../types";
import { Viewer as CoreViewer } from "./ViewerCore";
import "./MotionTrail.css";

type Props = ComponentProps<typeof CoreViewer> & {
  /** Neutral/source defaults used by the Before side of the comparison. */
  beforeParams?: EditParams;
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Long edge of the grid a trail mask is rasterised on. */
const ALPHA_EDGE = 768;

/** A weight map as a white canvas whose alpha is the weight. */
function alphaCanvas(a: AlphaMap): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = a.w;
  c.height = a.h;
  const g = c.getContext("2d")!;
  const img = g.createImageData(a.w, a.h);
  for (let i = 0; i < a.w * a.h; i++) {
    img.data[i * 4] = 255;
    img.data[i * 4 + 1] = 255;
    img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = a.data[i];
  }
  g.putImageData(img, 0, 0);
  return c;
}

/** The developed luminance inside `b`, resampled onto an `aw` x `ah` grid. */
function lumaOf(src: HTMLCanvasElement, b: { x: number; y: number; w: number; h: number }, aw: number, ah: number): Uint8Array | null {
  const c = document.createElement("canvas");
  c.width = aw;
  c.height = ah;
  const g = c.getContext("2d", { willReadFrequently: true });
  if (!g) return null;
  g.drawImage(src, b.x, b.y, b.w, b.h, 0, 0, aw, ah);
  const d = g.getImageData(0, 0, aw, ah).data;
  const out = new Uint8Array(aw * ah);
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.round(d[i * 4] * 0.2126 + d[i * 4 + 1] * 0.7152 + d[i * 4 + 2] * 0.0722);
  }
  return out;
}

type PhotoRect = { x: number; y: number; w: number; h: number };

/**
 * Viewer shell for two UI-only features:
 * 1) a persistent display-space Motion Trails preview, stored in the legacy
 *    `mirror` sidecar fields for compatibility; and
 * 2) the draggable Before / After split from the Darkroom workspace mockup.
 *
 * Motion Trails echoes the developed image. Pointed at a mask it echoes only
 * that mask's area and leaves the area itself alone, so a trail streaks out
 * from behind a selected subject while the subject keeps all of its detail.
 * Every echo is a translated copy of pixels that are already there; this
 * effect does not use generative AI.
 *
 * The preview composites in viewer-canvas space, so the mask is lined up with
 * the fitted photo rectangle. At Fit - where the effect is judged - that is
 * exact; zoomed in it is approximate, and the export is always exact.
 */
export function Viewer(props: Props) {
  const { beforeParams: beforeOverride, ...coreProps } = props;
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sourceCacheRef = useRef<HTMLCanvasElement | null>(null);
  const maskedSourceRef = useRef<HTMLCanvasElement | null>(null);
  const subjectRef = useRef<HTMLCanvasElement | null>(null);
  // the trail mask, rasterised once per change rather than once per frame
  const maskAlphaRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const maskBuildingRef = useRef("");
  const sourceCacheValidRef = useRef(false);
  // every photo opens on the edited picture; Before and Split are there when
  // you want them, and the top bar has hold-for-before
  const [comparePosition, setComparePosition] = useState(0);
  const lastSplitPositionRef = useRef(50);
  const [zoomLabel, setZoomLabel] = useState("Fit");
  const trail = props.mirror ?? props.params.mirror;

  // The legacy mirror shader/window must stay off. Motion Trails are composited
  // by this wrapper from the finished developed preview instead.
  const coreParams = trail.enabled
    ? { ...props.params, mirror: { ...props.params.mirror, enabled: false } }
    : props.params;

  const fallbackBefore = useMemo(() => defaultParams(), []);
  const beforeParams = beforeOverride ?? fallbackBefore;
  const beforeLut = useMemo(() => buildLut(beforeParams.curves), [beforeParams]);

  useEffect(() => {
    sourceCacheValidRef.current = false;
    // Every newly loaded image starts with the visible 50/50 comparison. The
    // previous implementation could remain collapsed after a zoom/pan.
    if (props.image) {
      setComparePosition(0);
      lastSplitPositionRef.current = 50;
    }
  }, [props.image]);

  useEffect(() => {
    const wrap = wrapRef.current;
    const overlay = overlayRef.current;
    if (!wrap || !overlay || !trail.enabled || trail.opacity <= 0) {
      if (overlay) overlay.getContext("2d")?.clearRect(0, 0, overlay.width, overlay.height);
      return;
    }

    let raf = 0;
    let lastFrame = 0;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // A 30 fps trail compositor is responsive enough for slider drags without
      // forcing the underlying RAW renderer to redraw continuously.
      if (now - lastFrame < 33) return;
      lastFrame = now;

      const source = wrap.querySelector(".motion-trail-edited > .viewer canvas") as HTMLCanvasElement | null;
      if (!source || !source.width || !source.height) return;

      if (overlay.width !== source.width || overlay.height !== source.height) {
        overlay.width = source.width;
        overlay.height = source.height;
      }
      const rect = source.getBoundingClientRect();
      const wrapRect = wrap.getBoundingClientRect();
      overlay.style.left = `${rect.left - wrapRect.left}px`;
      overlay.style.top = `${rect.top - wrapRect.top}px`;
      overlay.style.width = `${rect.width}px`;
      overlay.style.height = `${rect.height}px`;

      // WebGL uses preserveDrawingBuffer=false for performance, so the browser
      // may discard the source framebuffer after presentation. Cache the last
      // valid frame instead of clearing the trails when that happens.
      let cache = sourceCacheRef.current;
      if (!cache) {
        cache = document.createElement("canvas");
        sourceCacheRef.current = cache;
      }
      if (cache.width !== source.width || cache.height !== source.height) {
        cache.width = source.width;
        cache.height = source.height;
        sourceCacheValidRef.current = false;
      }
      const cacheCtx = cache.getContext("2d", { willReadFrequently: true });
      if (!cacheCtx) return;

      const probe = document.createElement("canvas");
      probe.width = source.width;
      probe.height = source.height;
      const probeCtx = probe.getContext("2d", { willReadFrequently: true });
      if (probeCtx) {
        probeCtx.drawImage(source, 0, 0);
        const points = [
          [0.5, 0.5],
          [0.25, 0.25],
          [0.75, 0.25],
          [0.25, 0.75],
          [0.75, 0.75],
        ];
        const valid = points.some(([px, py]) => {
          const x = Math.max(0, Math.min(source.width - 1, Math.round(px * (source.width - 1))));
          const y = Math.max(0, Math.min(source.height - 1, Math.round(py * (source.height - 1))));
          return probeCtx.getImageData(x, y, 1, 1).data[3] > 0;
        });
        if (valid) {
          cacheCtx.clearRect(0, 0, cache.width, cache.height);
          cacheCtx.drawImage(probe, 0, 0);
          sourceCacheValidRef.current = true;
        }
      }
      if (!sourceCacheValidRef.current) return;

      const W = source.width;
      const H = source.height;

      // At Fit zoom the WebGL canvas is larger than many portrait/landscape
      // photos, so its black workspace margins are NOT the photo boundaries.
      // Calculate the actual displayed photo rectangle and use those bounds for
      // both trail clipping and edge feathering. This is what removes the hard
      // left/right seam on portrait images as well as the top/bottom seam.
      let photoRect: PhotoRect | null = null;
      if (zoomLabel.startsWith("Fit") && props.image) {
        let iw = props.image.width;
        let ih = props.image.height;
        if (props.crop?.enabled && !props.cropMode && !cropIsIdentity(props.crop)) {
          iw *= Math.max(0.01, props.crop.w);
          ih *= Math.max(0.01, props.crop.h);
        }
        if (((props.rotation % 360) + 360) % 360 === 90 || ((props.rotation % 360) + 360) % 360 === 270) {
          [iw, ih] = [ih, iw];
        }
        const fit = Math.min(W / Math.max(1, iw), H / Math.max(1, ih));
        const dw = iw * fit;
        const dh = ih * fit;
        photoRect = { x: (W - dw) / 2, y: (H - dh) / 2, w: dw, h: dh };
      }

      const bounds: PhotoRect = photoRect ?? { x: 0, y: 0, w: W, h: H };

      // Feather the source-frame boundaries before translating copies. When
      // fitted, feather the actual photo rectangle rather than the full viewer
      // canvas; otherwise portrait images still showed hard left/right seams.
      let trailSource: HTMLCanvasElement = cache;
      const edgeFeather = clamp(trail.offset, 0, 0.25);
      if (edgeFeather > 0.001) {
        let masked = maskedSourceRef.current;
        if (!masked) {
          masked = document.createElement("canvas");
          maskedSourceRef.current = masked;
        }
        if (masked.width !== source.width || masked.height !== source.height) {
          masked.width = source.width;
          masked.height = source.height;
        }
        const mctx = masked.getContext("2d");
        if (mctx) {
          const f = Math.min(edgeFeather, 0.49);
          mctx.clearRect(0, 0, W, H);
          mctx.globalCompositeOperation = "source-over";
          mctx.globalAlpha = 1;
          mctx.filter = "none";
          mctx.drawImage(cache, 0, 0);
          mctx.globalCompositeOperation = "destination-in";

          const gx = mctx.createLinearGradient(bounds.x, 0, bounds.x + bounds.w, 0);
          gx.addColorStop(0, "rgba(255,255,255,0)");
          gx.addColorStop(f, "rgba(255,255,255,1)");
          gx.addColorStop(1 - f, "rgba(255,255,255,1)");
          gx.addColorStop(1, "rgba(255,255,255,0)");
          mctx.fillStyle = gx;
          mctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);

          const gy = mctx.createLinearGradient(0, bounds.y, 0, bounds.y + bounds.h);
          gy.addColorStop(0, "rgba(255,255,255,0)");
          gy.addColorStop(f, "rgba(255,255,255,1)");
          gy.addColorStop(1 - f, "rgba(255,255,255,1)");
          gy.addColorStop(1, "rgba(255,255,255,0)");
          mctx.fillStyle = gy;
          mctx.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
          mctx.globalCompositeOperation = "source-over";
          trailSource = masked;
        }
      }

      const ctx = overlay.getContext("2d");
      if (!ctx) return;

      // A trail cut from a mask: rasterise the mask's area once and keep it
      // until the mask or the fitted rectangle changes.
      let maskCanvas: HTMLCanvasElement | null = null;
      if (trail.mask) {
        const key = `${maskGroupKey(props.params.masks, trail.mask)}@${Math.round(bounds.w)}x${Math.round(bounds.h)}`;
        if (!key.startsWith("@")) {
          const cached = maskAlphaRef.current;
          if (cached && cached.key === key) maskCanvas = cached.canvas;
          else if (maskBuildingRef.current !== key) {
            maskBuildingRef.current = key;
            const landscape = bounds.w >= bounds.h;
            const aw = Math.max(1, Math.round(landscape ? ALPHA_EDGE : (ALPHA_EDGE * bounds.w) / Math.max(1, bounds.h)));
            const ah = Math.max(1, Math.round(landscape ? (ALPHA_EDGE * bounds.h) / Math.max(1, bounds.w) : ALPHA_EDGE));
            // luminance masks read the developed picture, so sample it on the
            // same grid the mask is being built on
            const lum = lumaOf(cache, bounds, aw, ah);
            void maskGroupAlpha(props.params.masks, trail.mask, aw, ah, lum).then((a) => {
              if (maskBuildingRef.current !== key) return;
              maskAlphaRef.current = a ? { key, canvas: alphaCanvas(a) } : null;
            });
          }
        }
        if (!maskCanvas) {
          // nothing to streak from yet, or the mask is gone: show no trail
          // rather than a stale one
          ctx.clearRect(0, 0, overlay.width, overlay.height);
          return;
        }
        let subj = subjectRef.current;
        if (!subj) {
          subj = document.createElement("canvas");
          subjectRef.current = subj;
        }
        if (subj.width !== W || subj.height !== H) {
          subj.width = W;
          subj.height = H;
        }
        const sctx = subj.getContext("2d");
        if (sctx) {
          sctx.clearRect(0, 0, W, H);
          sctx.globalCompositeOperation = "source-over";
          sctx.globalAlpha = 1;
          sctx.filter = "none";
          sctx.drawImage(trailSource, 0, 0);
          sctx.globalCompositeOperation = "destination-in";
          sctx.drawImage(maskCanvas, bounds.x, bounds.y, bounds.w, bounds.h);
          sctx.globalCompositeOperation = "source-over";
          trailSource = subj;
        }
      }

      const long = Math.max(W, H);
      const copies = Math.round(clamp(trail.cx * 10, 1, 8));
      const amount = clamp(trail.ry, 0, 1);
      const opacity = clamp(trail.opacity / 100, 0, 1);
      const fade = clamp(trail.feather / 100, 0, 1);
      const fadeRetention = 0.2 + fade * 0.78;
      const distance = clamp(trail.length, 0, 0.7) * long;
      const angle = (trail.direction * Math.PI) / 180;
      const dx = Math.cos(angle);
      const dy = Math.sin(angle);
      const cssScale = rect.width > 0 ? W / rect.width : 1;
      const blurPx = clamp(trail.rx, 0, 1) * 14 * cssScale;

      ctx.clearRect(0, 0, W, H);
      ctx.save();

      if (photoRect) {
        ctx.beginPath();
        ctx.rect(photoRect.x, photoRect.y, photoRect.w, photoRect.h);
        ctx.clip();
      }

      ctx.globalCompositeOperation = "screen";
      ctx.imageSmoothingEnabled = true;
      for (let i = copies; i >= 1; i--) {
        const t = i / copies;
        const alpha = opacity * amount * Math.pow(fadeRetention, i - 1) * 0.72;
        if (alpha <= 0.002) continue;
        ctx.globalAlpha = alpha;
        ctx.filter = blurPx > 0.1 ? `blur(${(blurPx * (0.35 + t * 0.65)).toFixed(2)}px)` : "none";
        ctx.drawImage(trailSource, dx * distance * t, dy * distance * t);
      }
      ctx.restore();

      if (maskCanvas) {
        // the subject keeps its own pixels, which is what keeps it sharp: the
        // trail only shows around it (twin of motion_trail_pass in export.rs)
        ctx.globalCompositeOperation = "destination-out";
        ctx.globalAlpha = 1;
        ctx.filter = "none";
        ctx.drawImage(maskCanvas, bounds.x, bounds.y, bounds.w, bounds.h);
        ctx.globalCompositeOperation = "source-over";
      }
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [
    trail.enabled,
    trail.cx,
    trail.ry,
    trail.rx,
    trail.length,
    trail.direction,
    trail.feather,
    trail.offset,
    trail.opacity,
    trail.mask,
    props.params.masks,
    props.image,
    props.crop,
    props.cropMode,
    props.rotation,
    zoomLabel,
  ]);

  const updateCompare = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const next = clamp(((clientX - rect.left) / rect.width) * 100, 0, 100);
    setComparePosition(next);
    if (next > 0 && next < 100) lastSplitPositionRef.current = next;
  };

  const onDividerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    updateCompare(e.clientX);
  };

  const onDividerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    e.preventDefault();
    e.stopPropagation();
    updateCompare(e.clientX);
  };

  const handleZoom = (label: string) => {
    setZoomLabel(label || "Fit");
    props.onZoom(label);
    // Do not collapse the comparison while the GPU is preparing. That message
    // was the reason the divider disappeared on first launch and only appeared
    // after reopening. Collapse only after a real user zoom/pan reports N%.
    const actualManualZoom = /^\d+%$/.test(label.trim());
    if (actualManualZoom && comparePosition > 0 && comparePosition < 100) {
      lastSplitPositionRef.current = comparePosition;
      setComparePosition(0);
    }
  };

  const requestZoom = (mode: "fit" | "100") => {
    window.dispatchEvent(new CustomEvent("darkroom:zoom", { detail: mode }));
  };

  const showBefore = () => setComparePosition(100);
  const showAfter = () => setComparePosition(0);
  const showSplit = () => setComparePosition(clamp(lastSplitPositionRef.current, 1, 99));

  // Crop and comparison are both direct-manipulation overlays. Letting both sit
  // on top of the photo at once makes the crop handles disappear under the
  // Before layer and makes the divider feel attached to a crop edge. While Crop
  // mode is active, temporarily hide comparison UI/layers and preserve the
  // previous split position so it returns when the user presses Done.
  const comparisonActive = !!props.image && !props.cropMode;

  return (
    <div className="motion-trail-viewer compare-viewer" ref={wrapRef}>
      <div className="motion-trail-edited">
        <CoreViewer {...coreProps} params={coreParams} mirror={null} onMirrorChange={undefined} onZoom={handleZoom} />
      </div>

      <canvas ref={overlayRef} className="motion-trail-preview" aria-hidden="true" />

      {comparisonActive && comparePosition > 0 && (
        <div className="compare-before-layer" style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}>
          <CoreViewer
            {...coreProps}
            captureRef={undefined}
            maskApiRef={undefined}
            selectedMaskId={null}
            wbPick={false}
            params={beforeParams}
            lut={beforeLut}
            mirror={null}
            onMirrorChange={undefined}
            watermark={null}
            onWatermarkChange={undefined}
            cropMode={false}
            onCropChange={undefined}
            onHistogram={() => {}}
            onZoom={() => {}}
          />
        </div>
      )}

      {props.image && (
        <>
          {comparisonActive && (
            <div className="compare-tabs" aria-label="Before, split, and after comparison">
              <button type="button" className={comparePosition === 100 ? "active" : ""} onClick={showBefore}>
                Before
              </button>
              <button
                type="button"
                className={comparePosition > 0 && comparePosition < 100 ? "active" : ""}
                onClick={showSplit}
              >
                Split
              </button>
              <button type="button" className={comparePosition === 0 ? "active" : ""} onClick={showAfter}>
                After
              </button>
            </div>
          )}
          <div className="compare-zoom-actions" aria-label="Viewer zoom">
            <button type="button" onClick={() => requestZoom("fit")}>Fit</button>
            <button type="button" onClick={() => requestZoom("100")}>100%</button>
          </div>
          {comparisonActive && comparePosition > 0 && comparePosition < 100 && (
            <div
              className="compare-divider-hit"
              style={{ left: `${comparePosition}%` }}
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
              onPointerCancel={(e) => e.currentTarget.releasePointerCapture(e.pointerId)}
            >
              <span className="compare-divider-line" />
              <span className="compare-divider-handle">‹›</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}
