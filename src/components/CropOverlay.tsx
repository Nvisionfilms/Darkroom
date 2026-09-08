import { useRef } from "react";
import type { Crop } from "../types";
import { CropGuides, type GuideKind } from "./CropGuides";
import type { Mapper } from "./MirrorOverlay";

interface Props {
  crop: Crop;
  /** locked aspect as width/height in pixels, or null for free */
  aspect: number | null;
  mapper: Mapper;
  guide?: GuideKind;
  guideFlip?: number;
  onChange: (c: Crop) => void;
}

type Handle = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";
const MIN = 0.02;

/** Crop rectangle with move/resize handles, drawn on the straightened canvas. */
export function CropOverlay({ crop, aspect, mapper, guide = "thirds", guideFlip = 0, onChange }: Props) {
  const drag = useRef<{ handle: Handle; sx: number; sy: number; start: Crop } | null>(null);
  const { width: W, height: H } = mapper;
  const x0 = crop.x * W;
  const y0 = crop.y * H;
  const x1 = (crop.x + crop.w) * W;
  const y1 = (crop.y + crop.h) * H;

  const P = (x: number, y: number) => mapper.canvasToScreen(x, y);
  const c00 = P(x0, y0);
  const c10 = P(x1, y0);
  const c11 = P(x1, y1);
  const c01 = P(x0, y1);
  const canvasCorners = [P(0, 0), P(W, 0), P(W, H), P(0, H)];
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const poly = (pts: [number, number][]) => pts.map((p) => p.join(",")).join(" ");

  const local = (e: React.PointerEvent): [number, number] => {
    const svg = (e.currentTarget as SVGElement).closest("svg")!;
    const r = svg.getBoundingClientRect();
    return mapper.screenToCanvas(e.clientX - r.left, e.clientY - r.top);
  };

  const onDown = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const [sx, sy] = local(e);
    drag.current = { handle, sx, sy, start: crop };
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
    const [sx, sy] = local(e);
    const dx = (sx - d.sx) / W;
    const dy = (sy - d.sy) / H;
    const s = d.start;
    let { x, y, w, h } = s;
    if (d.handle === "move") {
      x = Math.max(0, Math.min(1 - w, s.x + dx));
      y = Math.max(0, Math.min(1 - h, s.y + dy));
      onChange({ ...crop, x, y });
      return;
    }
    // edges / corners: move the dragged sides, keep the opposite ones fixed
    let L = s.x;
    let T = s.y;
    let R = s.x + s.w;
    let B = s.y + s.h;
    if (d.handle.includes("w")) L = Math.max(0, Math.min(R - MIN, s.x + dx));
    if (d.handle.includes("e")) R = Math.min(1, Math.max(L + MIN, s.x + s.w + dx));
    if (d.handle.includes("n")) T = Math.max(0, Math.min(B - MIN, s.y + dy));
    if (d.handle.includes("s")) B = Math.min(1, Math.max(T + MIN, s.y + s.h + dy));
    w = R - L;
    h = B - T;
    if (aspect) {
      // aspect in pixels: (w*W)/(h*H) = aspect
      const horizontalDrag = d.handle === "e" || d.handle === "w";
      if (horizontalDrag) h = (w * W) / aspect / H;
      else if (d.handle === "n" || d.handle === "s") w = (h * H * aspect) / W;
      else {
        // corner: fit within the dragged box
        const hFromW = (w * W) / aspect / H;
        if (hFromW <= h) h = hFromW;
        else w = (h * H * aspect) / W;
      }
      // anchor on the fixed sides
      if (d.handle.includes("w")) L = R - w;
      else R = L + w;
      if (d.handle.includes("n")) T = B - h;
      else B = T + h;
      // keep inside the canvas
      if (L < 0) {
        L = 0;
        w = R;
        h = (w * W) / aspect / H;
        if (d.handle.includes("n")) T = B - h;
        else B = T + h;
      }
      if (T < 0) {
        T = 0;
        h = B;
        w = (h * H * aspect) / W;
        if (d.handle.includes("w")) L = R - w;
        else R = L + w;
      }
      if (R > 1) {
        R = 1;
        w = R - L;
        h = (w * W) / aspect / H;
        if (d.handle.includes("n")) T = B - h;
        else B = T + h;
      }
      if (B > 1) {
        B = 1;
        h = B - T;
        w = (h * H * aspect) / W;
        if (d.handle.includes("w")) L = R - w;
        else R = L + w;
      }
    }
    onChange({ ...crop, x: L, y: T, w: R - L, h: B - T });
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

  const handle = (pt: [number, number], h: Handle, cursor: string) => (
    <rect
      key={h}
      x={pt[0] - 6}
      y={pt[1] - 6}
      width={12}
      height={12}
      className="mo-handle"
      style={{ cursor }}
      {...hp(h)}
    />
  );

  return (
    <svg className="mirror-overlay">
      {/* darken everything outside the crop */}
      <path
        d={`M ${poly(canvasCorners).replace(/ /g, " L ")} Z M ${poly([c00, c10, c11, c01]).replace(/ /g, " L ")} Z`}
        fillRule="evenodd"
        className="crop-mask"
      />
      <polygon points={poly([c00, c10, c11, c01])} className="crop-frame" {...hp("move")} />
      <CropGuides kind={guide} flip={guideFlip} x0={x0} y0={y0} x1={x1} y1={y1} mapper={mapper} />
      {handle(mid(c00, c10), "n", "ns-resize")}
      {handle(mid(c01, c11), "s", "ns-resize")}
      {handle(mid(c00, c01), "w", "ew-resize")}
      {handle(mid(c10, c11), "e", "ew-resize")}
      {handle(c00, "nw", "nwse-resize")}
      {handle(c10, "ne", "nesw-resize")}
      {handle(c01, "sw", "nesw-resize")}
      {handle(c11, "se", "nwse-resize")}
    </svg>
  );
}
