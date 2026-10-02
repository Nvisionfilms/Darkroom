import { useState } from "react";
import type { Preset } from "../types";

interface Props {
  presets: Preset[];
  disabled: boolean;
  onApply: (p: Preset) => void;
  onSave: (name: string) => void;
  onDelete: (name: string) => void;
  /** write the look as a .cube 3D LUT; busy while one is being written */
  onExportCube: (size: number) => void;
  cubeBusy: boolean;
}

/** Lattice sizes, matching cube.rs SIZES. */
const CUBE_SIZES = [17, 33, 65];

/**
 * Saved develop settings. A preset carries the tone, colour, curves, detail,
 * profile and look settings; it never carries the crop, perspective, masks or
 * retouch spots, which belong to one particular frame.
 */
export function PresetPanel({ presets, disabled, onApply, onSave, onDelete, onExportCube, cubeBusy }: Props) {
  const [name, setName] = useState("");
  const [cubeSize, setCubeSize] = useState(33);
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

      <div className="divider" />
      <div className="field">
        <label htmlFor="cube-size">LUT size</label>
        <select id="cube-size" value={cubeSize} onChange={(e) => setCubeSize(Number(e.target.value))}>
          {CUBE_SIZES.map((n) => (
            <option key={n} value={n}>
              {n}&times;{n}&times;{n}
              {n === 33 ? " (usual)" : ""}
            </option>
          ))}
        </select>
        <button onClick={() => onExportCube(cubeSize)} disabled={disabled || cubeBusy}>
          {cubeBusy ? "Writing…" : "Export .cube"}
        </button>
      </div>
      <div className="hint">
        Writes this look as a 3D LUT for Resolve, Premiere, Final Cut, OBS or a camera. It carries the tone, colour,
        curves, HSL, grading, profile and look — everything that depends only on a pixel&rsquo;s own colour. Texture,
        clarity, dehaze, sharpening, grain, starburst, trails and masks cannot go in a LUT; the app will say which of
        them it had to leave out. Feed the LUT Rec.709 / sRGB.
      </div>
    </div>
  );
}
