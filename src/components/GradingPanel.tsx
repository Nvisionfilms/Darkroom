import { defaultGrading, type Grading } from "../types";
import { Slider } from "./Slider";

const HUE_TRACK = "linear-gradient(90deg,#f00,#ff0,#0f0,#0ff,#00f,#f0f,#f00)";

interface Props {
  grading: Grading;
  onChange: (g: Grading) => void;
}

function swatch(h: number, s: number, l: number): string {
  return `hsl(${h} ${Math.max(0, Math.min(100, s))}% ${l}%)`;
}

export function GradingPanel({ grading, onChange }: Props) {
  const set = <K extends keyof Grading>(key: K) => (v: number) => onChange({ ...grading, [key]: v });
  const ranges: { name: string; hue: keyof Grading; sat: keyof Grading; l: number }[] = [
    { name: "Shadows", hue: "shadowHue", sat: "shadowSat", l: 30 },
    { name: "Midtones", hue: "midHue", sat: "midSat", l: 50 },
    { name: "Highlights", hue: "highHue", sat: "highSat", l: 72 },
  ];
  const preview = `linear-gradient(90deg, ${swatch(grading.shadowHue, grading.shadowSat, 28)}, ${swatch(
    grading.midHue,
    grading.midSat,
    50,
  )} ${50 + grading.balance * 0.35}%, ${swatch(grading.highHue, grading.highSat, 78)})`;
  return (
    <div className="grading">
      <div className="grading-preview" style={{ background: preview }} title="Shadows → highlights tint" />
      {ranges.map((r) => (
        <div className="grading-range" key={r.name}>
          <div className="grading-head">
            <span className="swatch" style={{ background: swatch(grading[r.hue] as number, grading[r.sat] as number, r.l) }} />
            <span>{r.name}</span>
          </div>
          <Slider
            label="Hue"
            value={grading[r.hue] as number}
            min={0}
            max={360}
            defaultValue={defaultGrading()[r.hue] as number}
            track={HUE_TRACK}
            onChange={set(r.hue)}
          />
          <Slider label="Saturation" value={grading[r.sat] as number} min={0} max={100} onChange={set(r.sat)} />
        </div>
      ))}
      <Slider
        label="Balance"
        value={grading.balance}
        min={-100}
        max={100}
        track="linear-gradient(90deg,#333,#bbb)"
        onChange={set("balance")}
      />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange(defaultGrading())}>
          Reset
        </button>
      </div>
    </div>
  );
}
