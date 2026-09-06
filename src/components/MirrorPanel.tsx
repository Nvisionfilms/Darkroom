import { defaultMirror, type Mirror } from "../types";
import { Slider } from "./Slider";

interface Props {
  mirror: Mirror;
  onChange: (m: Mirror) => void;
}

/**
 * Motion Trails keeps the legacy `mirror` wire shape so old sidecars continue
 * to load. The old geometry fields are intentionally repurposed:
 *   cx -> copies / 10, rx -> blur / 100, ry -> amount / 100,
 *   feather -> fade, length -> distance, direction/opacity keep their meaning.
 */
export function MirrorPanel({ mirror, onChange }: Props) {
  const set = <K extends keyof Mirror>(key: K) => (v: Mirror[K]) => onChange({ ...mirror, [key]: v });
  const copies = Math.max(1, Math.min(8, Math.round(mirror.cx * 10)));

  return (
    <div className={"mirror-panel" + (mirror.enabled ? "" : " disabled")}>
      <div className="hint">
        Repeats the developed photo in one direction like a long-exposure motion echo. Current source: full image. A
        subject/region mask is a separate targeted-trails mode; this effect does not use generative AI.
      </div>
      <Slider
        label="Amount"
        value={mirror.ry * 100}
        min={0}
        max={100}
        defaultValue={70}
        onChange={(v) => set("ry")(v / 100)}
      />
      <Slider
        label="Direction"
        value={mirror.direction}
        min={-180}
        max={180}
        defaultValue={-35}
        onChange={set("direction")}
      />
      <Slider
        label="Distance"
        value={mirror.length * 100}
        min={1}
        max={70}
        defaultValue={16}
        onChange={(v) => set("length")(v / 100)}
      />
      <Slider
        label="Copies"
        value={copies}
        min={1}
        max={8}
        step={1}
        defaultValue={4}
        onChange={(v) => set("cx")(Math.round(v) / 10)}
      />
      <Slider label="Fade" value={mirror.feather} min={0} max={100} defaultValue={65} onChange={set("feather")} />
      <Slider
        label="Blur"
        value={mirror.rx * 100}
        min={0}
        max={100}
        defaultValue={20}
        onChange={(v) => set("rx")(v / 100)}
      />
      <Slider label="Opacity" value={mirror.opacity} min={0} max={100} defaultValue={65} onChange={set("opacity")} />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultMirror(), enabled: mirror.enabled })}>
          Reset
        </button>
      </div>
    </div>
  );
}
