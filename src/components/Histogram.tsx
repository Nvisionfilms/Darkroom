import { useEffect, useRef } from "react";
import type { Histogram as Hist } from "../types";

interface Props {
  hist: Hist | null;
}

const W = 256;
const H = 110;

export function Histogram({ hist }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#161616";
    ctx.fillRect(0, 0, W, H);
    if (!hist) return;
    let max = 1;
    for (let i = 1; i < 255; i++) {
      max = Math.max(max, hist.r[i], hist.g[i], hist.b[i]);
    }
    const scale = (v: number) => (Math.sqrt(v / max) * (H - 4));
    ctx.globalCompositeOperation = "lighter";
    const draw = (bins: Uint32Array, color: string) => {
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.moveTo(0, H);
      for (let i = 0; i < 256; i++) {
        ctx.lineTo(i, H - Math.min(H, scale(bins[i])));
      }
      ctx.lineTo(255, H);
      ctx.closePath();
      ctx.fill();
    };
    draw(hist.r, "rgba(220,60,60,0.55)");
    draw(hist.g, "rgba(60,200,80,0.55)");
    draw(hist.b, "rgba(70,110,240,0.55)");
    ctx.globalCompositeOperation = "source-over";
    // clipping indicators
    const clipL = hist.r[0] + hist.g[0] + hist.b[0];
    const clipR = hist.r[255] + hist.g[255] + hist.b[255];
    const total = hist.r.reduce((a, b) => a + b, 0) * 3;
    if (clipL / total > 0.002) {
      ctx.fillStyle = "#ddd";
      ctx.fillRect(2, 2, 6, 6);
    }
    if (clipR / total > 0.002) {
      ctx.fillStyle = "#e33";
      ctx.fillRect(W - 8, 2, 6, 6);
    }
  }, [hist]);
  return <canvas ref={ref} className="histogram" width={W} height={H} />;
}
