import { useRef } from "react";
import type { HealSpot } from "../types";
import type { Mapper } from "./MirrorOverlay";

interface Props {
  spots: HealSpot[];
  selectedId: string | null;
  mapper: Mapper;
  onSelect: (id: string | null) => void;
  onChange: (s: HealSpot) => void;
}

/**
 * Object-remover spots on the picture: a solid circle for the area being
 * removed and a dashed circle for the patch it is taken from. Both can be
 * dragged; the source circle can be dragged to choose a different patch.
 */
export function HealOverlay({ spots, selectedId, mapper, onSelect, onChange }: Props) {
  const drag = useRef<{ id: string; part: "dest" | "src"; start: HealSpot; ix: number; iy: number } | null>(null);
  const { width: W, height: H } = mapper;
  const long = Math.max(W, H);

  const local = (e: React.PointerEvent): [number, number] => {
    const svg = (e.currentTarget as SVGElement).closest("svg")!;
    const r = svg.getBoundingClientRect();
    return mapper.toImage(e.clientX - r.left, e.clientY - r.top);
  };

  const onDown = (spot: HealSpot, part: "dest" | "src") => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const [ix, iy] = local(e);
    drag.current = { id: spot.id, part, start: spot, ix, iy };
    onSelect(spot.id);
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
    const dx = (ix - d.ix) / W;
    const dy = (iy - d.iy) / H;
    const s = d.start;
    if (d.part === "dest") {
      // moving the spot carries its source patch along
      onChange({ ...s, x: s.x + dx, y: s.y + dy, sx: s.sx + dx, sy: s.sy + dy });
    } else {
      onChange({ ...s, sx: s.sx + dx, sy: s.sy + dy });
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

  const hp = (spot: HealSpot, part: "dest" | "src") => ({
    onPointerDown: onDown(spot, part),
    onPointerMove: onMove,
    onPointerUp: onUp,
    onPointerCancel: onUp,
  });

  return (
    <>
      {spots.map((s) => {
        if (!s.enabled) return null;
        const d = mapper.toScreen(s.x * W, s.y * H);
        const src = mapper.toScreen(s.sx * W, s.sy * H);
        const r = s.radius * long * mapper.scale;
        const on = s.id === selectedId;
        return (
          <g key={s.id} className={"heal-spot" + (on ? " selected" : "")}>
            <line x1={src[0]} y1={src[1]} x2={d[0]} y2={d[1]} className="heal-link" />
            <circle cx={src[0]} cy={src[1]} r={r} className="heal-src" {...hp(s, "src")} />
            <circle cx={d[0]} cy={d[1]} r={r} className="heal-dest" {...hp(s, "dest")} />
          </g>
        );
      })}
    </>
  );
}
