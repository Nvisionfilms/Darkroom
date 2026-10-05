import { defaultVignette, type Vignette } from "../types";
import { Slider } from "./Slider";

interface Props {
  vignette: Vignette;
  onChange: (v: Vignette) => void;
}

/**
 * Darken or lighten towards the corners. It is measured against the cropped
 * frame, so cropping in moves it to the new edges rather than leaving it where
 * the corners used to be.
 */
export function VignettePanel({ vignette, onChange }: Props) {
  const set =
    <K extends keyof Vignette>(key: K) =>
    (v: Vignette[K]) =>
      onChange({ ...vignette, [key]: v });

  return (
    <div className={"vignette-panel" + (vignette.enabled ? "" : " disabled")}>
      <Slider
        label="Amount"
        value={vignette.amount}
        min={-100}
        max={100}
        defaultValue={-35}
        track="linear-gradient(90deg,#000,#777 50%,#fff)"
        onChange={set("amount")}
      />
      <Slider label="Midpoint" value={vignette.midpoint} min={0} max={100} defaultValue={50} onChange={set("midpoint")} />
      <Slider label="Feather" value={vignette.feather} min={0} max={100} defaultValue={50} onChange={set("feather")} />
      <Slider label="Opacity" value={vignette.opacity} min={0} max={100} defaultValue={100} onChange={set("opacity")} />
      <div className="hint">
        Left of centre darkens the corners, right of centre takes them towards white. Midpoint is how far out it starts
        and Feather how gradually it arrives. It follows the crop, so cropping in moves it to the new edges.
      </div>
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultVignette(), enabled: vignette.enabled })}>
          Reset
        </button>
      </div>
    </div>
  );
}
