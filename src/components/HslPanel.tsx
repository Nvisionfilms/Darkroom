import { useState } from "react";
import { HSL_BANDS, type HslParams } from "../types";
import { Slider } from "./Slider";

type Mode = keyof HslParams;

interface Props {
  hsl: HslParams;
  onChange: (hsl: HslParams) => void;
}

export function HslPanel({ hsl, onChange }: Props) {
  const [mode, setMode] = useState<Mode>("hue");
  const set = (i: number, v: number) => {
    const arr = [...hsl[mode]];
    arr[i] = v;
    onChange({ ...hsl, [mode]: arr });
  };
  const resetAll = () =>
    onChange({
      hue: new Array(8).fill(0),
      saturation: new Array(8).fill(0),
      luminance: new Array(8).fill(0),
    });
  return (
    <div className="hsl-panel">
      <div className="curve-tabs">
        {(["hue", "saturation", "luminance"] as Mode[]).map((m) => (
          <button key={m} className={"tab" + (mode === m ? " active" : "")} onClick={() => setMode(m)}>
            {m === "hue" ? "Hue" : m === "saturation" ? "Saturation" : "Luminance"}
          </button>
        ))}
        <span className="spacer" />
        <button className="tab" onClick={resetAll}>
          Reset
        </button>
      </div>
      {HSL_BANDS.map((band, i) => (
        <div className="hsl-row" key={band.name}>
          <span className="swatch" style={{ background: band.color }} />
          <Slider label={band.name} value={hsl[mode][i]} min={-100} max={100} onChange={(v) => set(i, v)} />
        </div>
      ))}
    </div>
  );
}
