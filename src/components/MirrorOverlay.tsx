import { useRef } from "react";
import { mirrorGeom } from "../gl/Renderer";
import type { Mirror } from "../types";

export interface Mapper {
  /** image pixel -> CSS pixel inside the viewer */
  toScreen: (ix: number, iy: number) => [number, number];
  /** CSS pixel inside the viewer -> image pixel */
  toImage: (sx: number, sy: number) => [number, number];
  /** straightened-canvas pixel (crop space) <-> CSS pixel */
  canvasToScreen: (sx: number, sy: number) => [number, number];
  screenToCanvas: (sx: number, sy: number) => [number, number];
  /** image px per CSS px */
  scale: number;
  /** total on-screen rotation of image axes, degrees */
  screenRotation: number;
  width: number;
  height: number;
}

interface Props {
  mirror: Mirror;
  mapper: Mapper;
  onChange: (m: Mirror) => void;
}

type Handle = "center" | "rx" | "ry" | "dir" | "tail";

/** On-canvas handles for the mirror power window. */
export function MirrorOverlay({ mirror, mapper, onChange }: Props) {
  const drag = useRef<{ handle: Handle; el: Element } | null>(null);
  const { width: W, height: H } = mapper;
  const long = Math.max(W, H);
  const g = mirrorGeom(mirror, W, H);
  const rot = (mirror.rotation * Math.PI) / 180;
  const ax = [Math.cos(rot), Math.sin(rot)];
  const ay = [-Math.sin(rot), Math.cos(rot)];

  const center = mapper.toScreen(g.cx, g.cy);
  const hx = mapper.toScreen(g.cx + ax[0] * g.rx, g.cy + ax[1] * g.rx);
  // height handle on the top edge so it does not sit under the mirror-side ring
  // when the tail points down (the default)
  const hy = mapper.toScreen(g.cx - ay[0] * g.ry, g.cy - ay[1] * g.ry);
  const line = mapper.toScreen(g.lx, g.ly);
  const tailEnd = mapper.toScreen(g.lx + g.dx * g.tail, g.ly + g.dy * g.tail);
  const nx = -g.dy;
  const ny = g.dx;
  const span = g.rd * 1.3;
  const lineA = mapper.toScreen(g.lx + nx * span, g.ly + ny * span);
  const lineB = mapper.toScreen(g.lx - nx * span, g.ly - ny * span);
  const srx = g.rx * mapper.scale;
  const sry = g.ry * mapper.scale;
  const angle = mirror.rotation + mapper.screenRotation;

  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = { handle, el: e.currentTarget };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events have no active pointer */
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const svg = (e.currentTarget as SVGElement).closest("svg")!;
    const rect = svg.getBoundingClientRect();
    const [ix, iy] = mapper.toImage(e.clientX - rect.left, e.clientY - rect.top);
    const next = { ...mirror };
    switch (d.handle) {
      case "center":
        next.cx = Math.max(0, Math.min(1, ix / W));
        next.cy = Math.max(0, Math.min(1, iy / H));
        break;
      case "rx": {
        const proj = (ix - g.cx) * ax[0] + (iy - g.cy) * ax[1];
        next.rx = Math.max(0.01, Math.abs(proj) / long);
        break;
      }
      case "ry": {
        const proj = (ix - g.cx) * ay[0] + (iy - g.cy) * ay[1];
        next.ry = Math.max(0.01, Math.abs(proj) / long);
        break;
      }
      case "dir": {
        const vx = ix - g.cx;
        const vy = iy - g.cy;
        next.direction = (Math.atan2(vy, vx) * 180) / Math.PI;
        const rd = mirrorGeom(next, W, H).rd;
        next.offset = Math.max(0, (Math.hypot(vx, vy) - rd) / long);
        break;
      }
      case "tail": {
        const t = (ix - g.lx) * g.dx + (iy - g.ly) * g.dy;
        next.length = Math.max(0.02, t / long);
        break;
      }
    }
    onChange(next);
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

  const handleProps = (h: Handle) => ({
    onPointerDown: onDown(h),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
  });

  return (
    <svg className="mirror-overlay">
      <ellipse
        cx={center[0]}
        cy={center[1]}
        rx={srx}
        ry={sry}
        transform={`rotate(${angle} ${center[0]} ${center[1]})`}
        className="mo-window"
      />
      <line x1={lineA[0]} y1={lineA[1]} x2={lineB[0]} y2={lineB[1]} className="mo-line" />
      <line x1={line[0]} y1={line[1]} x2={tailEnd[0]} y2={tailEnd[1]} className="mo-tail" />
      <circle cx={center[0]} cy={center[1]} r={7} className="mo-handle mo-center" {...handleProps("center")} />
      <rect x={hx[0] - 5} y={hx[1] - 5} width={10} height={10} className="mo-handle" {...handleProps("rx")} />
      <rect x={hy[0] - 5} y={hy[1] - 5} width={10} height={10} className="mo-handle" {...handleProps("ry")} />
      <circle cx={line[0]} cy={line[1]} r={6} className="mo-handle mo-dir" {...handleProps("dir")} />
      <circle cx={tailEnd[0]} cy={tailEnd[1]} r={6} className="mo-handle mo-tailend" {...handleProps("tail")} />
    </svg>
  );
}
