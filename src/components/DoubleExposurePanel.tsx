import { BLEND_FITS, BLEND_MODES } from "../blend";
import { defaultBlend, type Blend } from "../types";
import { Slider } from "./Slider";

interface Props {
  blend: Blend;
  busy: boolean;
  /** true while a file is being dragged over this panel */
  dropping: boolean;
  onPick: () => void;
  onChange: (b: Blend) => void;
}

/**
 * Double exposure: a second photograph composited onto the one being edited.
 *
 * The default "Expose" mode adds the second picture as scene-referred light
 * before the tone mapping, the way two exposures on one negative behave. The
 * other modes are the familiar display-referred layer blends and run after
 * the point curves and the creative look.
 */
export function DoubleExposurePanel({ blend, busy, dropping, onPick, onChange }: Props) {
  const loaded = !!blend.path;
  const set =
    <K extends keyof Blend>(k: K) =>
    (v: Blend[K]) =>
      onChange({ ...blend, [k]: v });
  const mode = BLEND_MODES.find((m) => m.id === blend.mode) ?? BLEND_MODES[0];

  if (!loaded) {
    return (
      <div className="blend-panel">
        <button
          type="button"
          className={"blend-drop" + (dropping ? " over" : "") + (busy ? " busy" : "")}
          onClick={onPick}
          disabled={busy}
        >
          <span className="blend-drop-glyph">◎</span>
          <strong>{busy ? "Reading the photo…" : dropping ? "Drop it here" : "Drag a photo here"}</strong>
          <small>or click to choose one. RAW files work too.</small>
        </button>
      </div>
    );
  }

  return (
    <div className={"blend-panel" + (dropping ? " over" : "")}>
      <div className="blend-file">
        <strong title={blend.path}>{blend.name || blend.path}</strong>
        <div className="blend-file-actions">
          <button type="button" onClick={onPick} disabled={busy}>
            {busy ? "Loading…" : "Replace…"}
          </button>
          <button type="button" className="tab" onClick={() => onChange(defaultBlend())}>
            Remove
          </button>
        </div>
      </div>

      <label className="look-enable">
        <input type="checkbox" checked={blend.enabled} onChange={(e) => set("enabled")(e.target.checked)} />
        Apply
      </label>

      <label className="field">
        <span>Blend</span>
        <select value={blend.mode} title={mode.hint} onChange={(e) => set("mode")(e.target.value)}>
          {BLEND_MODES.map((m) => (
            <option key={m.id} value={m.id} title={m.hint}>
              {m.name}
            </option>
          ))}
        </select>
      </label>
      <div className="hint">{mode.hint}</div>

      <Slider label="Opacity" value={blend.opacity} min={0} max={100} defaultValue={100} onChange={set("opacity")} />
      <Slider
        label="Brightness"
        value={blend.exposure}
        min={-5}
        max={5}
        step={0.05}
        defaultValue={0}
        format={(v) => `${v > 0 ? "+" : ""}${v.toFixed(2)} EV`}
        onChange={set("exposure")}
      />

      <label className="field">
        <span>Fit</span>
        <select value={blend.fit} onChange={(e) => set("fit")(e.target.value)}>
          {BLEND_FITS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
        </select>
      </label>

      <Slider label="Size" value={blend.scale} min={10} max={400} defaultValue={100} format={(v) => `${Math.round(v)}%`} onChange={set("scale")} />
      <Slider label="Move X" value={blend.x} min={-100} max={100} defaultValue={0} onChange={set("x")} />
      <Slider label="Move Y" value={blend.y} min={-100} max={100} defaultValue={0} onChange={set("y")} />
      <Slider label="Rotate" value={blend.rotation} min={-180} max={180} defaultValue={0} format={(v) => `${Math.round(v)}°`} onChange={set("rotation")} />

      <div className="blend-toggles">
        <label>
          <input type="checkbox" checked={blend.flip} onChange={(e) => set("flip")(e.target.checked)} />
          Mirror
        </label>
        <label title="A photographic negative of the second picture.">
          <input type="checkbox" checked={blend.invert} onChange={(e) => set("invert")(e.target.checked)} />
          Negative
        </label>
      </div>
    </div>
  );
}
