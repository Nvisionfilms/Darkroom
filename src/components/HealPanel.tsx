import type { HealSpot } from "../types";
import { Slider } from "./Slider";

interface Props {
  spots: HealSpot[];
  selectedId: string | null;
  active: boolean;
  radius: number;
  kind: "heal" | "clone";
  busy: boolean;
  onToggle: () => void;
  onRadius: (r: number) => void;
  onKind: (k: "heal" | "clone") => void;
  onSelect: (id: string | null) => void;
  onChange: (s: HealSpot) => void;
  onDelete: (id: string) => void;
  onClear: () => void;
  onRepick: (id: string) => void;
}

/**
 * Object remover. Each spot copies real pixels from elsewhere in the same
 * photograph; Heal also matches the brightness and colour of the new
 * surroundings. Nothing is generated.
 */
export function HealPanel({
  spots,
  selectedId,
  active,
  radius,
  kind,
  busy,
  onToggle,
  onRadius,
  onKind,
  onSelect,
  onChange,
  onDelete,
  onClear,
  onRepick,
}: Props) {
  const sel = spots.find((s) => s.id === selectedId) ?? null;
  return (
    <div className="heal-panel">
      <div className="tether-row">
        <button className={active ? "primary" : ""} onClick={onToggle}>
          {active ? "Done removing" : "Remove objects"}
        </button>
        <span className="tether-state">{spots.length ? `${spots.length} spot${spots.length === 1 ? "" : "s"}` : "None"}</span>
      </div>

      <div className="curve-tabs">
        <button className={"tab" + (kind === "heal" ? " active" : "")} onClick={() => onKind("heal")}>
          Heal
        </button>
        <button className={"tab" + (kind === "clone" ? " active" : "")} onClick={() => onKind("clone")}>
          Clone
        </button>
        <span className="spacer" />
        {busy && <span className="hint">finding a patch…</span>}
      </div>

      <Slider
        label="Size"
        value={radius * 100}
        min={0.3}
        max={20}
        step={0.1}
        defaultValue={3}
        format={(v) => `${v.toFixed(1)}%`}
        onChange={(v) => onRadius(v / 100)}
      />

      {active && (
        <div className="hint">
          Click what you want gone. Drag the dashed circle to pick a different patch. Make the spot wider than the mark
          you are covering: Feather fades the outer part of the circle, so only the middle replaces the picture outright.
        </div>
      )}

      {spots.length > 0 && (
        <ul className="mask-list">
          {spots.map((s, i) => (
            <li
              key={s.id}
              className={"mask-row" + (s.id === selectedId ? " selected" : "") + (s.enabled ? "" : " off")}
              onClick={() => onSelect(s.id === selectedId ? null : s.id)}
            >
              <span className="mask-glyph">{s.kind === "clone" ? "⧉" : "✚"}</span>
              <span className="mask-name">
                {s.kind === "clone" ? "Clone" : "Heal"} {i + 1}
              </span>
              <input
                type="checkbox"
                checked={s.enabled}
                title="Enable"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChange({ ...s, enabled: e.target.checked })}
              />
              <button
                className="mask-delete"
                title="Delete spot"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(s.id);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      {sel && (
        <div className="mask-edit">
          <div className="curve-tabs">
            <button className={"tab" + (sel.kind === "heal" ? " active" : "")} onClick={() => onChange({ ...sel, kind: "heal" })}>
              Heal
            </button>
            <button className={"tab" + (sel.kind === "clone" ? " active" : "")} onClick={() => onChange({ ...sel, kind: "clone" })}>
              Clone
            </button>
            <span className="spacer" />
            <button className="tab" onClick={() => onRepick(sel.id)} disabled={busy}>
              New patch
            </button>
          </div>
          <Slider
            label="Size"
            value={sel.radius * 100}
            min={0.3}
            max={20}
            step={0.1}
            format={(v) => `${v.toFixed(1)}%`}
            onChange={(v) => onChange({ ...sel, radius: v / 100 })}
          />
          <Slider label="Feather" value={sel.feather} min={0} max={100} defaultValue={60} onChange={(v) => onChange({ ...sel, feather: v })} />
          <Slider label="Opacity" value={sel.opacity} min={0} max={100} defaultValue={100} onChange={(v) => onChange({ ...sel, opacity: v })} />
        </div>
      )}

      {spots.length > 0 && (
        <div className="curve-tabs">
          <span className="spacer" />
          <button className="tab" onClick={onClear}>
            Remove all spots
          </button>
        </div>
      )}
    </div>
  );
}
