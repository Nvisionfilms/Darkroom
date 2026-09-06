import { useEffect, useRef } from "react";
import type { ComponentProps } from "react";
import { Viewer as CoreViewer } from "./ViewerCore";
import "./MotionTrail.css";

type Props = ComponentProps<typeof CoreViewer>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * Compatibility note: motion-trail settings still live in `params.mirror` so
 * existing .drk.json sidecars keep loading. The old mirror renderer is disabled
 * here; this wrapper draws repeated, directional ghost echoes over the finished
 * preview instead.
 */
export function Viewer(props: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const trail = props.mirror ?? props.params.mirror;

  // Never let the legacy mirror shader/window draw. The wrapper below owns the
  // effect now, while the wire key remains `mirror` for sidecar compatibility.
  const coreParams = trail.enabled
    ? { ...props.params, mirror: { ...props.params.mirror, enabled: false } }
    : props.params;

  useEffect(() => {
    const wrap = wrapRef.current;
    const overlay = overlayRef.current;
    if (!wrap || !overlay || !trail.enabled || trail.opacity <= 0) {
      if (overlay) {
        const ctx = overlay.getContext("2d");
        ctx?.clearRect(0, 0, overlay.width, overlay.height);
      }
      return;
    }

    let raf = 0;
    let lastFrame = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      // 30 fps is plenty for an effect preview and avoids making pan/zoom heavy.
      if (now - lastFrame < 33) return;
      lastFrame = now;

      const source = wrap.querySelector(".viewer canvas") as HTMLCanvasElement | null;
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
      ctx.globalCompositeOperation = "screen";
      ctx.imageSmoothingEnabled = true;

      // Draw far echoes first so the nearest copies read as a motion sequence.
      for (let i = copies; i >= 1; i--) {
        const t = i / copies;
        const alpha = opacity * amount * Math.pow(fadeRetention, i - 1) * 0.72;
        if (alpha <= 0.002) continue;
        ctx.globalAlpha = alpha;
        ctx.filter = blurPx > 0.1 ? `blur(${(blurPx * (0.35 + t * 0.65)).toFixed(2)}px)` : "none";
        ctx.drawImage(source, dx * distance * t, dy * distance * t);
      }
      ctx.restore();
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [trail.enabled, trail.cx, trail.ry, trail.rx, trail.length, trail.direction, trail.feather, trail.opacity]);

  return (
    <div className="motion-trail-viewer" ref={wrapRef}>
      <CoreViewer {...props} params={coreParams} mirror={null} onMirrorChange={undefined} />
      <canvas ref={overlayRef} className="motion-trail-preview" aria-hidden="true" />
    </div>
  );
}
