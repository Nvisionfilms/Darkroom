import type { Transform } from "../types";
import { defaultTransform } from "../types";
import { Slider } from "./Slider";

interface Props {
  transform: Transform;
  onChange: (t: Transform) => void;
}

/** Perspective and geometry: keystone correction, rotation, scale and shift. */
export function TransformPanel({ transform, onChange }: Props) {
  const set = <K extends keyof Transform>(k: K) => (v: Transform[K]) => onChange({ ...transform, [k]: v });
  return (
    <div className="transform-panel">
      <Slider label="Vertical" value={transform.vertical} min={-100} max={100} onChange={set("vertical")} />
      <Slider label="Horizontal" value={transform.horizontal} min={-100} max={100} onChange={set("horizontal")} />
      <Slider label="Rotate" value={transform.rotate} min={-45} max={45} step={0.1} onChange={set("rotate")} />
      <div className="divider" />
      <Slider label="Aspect" value={transform.aspect} min={-100} max={100} onChange={set("aspect")} />
      <Slider label="Scale" value={transform.scale} min={-50} max={100} onChange={set("scale")} />
      <Slider label="Shift X" value={transform.x} min={-100} max={100} onChange={set("x")} />
      <Slider label="Shift Y" value={transform.y} min={-100} max={100} onChange={set("y")} />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange(defaultTransform())}>
          Reset
        </button>
      </div>
      <div className="hint">
        Straightening converging lines pulls the edges in. Raise Scale to fill the frame again, or crop afterwards.
      </div>
    </div>
  );
}
