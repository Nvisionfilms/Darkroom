import { useCallback, useMemo, useRef, useState } from "react";
import { curveLut } from "../curve";
import type { Curves, Point } from "../types";

type Channel = keyof Curves;

const CHANNELS: { key: Channel; label: string; color: string }[] = [
  { key: "master", label: "RGB", color: "#e8e8e8" },
  { key: "red", label: "R", color: "#ff5d5d" },
  { key: "green", label: "G", color: "#5ddb6d" },
  { key: "blue", label: "B", color: "#5d8dff" },
];

const SIZE = 256;

interface Props {
  curves: Curves;
  onChange: (curves: Curves) => void;
}

export function CurveEditor({ curves, onChange }: Props) {
  const [channel, setChannel] = useState<Channel>("master");
  const svgRef = useRef<SVGSVGElement>(null);
  const dragIndex = useRef<number | null>(null);
  const points = curves[channel];
  const color = CHANNELS.find((c) => c.key === channel)!.color;

  const path = useMemo(() => {
    const lut = curveLut(points);
    let d = "";
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * SIZE;
      const y = SIZE - lut[i] * SIZE;
      d += (i === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1) + " ";
    }
    return d;
  }, [points]);

  const toLocal = useCallback((e: { clientX: number; clientY: number }): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1 - (e.clientY - rect.top) / rect.height;
    return [Math.max(0, Math.min(1, x)), Math.max(0, Math.min(1, y))];
  }, []);

  const update = useCallback(
    (next: Point[]) => {
      onChange({ ...curves, [channel]: next });
    },
    [curves, channel, onChange],
  );

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return;
    const p = toLocal(e);
    // a fingertip needs a much bigger target than a mouse pointer
    const hitRadius = (e.pointerType === "touch" ? 28 : 12) / svgRef.current!.getBoundingClientRect().width;
    let idx = points.findIndex((q) => Math.hypot(q[0] - p[0], q[1] - p[1]) < hitRadius);
    let next = points;
    if (idx === -1) {
      next = [...points, p].sort((a, b) => a[0] - b[0]);
      idx = next.indexOf(p);
      update(next);
    }
    dragIndex.current = idx;
    svgRef.current!.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const idx = dragIndex.current;
    if (idx === null) return;
    const p = toLocal(e);
    const next = points.map((q) => [...q] as Point);
    const isEnd = idx === 0 || idx === next.length - 1;
    const rect = svgRef.current!.getBoundingClientRect();
    const outside =
      e.clientY < rect.top - 40 || e.clientY > rect.bottom + 40 || e.clientX < rect.left - 40 || e.clientX > rect.right + 40;
    if (!isEnd && outside && next.length > 2) {
      next.splice(idx, 1);
      dragIndex.current = null;
      update(next);
      return;
    }
    if (isEnd) {
      next[idx][1] = p[1];
    } else {
      const lo = next[idx - 1][0] + 0.005;
      const hi = next[idx + 1][0] - 0.005;
      next[idx] = [Math.max(lo, Math.min(hi, p[0])), p[1]];
    }
    update(next);
  };

  const onPointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    dragIndex.current = null;
    try {
      svgRef.current!.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const reset = () =>
    update([
      [0, 0],
      [1, 1],
    ]);

  return (
    <div className="curve-editor">
      <div className="curve-tabs">
        {CHANNELS.map((c) => (
          <button
            key={c.key}
            className={"tab" + (channel === c.key ? " active" : "")}
            style={{ color: c.color }}
            onClick={() => setChannel(c.key)}
          >
            {c.label}
          </button>
        ))}
        <span className="spacer" />
        <button className="tab" onClick={reset} title="Reset this channel">
          Reset
        </button>
      </div>
      <svg
        ref={svgRef}
        className="curve-svg"
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <rect x="0" y="0" width={SIZE} height={SIZE} fill="#161616" />
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f} stroke="#2e2e2e" strokeWidth="1">
            <line x1={f * SIZE} y1="0" x2={f * SIZE} y2={SIZE} />
            <line x1="0" y1={f * SIZE} x2={SIZE} y2={f * SIZE} />
          </g>
        ))}
        <line x1="0" y1={SIZE} x2={SIZE} y2="0" stroke="#3a3a3a" strokeWidth="1" strokeDasharray="4 4" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p[0] * SIZE}
            cy={SIZE - p[1] * SIZE}
            r="5"
            fill="#111"
            stroke={color}
            strokeWidth="2"
          />
        ))}
      </svg>
      <div className="hint">Click to add a point, drag to move, drag off the grid to remove.</div>
    </div>
  );
}
