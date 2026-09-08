import { useRef } from "react";
import type { Mask } from "../types";
import type { Mapper } from "./MirrorOverlay";

interface Props {
  mask: Mask;
  mapper: Mapper;
  onChange: (m: Mask) => void;
}

type Handle = "a" | "b" | "mid" | "center" | "rx" | "ry" | "rot";

/**
 * On-canvas handles for linear and radial masks. Brush painting is handled
 * in the viewer itself (it needs the renderer); luminance and subject masks
 * have no geometry to drag.
 */
export function MaskOverlay({ mask, mapper, onChange }: Props) {
  const drag = useRef<{ handle: Handle; el: Element; start: Mask; sx: number; sy: number } | null>(null);
  const { width: W, height: H } = mapper;
  const long = Math.max(W, H);

  const local = (e: React.PointerEvent): [number, number] => {
    const svg = (e.currentTarget as SVGElement).closest("svg")!;
    const r = svg.getBoundingClientRect();
    return mapper.toImage(e.clientX - r.left, e.clientY - r.top);
  };

  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const [sx, sy] = local(e);
    drag.current = { handle, el: e.currentTarget as Element, start: mask, sx, sy };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic */
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const [ix, iy] = local(e);
    const s = d.start;
    const dx = (ix - d.sx) / W;
    const dy = (iy - d.sy) / H;
    switch (d.handle) {
      case "a":
        onChange({ ...mask, x0: ix / W, y0: iy / H });
        break;
      case "b":
        onChange({ ...mask, x1: ix / W, y1: iy / H });
        break;
      case "mid":
        onChange({ ...mask, x0: s.x0 + dx, y0: s.y0 + dy, x1: s.x1 + dx, y1: s.y1 + dy });
        break;
      case "center":
        onChange({ ...mask, cx: s.cx + dx, cy: s.cy + dy });
        break;
      case "rx":
      case "ry": {
        const rot = (s.rotation * Math.PI) / 180;
        const vx = ix - s.cx * W;
        const vy = iy - s.cy * H;
        // project onto the handle's axis
        const ax = d.handle === "rx" ? Math.cos(rot) : -Math.sin(rot);
        const ay = d.handle === "rx" ? Math.sin(rot) : Math.cos(rot);
        const r = Math.max(0.01, Math.abs(vx * ax + vy * ay) / long);
        onChange(d.handle === "rx" ? { ...mask, rx: r } : { ...mask, ry: r });
        break;
      }
      case "rot": {
        const ang = (Math.atan2(iy - s.cy * H, ix - s.cx * W) * 180) / Math.PI;
        onChange({ ...mask, rotation: ang });
        break;
      }
    }
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drag.current) return;
    e.stopPropagation();
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    drag.current = null;
  };

  const hp = (h: Handle) => ({
    onPointerDown: onDown(h),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
  });

  const dot = (p: [number, number], h: Handle, cls = "") => (
    <circle key={h} cx={p[0]} cy={p[1]} r={7} className={"mo-handle " + cls} {...hp(h)} />
  );

  if (mask.kind === "linear") {
    const a = mapper.toScreen(mask.x0 * W, mask.y0 * H);
    const b = mapper.toScreen(mask.x1 * W, mask.y1 * H);
    // perpendicular guide lines through both ends
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * 4000;
    const ny = (dx / len) * 4000;
    return (
      <svg className="mirror-overlay">
        <line x1={a[0] - nx} y1={a[1] - ny} x2={a[0] + nx} y2={a[1] + ny} className="mk-edge" />
        <line x1={b[0] - nx} y1={b[1] - ny} x2={b[0] + nx} y2={b[1] + ny} className="mk-edge dashed" />
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="mk-axis" />
        <line x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className="mk-grab" {...hp("mid")} />
        {dot(a, "a", "mk-start")}
        {dot(b, "b")}
      </svg>
    );
  }

  if (mask.kind === "radial") {
    const c = mapper.toScreen(mask.cx * W, mask.cy * H);
    const rot = (mask.rotation * Math.PI) / 180;
    const ax = [Math.cos(rot), Math.sin(rot)];
    const ay = [-Math.sin(rot), Math.cos(rot)];
    const rx = Math.max(1, mask.rx * long);
    const ry = Math.max(1, mask.ry * long);
    const hx = mapper.toScreen(mask.cx * W + ax[0] * rx, mask.cy * H + ax[1] * rx);
    const hy = mapper.toScreen(mask.cx * W + ay[0] * ry, mask.cy * H + ay[1] * ry);
    const hr = mapper.toScreen(mask.cx * W + ax[0] * rx * 1.25, mask.cy * H + ax[1] * rx * 1.25);
    const k = mapper.scale; // CSS px per image px
    const f = Math.max(0.01, Math.min(1, mask.feather / 100));
    const screenRot = mapper.screenRotation + mask.rotation;
    return (
      <svg className="mirror-overlay">
        <ellipse cx={c[0]} cy={c[1]} rx={rx * k} ry={ry * k} transform={`rotate(${screenRot} ${c[0]} ${c[1]})`} className="mk-ellipse" />
        <ellipse
          cx={c[0]}
          cy={c[1]}
          rx={rx * k * (1 - f)}
          ry={ry * k * (1 - f)}
          transform={`rotate(${screenRot} ${c[0]} ${c[1]})`}
          className="mk-ellipse dashed"
        />
        <ellipse
          cx={c[0]}
          cy={c[1]}
          rx={rx * k}
          ry={ry * k}
          transform={`rotate(${screenRot} ${c[0]} ${c[1]})`}
          className="mk-grab-area"
          {...hp("center")}
        />
        <line x1={hx[0]} y1={hx[1]} x2={hr[0]} y2={hr[1]} className="mk-axis" />
        {dot(c, "center", "mk-center")}
        {dot(hx, "rx")}
        {dot(hy, "ry")}
        {dot(hr, "rot", "mk-rot")}
      </svg>
    );
  }

  return null;
}
