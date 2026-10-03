import { useRef } from "react";
import type { Watermark } from "../types";
import type { Mapper } from "./MirrorOverlay";

interface Props {
  watermark: Watermark;
  /** watermark image aspect (width / height) */
  aspect: number;
  mapper: Mapper;
  onChange: (w: Watermark) => void;
}

/** Draggable frame for the watermark: drag inside to move, corner to resize. */
export function WatermarkOverlay({ watermark, aspect, mapper, onChange }: Props) {
  const drag = useRef<{ mode: "move" | "size"; sx: number; sy: number; start: Watermark } | null>(null);
  // The watermark lives in the cropped frame, not in the original picture, so
  // the frame is drawn and dragged in that same space - otherwise the handles
  // sat somewhere other than the mark itself as soon as the photo was cropped.
  const W = mapper.outW;
  const H = mapper.outH;
  const long = Math.max(W, H);
  const wpx = watermark.size * long;
  const hpx = wpx / Math.max(aspect, 1e-3);
  const cx = mapper.outX + watermark.x * W;
  const cy = mapper.outY + watermark.y * H;
  const corners = [
    mapper.canvasToScreen(cx - wpx / 2, cy - hpx / 2),
    mapper.canvasToScreen(cx + wpx / 2, cy - hpx / 2),
    mapper.canvasToScreen(cx + wpx / 2, cy + hpx / 2),
    mapper.canvasToScreen(cx - wpx / 2, cy + hpx / 2),
  ];
  const points = corners.map((c) => c.join(",")).join(" ");
  const handle = corners[2];

  const localPoint = (e: React.PointerEvent): [number, number] => {
    const svg = (e.currentTarget as SVGElement).closest("svg")!;
    const rect = svg.getBoundingClientRect();
    return mapper.screenToCanvas(e.clientX - rect.left, e.clientY - rect.top);
  };

  const onDown = (mode: "move" | "size") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const [ix, iy] = localPoint(e);
    drag.current = { mode, sx: ix, sy: iy, start: watermark };
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* synthetic events */
    }
  };
  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    e.stopPropagation();
    const [ix, iy] = localPoint(e);
    if (d.mode === "move") {
      onChange({
        ...watermark,
        x: Math.max(0, Math.min(1, d.start.x + (ix - d.sx) / W)),
        y: Math.max(0, Math.min(1, d.start.y + (iy - d.sy) / H)),
      });
    } else {
      // distance from the centre to the pointer along the diagonal sets the width
      const dx = Math.abs(ix - d.start.x * W);
      const size = Math.max(0.02, Math.min(1.5, (2 * dx) / long));
      onChange({ ...watermark, size });
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

  return (
    <svg className="mirror-overlay">
      <polygon
        points={points}
        className="wm-frame"
        onPointerDown={onDown("move")}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
      <rect
        x={handle[0] - 6}
        y={handle[1] - 6}
        width={12}
        height={12}
        className="mo-handle"
        onPointerDown={onDown("size")}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      />
    </svg>
  );
}
