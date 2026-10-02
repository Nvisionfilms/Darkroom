import { defaultMirror, type Mask, type Mirror } from "../types";
import { Slider } from "./Slider";

interface Props {
  mirror: Mirror;
  /** masks on this photo, any of which can be the source of the trail */
  masks: Mask[];
  onChange: (m: Mirror) => void;
}

/**
 * Motion Trails keeps the legacy `mirror` wire shape so old sidecars continue
 * to load. The old geometry fields are intentionally repurposed:
 *   cx -> copies / 10, rx -> blur / 100, ry -> amount / 100,
 *   feather -> fade, offset -> image-edge feather, length -> distance,
 *   direction/opacity keep their meaning. `mask` is new.
 */
export function MirrorPanel({ mirror, masks, onChange }: Props) {
  const set = <K extends keyof Mirror>(key: K) => (v: Mirror[K]) => onChange({ ...mirror, [key]: v });
  const copies = Math.max(1, Math.min(24, Math.round(mirror.cx * 10)));
  // only ordinary masks can head a trail; a subtraction belongs to the one above it
  const sources = masks.filter((m) => m.mode !== "subtract");
  const chosen = sources.find((m) => m.id === mirror.mask) ?? null;

  return (
    <div className={"mirror-panel" + (mirror.enabled ? "" : " disabled")}>
      <div className="hint">
        Repeats part of the developed photo in one direction, like a long-exposure motion echo. Every echo is made from
        pixels that are already in the picture - no generative AI.
      </div>
      <div className="field">
        <label htmlFor="trail-source">Trail from</label>
        <select id="trail-source" value={chosen ? chosen.id : ""} onChange={(e) => set("mask")(e.target.value)}>
          <option value="">Whole photo</option>
          {sources.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {sources.length === 0 ? (
        <div className="hint">Add a mask under Masks to trail just one subject instead of the whole frame.</div>
      ) : chosen ? (
        <div className="hint">
          The trail is cut from <strong>{chosen.name}</strong> and streaks around it. That area keeps its own pixels, so
          the subject stays sharp.
        </div>
      ) : (
        <div className="hint">The whole frame echoes. Pick a mask above to trail one subject instead.</div>
      )}
      <Slider
        label="Amount"
        value={mirror.ry * 100}
        min={0}
        max={100}
        defaultValue={70}
        onChange={(v) => set("ry")(v / 100)}
      />
      <Slider
        label="Direction"
        value={mirror.direction}
        min={-180}
        max={180}
        defaultValue={-35}
        onChange={set("direction")}
      />
      <Slider
        label="Distance"
        value={mirror.length * 100}
        min={1}
        max={70}
        defaultValue={16}
        onChange={(v) => set("length")(v / 100)}
      />
      <Slider
        label="Copies"
        value={copies}
        min={1}
        max={24}
        step={1}
        defaultValue={4}
        onChange={(v) => set("cx")(Math.round(v) / 10)}
      />
      <Slider label="Fade" value={mirror.feather} min={0} max={100} defaultValue={65} onChange={set("feather")} />
      <Slider
        label={chosen ? "Subject Feather" : "Edge Feather"}
        value={mirror.offset * 100}
        min={0}
        max={25}
        defaultValue={8}
        onChange={(v) => set("offset")(v / 100)}
      />
      <div className="hint">
        {chosen
          ? "Subject Feather softens the edge of the mask the trail is cut from, so the echoes fade off the subject instead of ending on a cut line."
          : "Edge Feather softens the frame boundary, so translated copies do not show a hard rectangular seam."}{" "}
        A cut-out subject echoes as separate ghosts until there are enough Copies to join up — try 12 or more.
      </div>
      <Slider
        label="Blur"
        value={mirror.rx * 100}
        min={0}
        max={100}
        defaultValue={20}
        onChange={(v) => set("rx")(v / 100)}
      />
      <Slider label="Opacity" value={mirror.opacity} min={0} max={100} defaultValue={65} onChange={set("opacity")} />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultMirror(), enabled: mirror.enabled, mask: mirror.mask })}>
          Reset
        </button>
      </div>
    </div>
  );
}
