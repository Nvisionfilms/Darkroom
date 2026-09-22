import { useCallback, useRef } from "react";
import { useCoarsePointer } from "../phone";

/** How far a finger has to move before it counts as a scroll or a drag. */
const TOUCH_SLOP = 10;

interface Props {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  defaultValue?: number;
  format?: (v: number) => string;
  /** CSS background for the track, e.g. a gradient for temperature */
  track?: string;
  onChange: (v: number) => void;
}

export function Slider({ label, value, min, max, step = 1, defaultValue = 0, format, track, onChange }: Props) {
  const reset = useCallback(() => onChange(defaultValue), [onChange, defaultValue]);

  // On a touch screen the native range input grabs any finger that lands on
  // it, so scrolling the panel past a slider changed it. Here a vertical
  // swipe is left to scroll, and the value only follows a sideways drag -
  // relative to where the finger went down, so touching never jumps it.
  const coarse = useCoarsePointer();
  const touch = useRef<{ id: number; x: number; y: number; from: number; width: number; dragging: boolean } | null>(null);
  const decimals = step < 1 ? Math.max(0, Math.ceil(-Math.log10(step))) : 0;
  const onTouchDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== "touch") return;
    touch.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      from: value,
      width: e.currentTarget.getBoundingClientRect().width || 1,
      dragging: false,
    };
  };
  const onTouchMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const t = touch.current;
    if (!t || t.id !== e.pointerId) return;
    const dx = e.clientX - t.x;
    const dy = e.clientY - t.y;
    if (!t.dragging) {
      // a scroll: let the panel have it
      if (Math.abs(dy) > TOUCH_SLOP && Math.abs(dy) >= Math.abs(dx)) {
        touch.current = null;
        return;
      }
      if (Math.abs(dx) < TOUCH_SLOP) return;
      // a sideways drag: this slider owns the finger from here on, measured
      // from this point so crossing the slop does not jump the value
      t.dragging = true;
      t.x = e.clientX;
      e.currentTarget.setPointerCapture(e.pointerId);
      return;
    }
    const raw = t.from + ((e.clientX - t.x) / t.width) * (max - min);
    const snapped = Math.round(raw / step) * step;
    onChange(Number(Math.max(min, Math.min(max, snapped)).toFixed(decimals)));
  };
  const onTouchEnd = () => {
    touch.current = null;
  };
  const text = format ? format(value) : step < 1 ? value.toFixed(2) : String(Math.round(value));
  return (
    <div className="slider">
      <div className="slider-head">
        <span className="slider-label" onDoubleClick={reset} title="Double-click to reset">
          {label}
        </span>
        <input
          className="slider-num"
          type="number"
          value={Number.isFinite(value) ? (step < 1 ? Number(value.toFixed(2)) : Math.round(value)) : 0}
          min={min}
          max={max}
          step={step}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
          }}
        />
        <span className="slider-text" hidden>
          {text}
        </span>
      </div>
      <div
        className={coarse ? "slider-touch" : "slider-track"}
        onPointerDown={coarse ? onTouchDown : undefined}
        onPointerMove={coarse ? onTouchMove : undefined}
        onPointerUp={coarse ? onTouchEnd : undefined}
        onPointerCancel={coarse ? onTouchEnd : undefined}
      >
      <input
        className="slider-range"
        type="range"
        style={track ? { background: track } : undefined}
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        onDoubleClick={reset}
        tabIndex={coarse ? -1 : undefined}
      />
      </div>
    </div>
  );
}
