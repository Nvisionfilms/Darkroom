import { useEffect, useMemo, useRef, useState } from "react";
import type { ComponentProps } from "react";
import { buildLut } from "../curve";
import { cropIsIdentity, defaultParams } from "../types";
import { Viewer as CoreViewer } from "./ViewerCore";
import "./MotionTrail.css";

type Props = ComponentProps<typeof CoreViewer>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Viewer shell for two UI-only features:
 * 1) a persistent display-space Motion Trails preview, stored in the legacy
 *    `mirror` sidecar fields for compatibility; and
 * 2) the draggable Before / After split from the Darkroom workspace mockup.
 *
 * Motion Trails intentionally repeats the whole developed image today. A
 * subject/region mask is a separate feature; the current effect does not use
 * segmentation or generative AI.
 */
export function Viewer(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const sourceCacheRef = useRef<HTMLCanvasElement | null>(null);
  const sourceCacheValidRef = useRef(false);
  const [comparePosition, setComparePosition] = useState(50);
  const [zoomLabel, setZoomLabel] = useState("Fit");
  const trail = props.mirror ?? props.params.mirror;

  // The legacy mirror shader/window must stay off. Motion Trails are composited
  // by this wrapper from the finished developed preview instead.
  const coreParams = trail.enabled
    ? { ...props.params, mirror: { ...props.params.mirror, enabled: false } }
    : props.params;

  const beforeParams = useMemo(() => defaultParams(), []);
  const beforeLut = useMemo(() => buildLut(beforeParams.curves), [beforeParams]);

  useEffect(() => {
    sourceCacheValidRef.current = false;
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

      const ctx = overlay.getContext("2d");
      if (!ctx) return;
      const W = source.width;
      const H = source.height;
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

      // At Fit zoom, keep the repeated copies inside the actual photo rectangle
      // instead of allowing the image to ghost into the surrounding workspace.
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
        ctx.beginPath();
        ctx.rect((W - dw) / 2, (H - dh) / 2, dw, dh);
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
        ctx.drawImage(cache, dx * distance * t, dy * distance * t);
      }
      ctx.restore();
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
    trail.opacity,
    props.image,
    props.crop,
    props.cropMode,
    props.rotation,
    zoomLabel,
  ]);

  const updateCompare = (clientX: number) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    setComparePosition(clamp(((clientX - rect.left) / rect.width) * 100, 0, 100));
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
    // The two preview canvases are guaranteed pixel-aligned at Fit. If the user
    // starts panning/zooming, collapse to After rather than show a misleading
    // misaligned comparison.
    if (label && !label.startsWith("Fit") && comparePosition > 0 && comparePosition < 100) {
      setComparePosition(0);
    }
  };

  return (
    <div className="motion-trail-viewer compare-viewer" ref={wrapRef}>
      <div className="motion-trail-edited">
        <CoreViewer {...props} params={coreParams} mirror={null} onMirrorChange={undefined} onZoom={handleZoom} />
      </div>

      <canvas ref={overlayRef} className="motion-trail-preview" aria-hidden="true" />

      {props.image && comparePosition > 0 && (
        <div className="compare-before-layer" style={{ clipPath: `inset(0 ${100 - comparePosition}% 0 0)` }}>
          <CoreViewer
            {...props}
            params={beforeParams}
            lut={beforeLut}
            mirror={null}
            onMirrorChange={undefined}
            watermark={null}
            onWatermarkChange={undefined}
            cropMode={false}
            onHistogram={() => {}}
            onZoom={() => {}}
          />
        </div>
      )}

      {props.image && (
        <>
          <div className="compare-tabs" aria-label="Before and after comparison">
            <button type="button" className={comparePosition === 100 ? "active" : ""} onClick={() => setComparePosition(100)}>
              Before
            </button>
            <button type="button" className={comparePosition === 0 ? "active" : ""} onClick={() => setComparePosition(0)}>
              After
            </button>
          </div>
          {comparePosition > 0 && comparePosition < 100 && (
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
