import { useCallback } from "react";

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
      />
    </div>
  );
}
