import { useState } from "react";
import type { Preset } from "../types";

interface Props {
  presets: Preset[];
  disabled: boolean;
  onApply: (p: Preset) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
}

/**
 * Saved develop settings. A preset carries the tone, colour, curves, detail,
 * profile and look settings; it never carries the crop, perspective, masks or
 * retouch spots, which belong to one particular frame.
 */
export function PresetPanel({ presets, disabled, onApply, onSave, onDelete }: Props) {
  const [name, setName] = useState("");
  const existing = presets.some((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const save = () => {
    const n = name.trim();
    if (!n) return;
    onSave(n);
    setName("");
  };
  return (
    <div className="preset-panel">
      <div className="preset-save">
        <input
          className="preset-name"
          placeholder="Name this look…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") save();
          }}
        />
        <button className="primary" onClick={save} disabled={disabled || !name.trim()}>
          {existing ? "Replace" : "Save"}
        </button>
      </div>

      {presets.length === 0 ? (
        <div className="hint">No presets yet. Set up a photo the way you like it, then save it here and apply it to others.</div>
      ) : (
        <ul className="mask-list">
          {presets.map((p) => (
            <li key={p.name} className="mask-row" onClick={() => !disabled && onApply(p)}>
              <span className="mask-glyph">◆</span>
              <span className="mask-name">{p.name}</span>
              <button
                className="mask-delete"
                title="Delete preset"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(p.name);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {presets.length > 0 && <div className="hint">Click a preset to apply it to the photo on screen.</div>}
    </div>
  );
}
