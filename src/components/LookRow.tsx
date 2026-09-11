import { LOOK_INPUTS } from "../camlog";
import type { Look } from "../types";
import { Slider } from "./Slider";

interface Props {
  look: Look;
  busy: boolean;
  onLoad: () => void;
  onChange: (l: Look) => void;
}

/**
 * A creative look-up table from a .cube file, applied after the point curves.
 * The tone controls above it still work in scene-referred light, and
 * vibrance, HSL and colour grading still work on top of it.
 */
export function LookRow({ look, busy, onLoad, onChange }: Props) {
  const loaded = !!look.path;
  return (
    <div className="look-row">
      <div className="field">
        <span>Look</span>
        {loaded ? (
          <em className="look-name" title={look.path}>
            {look.name || "Look"}
          </em>
        ) : (
          <em>none</em>
        )}
        <button onClick={onLoad} disabled={busy}>
          {busy ? "Loading…" : loaded ? "Change…" : "Load .cube…"}
        </button>
      </div>
      {loaded && (
        <>
          <div className="look-actions">
            <label className="look-enable">
              <input type="checkbox" checked={look.enabled} onChange={(e) => onChange({ ...look, enabled: e.target.checked })} />
              Apply
            </label>
            <button className="tab" onClick={() => onChange({ enabled: true, path: "", name: "", amount: 100, input: "display" })}>
              Remove
            </button>
          </div>
          <label className="field">
            <span>LUT input</span>
            <select
              value={look.input ?? "display"}
              title="What the LUT was built for. Camera log LUTs (Sony S-Log3, Canon Log 3, Blackmagic Film) need the matching input."
              onChange={(e) => onChange({ ...look, input: e.target.value })}
            >
              {LOOK_INPUTS.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </select>
          </label>
          <Slider
            label="Look amount"
            value={look.amount}
            min={0}
            max={100}
            defaultValue={100}
            onChange={(v) => onChange({ ...look, amount: v })}
          />
        </>
      )}
    </div>
  );
}
