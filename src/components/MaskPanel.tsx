import { useState } from "react";
import type { BrushSettings } from "../mask";
import { MASK_KIND_LABEL, defaultMaskAdjust, type Mask, type MaskKind } from "../types";
import { Slider } from "./Slider";

interface Props {
  masks: Mask[];
  selectedId: string | null;
  showMask: boolean;
  brush: BrushSettings;
  detecting: boolean;
  onSelect: (id: string | null) => void;
  onAdd: (kind: MaskKind) => void;
  onChange: (m: Mask) => void;
  onDelete: (id: string) => void;
  onShowMask: (v: boolean) => void;
  onBrush: (b: BrushSettings) => void;
  onDetectSubject: (id: string) => void;
}

const KIND_GLYPH: Record<MaskKind, string> = {
  linear: "▤",
  radial: "◯",
  brush: "✎",
  luminance: "◐",
  subject: "☺",
};

const ADD_KINDS: { kind: MaskKind; hint: string }[] = [
  { kind: "subject", hint: "Detects the main subject on this computer. No cloud, no generative AI." },
  { kind: "linear", hint: "Fades from one line to another. Drag the two handles." },
  { kind: "radial", hint: "An ellipse with a soft edge. Invert to affect the outside." },
  { kind: "brush", hint: "Paint the area by hand. Hold Alt to erase, [ and ] change the size." },
  { kind: "luminance", hint: "Picks a brightness range of the developed picture." },
];

/**
 * Local adjustments ("overlays"): a stack of masks, each with its own set of
 * develop sliders. The selected mask shows its handles on the picture.
 */
