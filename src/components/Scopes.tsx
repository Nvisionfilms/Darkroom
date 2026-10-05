import { useEffect, useRef } from "react";
import type { Histogram as Hist } from "../types";
import { chroma, luma, skinAngle, vectorscope, waveform, VECTOR_TARGETS, type Frame } from "../scopes";

export type ScopeKind = "histogram" | "waveform" | "parade" | "vector";

export const SCOPE_LABELS: { id: ScopeKind; label: string }[] = [
  { id: "histogram", label: "Histogram" },
  { id: "waveform", label: "Waveform" },
  { id: "parade", label: "Parade" },
  { id: "vector", label: "Vector" },
];

interface Props {
  kind: ScopeKind;
  hist: Hist | null;
  /** the developed frame, downsampled, as the renderer reads it back */
  frame: Frame | null;
  /** draw the line complexions sit on, across the vectorscope */
  skinLine: boolean;
}

const W = 256;
const H = 128;

/** Trace accumulated counts onto the canvas, brightest where pixels pile up. */
function paint(img: ImageData, counts: Uint32Array, cols: number, rows: number, rgb: [number, number, number], gain: number) {
  let max = 1;
  for (let i = 0; i < counts.length; i++) if (counts[i] > max) max = counts[i];
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      const n = counts[y * cols + x];
      if (n === 0) continue;
      // a square root keeps a single stray pixel visible without the dense
      // parts flaring out into a solid block
      const a = Math.min(1, Math.sqrt(n / max) * gain);
      const o = (y * img.width + x) * 4;
      img.data[o] = Math.min(255, img.data[o] + rgb[0] * a);
      img.data[o + 1] = Math.min(255, img.data[o + 1] + rgb[1] * a);
      img.data[o + 2] = Math.min(255, img.data[o + 2] + rgb[2] * a);
      img.data[o + 3] = 255;
    }
  }
}

/**
 * Waveform, parade, vectorscope and histogram, drawn from the frame the
 * renderer already reads back for the histogram.
 *
 * The frame is the developed picture before the crop, which is where the
 * histogram has always been read from: the scopes show the whole photograph
 * rather than the part a crop has kept.
 */
export function Scopes({ kind, hist, frame, skinLine }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#121212";
    ctx.fillRect(0, 0, W, H);

    if (kind === "histogram") {
      if (!hist) return;
      let max = 1;
      for (let i = 1; i < 255; i++) max = Math.max(max, hist.r[i], hist.g[i], hist.b[i]);
      const scale = (v: number) => Math.sqrt(v / max) * (H - 4);
      ctx.globalCompositeOperation = "lighter";
      const draw = (bins: Uint32Array, color: string) => {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(0, H);
        for (let i = 0; i < 256; i++) ctx.lineTo(i, H - Math.min(H, scale(bins[i])));
        ctx.lineTo(255, H);
        ctx.closePath();
        ctx.fill();
      };
      draw(hist.r, "rgba(220,60,60,0.55)");
      draw(hist.g, "rgba(60,200,80,0.55)");
      draw(hist.b, "rgba(70,110,240,0.55)");
      ctx.globalCompositeOperation = "source-over";
      return;
    }

    if (!frame || frame.width === 0) return;
    const img = ctx.createImageData(W, H);

    if (kind === "waveform") {
      paint(img, waveform(frame, W, H, luma), W, H, [190, 230, 190], 2.2);
      ctx.putImageData(img, 0, 0);
    } else if (kind === "parade") {
      const cols = Math.floor(W / 3);
      const channels: [(r: number, g: number, b: number) => number, [number, number, number]][] = [
        [(r) => r, [235, 70, 70]],
        [(_r, g) => g, [70, 220, 90]],
        [(_r, _g, b) => b, [90, 130, 250]],
      ];
      channels.forEach(([pick, rgb], i) => {
        const counts = waveform(frame, cols, H, pick);
        // each panel is painted into its own third of the canvas
        const panel = ctx.createImageData(cols, H);
        paint(panel, counts, cols, H, rgb, 2.2);
        ctx.putImageData(panel, i * cols, 0);
      });
    } else {
      const size = H;
      const counts = vectorscope(frame, size);
      const vimg = ctx.createImageData(size, size);
      paint(vimg, counts, size, size, [200, 220, 200], 2.6);
      const left = Math.round((W - size) / 2);
      ctx.putImageData(vimg, left, 0);

      // graticule: the circle, the targets and the line complexions sit on
      const cx = left + size / 2;
      const cy = size / 2;
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.beginPath();
      ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,0.45)";
      ctx.font = "8px system-ui, sans-serif";
      for (const t of VECTOR_TARGETS) {
        const [cb, cr] = chroma(t.rgb[0], t.rgb[1], t.rgb[2]);
        const x = cx + cb * size;
        const y = cy - cr * size;
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.strokeRect(x - 3, y - 3, 6, 6);
        ctx.fillText(t.name, x + 5, y + 3);
      }
      if (skinLine) {
        const a = skinAngle();
        ctx.strokeStyle = "rgba(255,190,140,0.75)";
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(a) * size * 0.46, cy - Math.sin(a) * size * 0.46);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }
  }, [kind, hist, frame, skinLine]);

  return <canvas ref={ref} className="histogram" width={W} height={H} />;
}
