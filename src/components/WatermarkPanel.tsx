import { pickWatermark } from "../api";
import { defaultWatermark, type Watermark } from "../types";
import { Slider } from "./Slider";

interface Props {
  watermark: Watermark;
  onChange: (w: Watermark) => void;
  onError: (msg: string) => void;
}

function fileName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

export function WatermarkPanel({ watermark, onChange, onError }: Props) {
  const choose = async () => {
    try {
      const p = await pickWatermark();
      if (p) onChange({ ...watermark, path: p, enabled: true });
    } catch (e) {
      onError(`Could not open watermark: ${String(e)}`);
    }
  };
  return (
    <div className={"watermark-panel" + (watermark.enabled ? "" : " disabled")}>
      <div className="field">
        <button onClick={choose}>Choose image…</button>
        <em className="wm-name" title={watermark.path}>
          {watermark.path ? fileName(watermark.path) : "no image"}
        </em>
      </div>
      <div className="hint">Drag the watermark on the photo to move it, drag its corner to resize.</div>
      <Slider
        label="Size"
        value={watermark.size * 100}
        min={2}
        max={100}
        defaultValue={20}
        onChange={(v) => onChange({ ...watermark, size: v / 100 })}
      />
      <Slider
        label="Opacity"
        value={watermark.opacity}
        min={0}
        max={100}
        defaultValue={80}
        onChange={(v) => onChange({ ...watermark, opacity: v })}
      />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultWatermark(), path: watermark.path, enabled: watermark.enabled })}>
          Reset position
        </button>
        <button className="tab" onClick={() => onChange(defaultWatermark())}>
          Remove
        </button>
      </div>
    </div>
  );
}