export function MaskPanel({
  masks,
  selectedId,
  showMask,
  brush,
  detecting,
  onSelect,
  onAdd,
  onChange,
  onDelete,
  onShowMask,
  onBrush,
  onDetectSubject,
}: Props) {
  const [adding, setAdding] = useState(false);
  const sel = masks.find((m) => m.id === selectedId) ?? null;
  const setAdj = (key: keyof Mask["adjust"]) => (v: number) => sel && onChange({ ...sel, adjust: { ...sel.adjust, [key]: v } });

  return (
    <div className="mask-panel">
      <div className="mask-toolbar">
        <button className={adding ? "active" : ""} onClick={() => setAdding((a) => !a)}>
          + Add mask
        </button>
        <label className="mask-show">
          <input type="checkbox" checked={showMask} onChange={(e) => onShowMask(e.target.checked)} />
          Show mask <kbd>M</kbd>
        </label>
      </div>
      {adding && (
        <div className="mask-add">
          {ADD_KINDS.map(({ kind, hint }) => (
            <button
              key={kind}
              className="mask-add-item"
              title={hint}
              onClick={() => {
                setAdding(false);
                onAdd(kind);
              }}
            >
              <span className="mask-glyph">{KIND_GLYPH[kind]}</span>
              <span>
                <strong>{MASK_KIND_LABEL[kind]}</strong>
                <small>{hint}</small>
              </span>
            </button>
          ))}
        </div>
      )}

      {masks.length === 0 && !adding && (
        <div className="hint">No masks yet. Add one to adjust exposure, colour, or detail in just part of the photo.</div>
      )}

      {masks.length > 0 && (
        <ul className="mask-list">
          {masks.map((m) => (
            <li
              key={m.id}
              className={"mask-row" + (m.id === selectedId ? " selected" : "") + (m.enabled ? "" : " off")}
              onClick={() => onSelect(m.id === selectedId ? null : m.id)}
            >
              <span className="mask-glyph">{KIND_GLYPH[m.kind]}</span>
              <span className="mask-name">
                {m.name}
                {m.invert ? " (inverted)" : ""}
              </span>
              <input
                type="checkbox"
                checked={m.enabled}
                title="Enable"
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChange({ ...m, enabled: e.target.checked })}
              />
              <button
                className="mask-delete"
                title="Delete mask"
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(m.id);
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
          <div className="mask-edit-head">
            <input
              className="mask-rename"
              value={sel.name}
              onChange={(e) => onChange({ ...sel, name: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
            />
            <label className="mask-invert">
              <input type="checkbox" checked={sel.invert} onChange={(e) => onChange({ ...sel, invert: e.target.checked })} />
              Invert
            </label>
          </div>

          {sel.kind === "subject" && (
            <div className="field">
              <button className="primary" onClick={() => onDetectSubject(sel.id)} disabled={detecting}>
                {detecting ? "Detecting…" : sel.raster ? "Detect again" : "Detect subject"}
              </button>
              <em>{sel.raster ? "subject found" : "runs on this computer"}</em>
            </div>
          )}
          {sel.kind === "radial" && (
            <Slider label="Feather" value={sel.feather} min={0} max={100} defaultValue={50} onChange={(v) => onChange({ ...sel, feather: v })} />
          )}
          {sel.kind === "luminance" && (
            <>
              <Slider
                label="Range low"
                value={sel.lumLo}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => onChange({ ...sel, lumLo: Math.min(v, sel.lumHi) })}
              />
              <Slider
                label="Range high"
                value={sel.lumHi}
                min={0}
                max={1}
                step={0.01}
                defaultValue={0.35}
                onChange={(v) => onChange({ ...sel, lumHi: Math.max(v, sel.lumLo) })}
              />
              <Slider
                label="Smoothness"
                value={sel.lumFeather}
                min={0.005}
                max={0.5}
                step={0.005}
                defaultValue={0.15}
                onChange={(v) => onChange({ ...sel, lumFeather: v })}
              />
            </>
          )}
          {sel.kind === "brush" && (
            <div className="mask-brush">
              <Slider
                label="Brush size"
                value={brush.size * 100}
                min={0.5}
                max={40}
                step={0.5}
                defaultValue={8}
                format={(v) => `${v.toFixed(1)}%`}
                onChange={(v) => onBrush({ ...brush, size: v / 100 })}
              />
              <Slider label="Feather" value={brush.feather} min={0} max={100} defaultValue={50} onChange={(v) => onBrush({ ...brush, feather: v })} />
              <Slider label="Flow" value={brush.flow} min={1} max={100} defaultValue={100} onChange={(v) => onBrush({ ...brush, flow: v })} />
              <div className="field">
                <button className={brush.erase ? "active" : ""} onClick={() => onBrush({ ...brush, erase: !brush.erase })}>
                  {brush.erase ? "Erasing" : "Painting"}
                </button>
                <button onClick={() => onChange({ ...sel, strokes: sel.strokes.slice(0, -1) })} disabled={sel.strokes.length === 0}>
                  Undo stroke
                </button>
                <button onClick={() => onChange({ ...sel, strokes: [] })} disabled={sel.strokes.length === 0}>
                  Clear
                </button>
              </div>
              <div className="hint">Paint on the photo. Hold Alt to erase. [ and ] change the brush size.</div>
            </div>
          )}

          <Slider label="Amount" value={sel.amount} min={0} max={100} defaultValue={100} onChange={(v) => onChange({ ...sel, amount: v })} />
          <div className="divider" />
          <Slider label="Exposure" value={sel.adjust.exposure} min={-4} max={4} step={0.05} onChange={setAdj("exposure")} />
          <Slider label="Contrast" value={sel.adjust.contrast} min={-100} max={100} onChange={setAdj("contrast")} />
          <Slider label="Highlights" value={sel.adjust.highlights} min={-100} max={100} onChange={setAdj("highlights")} />
          <Slider label="Shadows" value={sel.adjust.shadows} min={-100} max={100} onChange={setAdj("shadows")} />
          <Slider label="Whites" value={sel.adjust.whites} min={-100} max={100} onChange={setAdj("whites")} />
          <Slider label="Blacks" value={sel.adjust.blacks} min={-100} max={100} onChange={setAdj("blacks")} />
          <Slider
            label="Temperature"
            value={sel.adjust.temperature}
            min={-100}
            max={100}
            track="linear-gradient(90deg,#3e7be8,#777 50%,#f5b12b)"
            onChange={setAdj("temperature")}
          />
          <Slider
            label="Tint"
            value={sel.adjust.tint}
            min={-100}
            max={100}
            track="linear-gradient(90deg,#46a758,#777 50%,#d6409f)"
            onChange={setAdj("tint")}
          />
          <Slider label="Saturation" value={sel.adjust.saturation} min={-100} max={100} onChange={setAdj("saturation")} />
          <Slider label="Texture" value={sel.adjust.texture} min={-100} max={100} onChange={setAdj("texture")} />
          <Slider label="Clarity" value={sel.adjust.clarity} min={-100} max={100} onChange={setAdj("clarity")} />
          <Slider label="Dehaze" value={sel.adjust.dehaze} min={-100} max={100} onChange={setAdj("dehaze")} />
          <div className="curve-tabs">
            <span className="spacer" />
            <button className="tab" onClick={() => onChange({ ...sel, adjust: defaultMaskAdjust() })}>
              Reset sliders
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
