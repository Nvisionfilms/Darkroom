import { defaultMirror, type Mirror } from "../types";
import { Slider } from "./Slider";

interface Props {
  mirror: Mirror;
  onChange: (m: Mirror) => void;
}

export function MirrorPanel({ mirror, onChange }: Props) {
  const set = <K extends keyof Mirror>(key: K) => (v: Mirror[K]) => onChange({ ...mirror, [key]: v });
  return (
    <div className={"mirror-panel" + (mirror.enabled ? "" : " disabled")}>
      <div className="hint">
        Drag the window on the image: the centre moves it, the squares resize it, the ring on the edge sets the
        mirror side and gap, the end dot sets the tail length.
      </div>
      <Slider label="Opacity" value={mirror.opacity} min={0} max={100} defaultValue={70} onChange={set("opacity")} />
      <Slider
        label="Tail length"
        value={mirror.length * 100}
        min={2}
        max={100}
        defaultValue={35}
        onChange={(v) => set("length")(v / 100)}
      />
      <Slider label="Feather" value={mirror.feather} min={0} max={100} defaultValue={30} onChange={set("feather")} />
      <Slider label="Rotation" value={mirror.rotation} min={-90} max={90} onChange={set("rotation")} />
      <Slider
        label="Direction"
        value={mirror.direction}
        min={-180}
        max={180}
        defaultValue={90}
        onChange={set("direction")}
      />
      <Slider
        label="Gap"
        value={mirror.offset * 100}
        min={0}
        max={50}
        onChange={(v) => set("offset")(v / 100)}
      />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultMirror(), enabled: mirror.enabled })}>
          Reset
        </button>
      </div>
    </div>
  );
}
