import type { Lens, LensProfile } from "../types";
import { defaultLens } from "../types";
import { Slider } from "./Slider";

interface Props {
  lens: Lens;
  profile: LensProfile | null;
  /** camera and lens as read from the file, for the status line */
  camera?: string | null;
  lensName?: string | null;
  onChange: (l: Lens) => void;
}

const parts = (p: LensProfile): string[] => {
  const out: string[] = [];
  if (p.distModel !== 0) out.push("distortion");
  if (p.vig.some((v) => v !== 0)) out.push("vignetting");
  if (p.tca[0] !== 1 || p.tca[1] !== 1) out.push("colour fringing");
  return out;
};

/**
 * Lens correction. A calibration from the bundled lensfun database is used
 * when the camera and lens are recognised; the manual sliders work either way.
 */
export function LensPanel({ lens, profile, camera, lensName, onChange }: Props) {
  const set = <K extends keyof Lens>(k: K) => (v: Lens[K]) => onChange({ ...lens, [k]: v });
  const found = !!profile;
  return (
    <div className="lens-panel">
      <div className={"lens-status" + (found ? " found" : "")}>
        {found ? (
          <>
            <strong>{profile!.name}</strong>
            <small>Profile found: {parts(profile!).join(", ") || "no corrections"}</small>
          </>
        ) : (
          <>
            <strong>No profile for this lens</strong>
            <small>{lensName || camera || "Unknown lens"} — use the manual sliders below.</small>
          </>
        )}
      </div>

      {found && (
        <>
          <label className="feature-toggle">
            <span>
              <strong>Use lens profile</strong>
              <small>Correct this lens's known distortion, vignetting and fringing.</small>
            </span>
            <input type="checkbox" checked={lens.profile} onChange={(e) => set("profile")(e.target.checked)} />
          </label>
          {lens.profile && (
            <>
              <Slider
                label="Distortion"
                value={lens.distortionAmount}
                min={0}
                max={100}
                defaultValue={100}
                onChange={set("distortionAmount")}
              />
              <Slider
                label="Vignetting"
                value={lens.vignetteAmount}
                min={0}
                max={100}
                defaultValue={100}
                onChange={set("vignetteAmount")}
              />
              <label className="feature-toggle">
                <span>
                  <strong>Remove colour fringing</strong>
                  <small>Chromatic aberration from the profile.</small>
                </span>
                <input type="checkbox" checked={lens.ca} onChange={(e) => set("ca")(e.target.checked)} />
              </label>
            </>
          )}
          <div className="divider" />
        </>
      )}

      <div className="section-sub">Manual</div>
      <Slider label="Distortion" value={lens.manualDistortion} min={-100} max={100} onChange={set("manualDistortion")} />
      <Slider label="Vignette" value={lens.manualVignette} min={-100} max={100} onChange={set("manualVignette")} />
      {lens.manualVignette !== 0 && (
        <Slider
          label="Midpoint"
          value={lens.manualVignetteMid}
          min={0}
          max={100}
          defaultValue={50}
          onChange={set("manualVignetteMid")}
        />
      )}
      <Slider
        label="Red / cyan"
        value={lens.manualCaR}
        min={-100}
        max={100}
        track="linear-gradient(90deg,#2ab3c0,#777 50%,#e5484d)"
        onChange={set("manualCaR")}
      />
      <Slider
        label="Blue / yellow"
        value={lens.manualCaB}
        min={-100}
        max={100}
        track="linear-gradient(90deg,#f0c419,#777 50%,#3e7be8)"
        onChange={set("manualCaB")}
      />
      <div className="curve-tabs">
        <span className="spacer" />
        <button className="tab" onClick={() => onChange(defaultLens())}>
          Reset
        </button>
      </div>
      <div className="hint">
        Lens data comes from the open lensfun database. Judge fringing at 1:1 near the corners.
      </div>
    </div>
  );
}
