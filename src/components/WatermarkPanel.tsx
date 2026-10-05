import { useCallback, useEffect, useState } from "react";
import { importPhoto, pickWatermark, watermarkDelete, watermarkLibrary, watermarkSave, type WatermarkMark } from "../api";
import { defaultWatermark, type Watermark } from "../types";
import { Slider } from "./Slider";

interface Props {
  watermark: Watermark;
  onChange: (w: Watermark) => void;
  onError: (msg: string) => void;
}

function fileName(path: string): string {
  return path.split(/[\/]/).pop() ?? path;
}

/**
 * The watermark for this photo, plus a library of the ones you have used. A
 * mark in the library is a saved copy, so choosing it is a click and it survives
 * the original being tidied out of Downloads.
 */
export function WatermarkPanel({ watermark, onChange, onError }: Props) {
  const [library, setLibrary] = useState<WatermarkMark[]>([]);

  const refresh = useCallback(() => {
    watermarkLibrary()
      .then(setLibrary)
      .catch((e) => onError(`Could not read the watermark library: ${String(e)}`));
  }, [onError]);
  useEffect(refresh, [refresh]);

  const choose = async () => {
    try {
      const picked = await pickWatermark();
      const p = picked ? await importPhoto(picked) : null;
      if (!p) return;
      // a mark you picked is worth keeping: save it, and use the saved copy
      const saved = await watermarkSave(p).catch(() => null);
      onChange({ ...watermark, path: saved?.path ?? p, enabled: true });
      refresh();
    } catch (e) {
      onError(`Could not open watermark: ${String(e)}`);
    }
  };

  const remove = async (m: WatermarkMark) => {
    try {
      await watermarkDelete(m.name);
      // taking the mark out of the library must not leave this photo pointing at
      // a file that is no longer there
      if (watermark.path === m.path) onChange(defaultWatermark());
      refresh();
    } catch (e) {
      onError(`Could not remove ${m.name}: ${String(e)}`);
    }
  };

  return (
    <div className={"watermark-panel" + (watermark.enabled ? "" : " disabled")}>
      <div className="field">
        <button onClick={choose}>Add image…</button>
        <em className="wm-name" title={watermark.path}>
          {watermark.path ? fileName(watermark.path) : "no image"}
        </em>
      </div>

      {library.length > 0 && (
        <ul className="mask-list wm-library">
          {library.map((m) => (
            <li
              key={m.path}
              className={"mask-row" + (m.path === watermark.path ? " selected" : "")}
              onClick={() => onChange({ ...watermark, path: m.path, enabled: true })}
            >
              <span className="mask-glyph">▣</span>
              <span className="mask-name">{m.name}</span>
              <button
                className="mask-delete"
                title="Remove from the library"
                onClick={(e) => {
                  e.stopPropagation();
                  void remove(m);
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="hint">
        Drag the watermark on the photo to move it, drag its corner to resize. Choosing Export lets you put it on every
        photo you export, not just this one.
      </div>
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
