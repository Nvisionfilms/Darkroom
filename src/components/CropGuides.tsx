import type { Mapper } from "./MirrorOverlay";

export type GuideKind = "none" | "thirds" | "grid" | "golden" | "spiral" | "triangle" | "diagonal";

export const GUIDES: { key: GuideKind; label: string }[] = [
  { key: "none", label: "None" },
  { key: "thirds", label: "Thirds" },
  { key: "grid", label: "Grid" },
  { key: "golden", label: "Golden Ratio" },
  { key: "spiral", label: "Golden Spiral" },
  { key: "triangle", label: "Golden Triangle" },
  { key: "diagonal", label: "Diagonal" },
];

const PHI = 1.618033988749895;

interface Props {
  kind: GuideKind;
  /** 0..3: mirrors the spiral / triangle horizontally and/or vertically */
  flip: number;
  /** crop rectangle in straightened-canvas pixels */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mapper: Mapper;
}

/**
 * Crop guide overlays in the Lightroom set. Everything is computed in canvas
 * space and mapped to the screen through the mapper, so guides follow the
 * straighten angle and rotation.
 */
export function CropGuides({ kind, flip, x0, y0, x1, y1, mapper }: Props) {
  if (kind === "none") return null;
  const P = (x: number, y: number) => mapper.canvasToScreen(x, y);
  const w = x1 - x0;
  const h = y1 - y0;
  const fx = (flip & 1) !== 0;
  const fy = (flip & 2) !== 0;
  // normalised (u, v) in 0..1 inside the crop, honouring the flip
  const at = (u: number, v: number) => P(x0 + (fx ? 1 - u : u) * w, y0 + (fy ? 1 - v : v) * h);
  const line = (a: [number, number], b: [number, number], key: string, cls = "") => (
    <line key={key} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} className={cls} />
  );
  const els: React.ReactNode[] = [];

  switch (kind) {
    case "thirds":
      for (const t of [1 / 3, 2 / 3]) {
        els.push(line(at(t, 0), at(t, 1), `v${t}`));
        els.push(line(at(0, t), at(1, t), `h${t}`));
      }
      break;
    case "golden":
      for (const t of [1 - 1 / PHI, 1 / PHI]) {
        els.push(line(at(t, 0), at(t, 1), `v${t}`));
        els.push(line(at(0, t), at(1, t), `h${t}`));
      }
      break;
    case "grid": {
      // square-ish cells, about 8 across the long side
      const long = Math.max(w, h);
      const cell = long / 8;
      const nx = Math.max(2, Math.round(w / cell));
      const ny = Math.max(2, Math.round(h / cell));
      for (let i = 1; i < nx; i++) els.push(line(at(i / nx, 0), at(i / nx, 1), `v${i}`, "fine"));
      for (let j = 1; j < ny; j++) els.push(line(at(0, j / ny), at(1, j / ny), `h${j}`, "fine"));
      break;
    }
    case "diagonal": {
      // 45° lines from each corner, forming a central diamond
      const s = Math.min(w, h);
      const su = s / w;
      const sv = s / h;
      els.push(line(at(0, 0), at(su, sv), "a"));
      els.push(line(at(1, 0), at(1 - su, sv), "b"));
      els.push(line(at(0, 1), at(su, 1 - sv), "c"));
      els.push(line(at(1, 1), at(1 - su, 1 - sv), "d"));
      break;
    }
    case "triangle": {
      // main diagonal plus the perpendiculars from the other two corners
      // (computed in pixel space so the right angles are real)
      const dx = w;
      const dy = h;
      const len2 = dx * dx + dy * dy;
      const foot = (px: number, py: number): [number, number] => {
        const t = (px * dx + py * dy) / len2;
        return [t * dx, t * dy];
      };
      const f1 = foot(w, 0);
      const f2 = foot(0, h);
      els.push(line(at(0, 0), at(1, 1), "diag"));
      els.push(line(at(1, 0), at(f1[0] / w, f1[1] / h), "p1"));
      els.push(line(at(0, 1), at(f2[0] / w, f2[1] / h), "p2"));
      break;
    }
    case "spiral": {
      // Fibonacci spiral built in a unit golden rectangle (PHI x 1), then
      // stretched onto the crop. Arcs become elliptical under the stretch.
      const sx = w / PHI;
      const sy = h;
      const rot = mapper.screenRotation;
      const scale = mapper.scale; // CSS px per canvas px
      const map = (u: number, v: number) => at(u / PHI, v);
      let rx = 0;
      let ry = 0;
      let rw = PHI;
      let rh = 1;
      let d = 0;
      let path = "";
      const sweep = fx !== fy ? 0 : 1;
      const squares: React.ReactNode[] = [];
      for (let i = 0; i < 9; i++) {
        let s: number;
        let from: [number, number];
        let to: [number, number];
        let sq: [number, number, number, number];
        switch (d) {
          case 0:
            s = rh;
            sq = [rx, ry, s, s];
            from = [rx, ry + s];
            to = [rx + s, ry];
            rx += s;
            rw -= s;
            break;
          case 1:
            s = rw;
            sq = [rx, ry, s, s];
            from = [rx, ry];
            to = [rx + s, ry + s];
            ry += s;
            rh -= s;
            break;
          case 2:
            s = rh;
            sq = [rx + rw - s, ry, s, s];
            from = [rx + rw, ry];
            to = [rx + rw - s, ry + s];
            rw -= s;
            break;
          default:
            s = rw;
            sq = [rx, ry + rh - s, s, s];
            from = [rx + s, ry + rh];
            to = [rx, ry + rh - s];
            rh -= s;
        }
        if (s <= 1e-4) break;
        const a = map(from[0], from[1]);
        const b = map(to[0], to[1]);
        if (i === 0) path += `M ${a[0]} ${a[1]} `;
        path += `A ${s * sx * scale} ${s * sy * scale} ${rot} 0 ${sweep} ${b[0]} ${b[1]} `;
        if (i < 6) {
          const c0 = map(sq[0], sq[1]);
          const c1 = map(sq[0] + sq[2], sq[1]);
          const c2 = map(sq[0] + sq[2], sq[1] + sq[3]);
          const c3 = map(sq[0], sq[1] + sq[3]);
          squares.push(
            <polygon key={`sq${i}`} className="fine" points={[c0, c1, c2, c3].map((p) => p.join(",")).join(" ")} />,
          );
        }
        d = (d + 1) % 4;
      }
      els.push(...squares);
      els.push(<path key="spiral" d={path} className="spiral" />);
      break;
    }
  }
  return <g className="crop-guides">{els}</g>;
}

export function nextGuide(kind: GuideKind): GuideKind {
  const i = GUIDES.findIndex((g) => g.key === kind);
  return GUIDES[(i + 1) % GUIDES.length].key;
}
