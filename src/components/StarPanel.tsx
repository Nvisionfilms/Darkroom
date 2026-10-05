import { defaultStar, type Mask, type Star } from "../types";
import { Slider } from "./Slider";

interface Props {
  star: Star;
  onChange: (s: Star) => void;
  masks: Mask[];
}

const POINTS = [4, 6, 8, 10, 12];

/**
 * Cross-screen ("starburst") filter: the glass filter photographers screw onto
 * the lens to turn street lamps and specular highlights into stars. Every
 * streak is made from light already in the frame.
 */
export function StarPanel({ star, onChange, masks }: Props) {
  const sources = masks.filter((m) => m.mode !== "subtract");
  const chosen = sources.find((m) => m.id === star.mask) ?? null;
  const set =
    <K extends keyof Star>(key: K) =>
    (v: Star[K]) =>
      onChange({ ...star, [key]: v });

  return (
    <div className={"star-panel" + (star.enabled ? "" : " disabled")}>
      <div className="hint">
        Smears the highlights that are already in the photo along a few directions, the way a ruled glass filter
        diffracts light. Nothing is generated: with no highlights above the threshold the picture is untouched.
      </div>
      <div className="field">
        <label htmlFor="star-source">Stars from</label>
        <select id="star-source" value={chosen ? chosen.id : ""} onChange={(e) => set("mask")(e.target.value)}>
          <option value="">Whole photo</option>
          {sources.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
      </div>
      {chosen ? (
        <div className="hint">
          Only the lights inside <strong>{chosen.name}</strong> grow stars, whether or not the mask is shown. The streaks
          run on past its edge, the way light does.
        </div>
      ) : sources.length === 0 ? (
        <div className="hint">Add a mask under Masks to star just some of the lights.</div>
      ) : null}
      <div className="field">
        <label htmlFor="star-points">Points</label>
        <select id="star-points" value={star.points} onChange={(e) => set("points")(Number(e.target.value))}>
          {POINTS.map((n) => (
            <option key={n} value={n}>
              {n}
              {n === 4 ? " (cross screen)" : ""}
            </option>
          ))}
        </select>
      </div>
      <Slider label="Amount" value={star.amount} min={0} max={100} defaultValue={60} onChange={set("amount")} />
      <Slider label="Length" value={star.length} min={0} max={100} defaultValue={35} onChange={set("length")} />
      <Slider label="Angle" value={star.angle} min={-90} max={90} defaultValue={0} onChange={set("angle")} />
      <Slider
        label="Threshold"
        value={star.threshold}
        min={0}
        max={100}
        defaultValue={75}
        onChange={set("threshold")}
      />
      <Slider label="Falloff" value={star.falloff} min={0} max={100} defaultValue={40} onChange={set("falloff")} />
      <Slider
        label="Dispersion"
        value={star.dispersion}
        min={0}
        max={100}
        defaultValue={25}
        onChange={set("dispersion")}
      />
      <div className="hint">
        Threshold decides what counts as a highlight — lower it to star more of the picture. Dispersion spreads the ends
        of the streaks into colour, as real glass does.
      </div>
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange({ ...defaultStar(), enabled: star.enabled })}>
          Reset
        </button>
      </div>
    </div>
  );
}
