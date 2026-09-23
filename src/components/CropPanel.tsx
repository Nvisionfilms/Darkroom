import { defaultCrop, type Crop } from "../types";
import { GUIDES, type GuideKind } from "./CropGuides";
import { Slider } from "./Slider";

export const ASPECTS: { key: string; label: string; ratio: number | null }[] = [
  { key: "free", label: "Free", ratio: null },
  { key: "original", label: "Original", ratio: -1 },
  { key: "1:1", label: "1 : 1", ratio: 1 },
  { key: "4:5", label: "4 : 5", ratio: 4 / 5 },
  { key: "5:4", label: "5 : 4", ratio: 5 / 4 },
  { key: "2:3", label: "2 : 3", ratio: 2 / 3 },
  { key: "3:2", label: "3 : 2", ratio: 3 / 2 },
  { key: "3:4", label: "3 : 4", ratio: 3 / 4 },
  { key: "4:3", label: "4 : 3", ratio: 4 / 3 },
  { key: "9:16", label: "9 : 16", ratio: 9 / 16 },
  { key: "16:9", label: "16 : 9", ratio: 16 / 9 },
];

interface Props {
  crop: Crop;
  cropMode: boolean;
  aspectKey: string;
  imageWidth: number;
  imageHeight: number;
  onChange: (c: Crop) => void;
  onAspect: (key: string) => void;
  onToggleMode: () => void;
  guide: GuideKind;
  onGuide: (g: GuideKind) => void;
}

/** Resolve an aspect key to a pixel width/height ratio for this image. */
export function aspectRatio(key: string, imageWidth: number, imageHeight: number): number | null {
  const a = ASPECTS.find((x) => x.key === key);
  if (!a || a.ratio === null) return null;
  if (a.ratio === -1) return imageWidth / Math.max(1, imageHeight);
  return a.ratio;
}

/**
 * The biggest rectangle of this aspect that fits the whole image, kept over
 * the current crop's centre.
 *
 * It is sized against the image rather than against the current crop on
 * purpose: fitting each new ratio inside the previous rectangle shrank the
 * frame a little every time, so cycling through the ratios wound the crop
 * down to nothing instead of showing each one.
 */
export function fitAspect(ratio: number | null, imageWidth: number, imageHeight: number, base: Crop): Crop {
  if (!ratio) return base;
  let w = imageWidth;
  let h = imageWidth / ratio;
  if (h > imageHeight) {
    h = imageHeight;
    w = imageHeight * ratio;
  }
  const nw = w / imageWidth;
  const nh = h / imageHeight;
  const cx = base.x + base.w / 2;
  const cy = base.y + base.h / 2;
  const x = Math.max(0, Math.min(1 - nw, cx - nw / 2));
  const y = Math.max(0, Math.min(1 - nh, cy - nh / 2));
  return { ...base, x, y, w: nw, h: nh };
}

export function CropPanel({
  crop,
  cropMode,
  aspectKey,
  imageWidth,
  imageHeight,
  onChange,
  onAspect,
  onToggleMode,
  guide,
  onGuide,
}: Props) {
  const outW = Math.round(crop.w * imageWidth);
  const outH = Math.round(crop.h * imageHeight);
  return (
    <div className="crop-panel">
      <div className="field">
        <button className={cropMode ? "active" : ""} onClick={onToggleMode}>
          {cropMode ? "Done" : "Crop…"}
        </button>
        <em>
          {crop.enabled ? `${outW} × ${outH}` : "off"}
        </em>
      </div>
      <label className="field">
        <span>Aspect</span>
        <select value={aspectKey} onChange={(e) => onAspect(e.target.value)}>
          {ASPECTS.map((a) => (
            <option key={a.key} value={a.key}>
              {a.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        <span>Guide</span>
        <select value={guide} onChange={(e) => onGuide(e.target.value as GuideKind)}>
          {GUIDES.map((g) => (
            <option key={g.key} value={g.key}>
              {g.label}
            </option>
          ))}
        </select>
        <em title="O cycles guides, Shift+O flips the spiral or triangle">O</em>
      </label>
      <Slider
        label="Straighten"
        value={crop.angle}
        min={-45}
        max={45}
        step={0.1}
        onChange={(v) => onChange({ ...crop, angle: v, enabled: true })}
      />
      <div className="hint">Drag inside the frame to move it, the edges and corners to resize. Enter or Esc leaves crop mode.</div>
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultCrop(), enabled: crop.enabled })}>
          Reset
        </button>
        <button className="tab" onClick={() => onChange(defaultCrop())}>
          Remove crop
        </button>
      </div>
    </div>
  );
}
