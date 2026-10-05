import { closed } from "../toneMatch";
import type { ToneMatch } from "../types";
import { Slider } from "./Slider";
import type { StripPhoto } from "./DoubleExposurePanel";

interface Props {
  disabled: boolean;
  busy: boolean;
  /** the reference in use, if a match has been made */
  match: { name: string; result: ToneMatch; strength: number } | null;
  strip: StripPhoto[];
  currentPath: string | null;
  onPick: () => void;
  onPickFromStrip: (path: string) => void;
  onStrength: (percent: number) => void;
  onClear: () => void;
}

const W = 232;
const H = 84;
const PCT = [1, 5, 25, 50, 75, 95, 99];

/**
 * The brightness at each percentile for the reference, the photo as it was and
 * the photo now. A match is hard to judge from slider numbers alone; the three
 * lines say it directly - the white one should run along the accent one.
 */
function Curves({ result }: { result: ToneMatch }) {
  const x = (i: number) => 6 + (i / (PCT.length - 1)) * (W - 12);
  const y = (v: number) => H - 6 - Math.max(0, Math.min(1, v)) * (H - 12);
  const line = (q: number[]) => q.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <svg className="tm-curves" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Brightness at each percentile">
      <rect x="0" y="0" width={W} height={H} fill="#121212" rx="4" />
      {/* a picture spread evenly from black to white would sit on this line */}
      <path d={line(PCT.map((p) => p / 100))} stroke="rgba(255,255,255,0.08)" fill="none" strokeDasharray="2 3" />
      <path d={line(result.before.q)} stroke="rgba(255,255,255,0.28)" strokeWidth="1.5" fill="none" />
      <path d={line(result.reference.q)} stroke="#8aa2ff" strokeWidth="2" fill="none" />
      <path d={line(result.after.q)} stroke="#ffffff" strokeWidth="1.5" fill="none" strokeDasharray="4 2" />
    </svg>
  );
}

/**
 * Tone match: choose a reference picture and the photo's sliders are set to
 * make it look like that. What comes back is ordinary slider values, so it can
 * be backed off with Strength, adjusted by hand afterwards, or undone.
 */
export function ToneMatchPanel({ disabled, busy, match, strip, currentPath, onPick, onPickFromStrip, onStrength, onClear }: Props) {
  const others = strip.filter((p) => p.path !== currentPath);
  return (
    <div className="tonematch-panel">
      <div className="field">
        <button className="primary" onClick={onPick} disabled={disabled || busy}>
          {busy ? "Matching…" : match ? "Another reference…" : "Choose a reference…"}
        </button>
        {match && (
          <button className="tab" onClick={onClear} disabled={busy}>
            Undo match
          </button>
        )}
      </div>

      {others.length > 0 && (
        <label className="field">
          <span>From your photos</span>
          <select
            value=""
            disabled={disabled || busy}
            onChange={(e) => e.target.value && onPickFromStrip(e.target.value)}
          >
            <option value="">Choose…</option>
            {others.map((p) => (
              <option key={p.path} value={p.path}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {match ? (
        <>
          <div className="blend-file">
            <strong title={match.name}>{match.name}</strong>
          </div>
          <Curves result={match.result} />
          <div className="hint">
            Closed {closed(match.result.distanceBefore, match.result.distanceAfter).toFixed(0)}% of the gap. Blue is the
            reference, grey is the photo before, white is the photo now.
          </div>
          <Slider label="Strength" value={match.strength} min={0} max={100} defaultValue={100} onChange={onStrength} />
        </>
      ) : (
        <div className="hint">
          Pick a picture whose look you want. NFrame Studio measures how it is spread from shadow to highlight and how its
          colour is balanced, then sets Exposure, Contrast, Highlights, Shadows, Whites, Blacks, Temperature, Tint and
          Saturation to bring the photo as close as it can. They are ordinary sliders, so you can adjust them, back the
          whole match off with Strength, or undo it.
        </div>
      )}
      {match && (
        <div className="hint">
          It matches tone and balance, not content: a sunset will not turn a grey sky into one, and a reference with a
          strong colour cast passes some of it on — bring Strength down if it does.
        </div>
      )}
    </div>
  );
}
