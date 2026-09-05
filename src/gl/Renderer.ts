import type { EditParams, Histogram, Mirror, PreviewImage } from "../types";
import {
  BLUR_FRAG,
  COMBINE_FRAG,
  COPY_FRAG,
  DENOISE_FRAG,
  DEVELOP_FRAG,
  DOWN2_FRAG,
  DOWNSAMPLE_FRAG,
  LOGLUMA_FRAG,
  MIRROR_FRAG,
  PREP_FRAG,
  PRESENT_FRAG,
  VERTEX,
  WATERMARK_FRAG,
} from "./shaders";

export interface View {
  /** screen (device) pixels per preview pixel */
  scale: number;
  /** device-pixel position of the image's top-left corner */
  x: number;
  y: number;
}

const HIST_W = 256;
const FULL_QUAD: number[] = [2, 0, 0, 0, 2, 0, -1, -1, 1];

/** Same radii as detail.rs::sigmas. */
export function blurSigmas(width: number, height: number): [number, number, number] {
  const long = Math.max(width, height);
  const s = long / 2560;
  return [1.0 * s, 4.0 * s, Math.max(0.02 * long, 8)];
}

const LUMA_709 = [0.2126, 0.7152, 0.0722];

function hsv2rgb(h: number, s: number, v: number): [number, number, number] {
  const hh = (((h % 1) + 1) % 1) * 6;
  const i = Math.floor(hh);
  const f = hh - i;
  const p = v * (1 - s);
  const q = v * (1 - s * f);
  const t = v * (1 - s * (1 - f));
  switch (i) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

/** Same as pipeline.rs tint_offset. */
export function tintOffset(hueDeg: number, sat: number): [number, number, number] {
  const c = hsv2rgb(hueDeg / 360, 1, 1);
  const l = c[0] * LUMA_709[0] + c[1] * LUMA_709[1] + c[2] * LUMA_709[2];
  const k = Math.max(0, Math.min(1, sat / 100)) * 0.3;
  return [(c[0] - l) * k, (c[1] - l) * k, (c[2] - l) * k];
}

export interface MirrorGeom {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  cos: number;
  sin: number;
  dx: number;
  dy: number;
  lx: number;
  ly: number;
  rd: number;
  tail: number;
  feather: number;
  opacity: number;
}

/** Same as pipeline.rs MirrorGeom::new, in image pixels. */
export function mirrorGeom(m: Mirror, width: number, height: number): MirrorGeom {
  const long = Math.max(width, height);
  const cx = m.cx * width;
  const cy = m.cy * height;
  const rx = Math.max(1, m.rx * long);
  const ry = Math.max(1, m.ry * long);
  const rot = (m.rotation * Math.PI) / 180;
  const dir = (m.direction * Math.PI) / 180;
  const dx = Math.cos(dir);
  const dy = Math.sin(dir);
  const phi = dir - rot;
  const rd = Math.sqrt((rx * Math.cos(phi)) ** 2 + (ry * Math.sin(phi)) ** 2);
  const gap = rd + Math.max(0, m.offset) * long;
  return {
    cx,
    cy,
    rx,
    ry,
    cos: Math.cos(rot),
    sin: Math.sin(rot),
    dx,
    dy,
    lx: cx + dx * gap,
    ly: cy + dy * gap,
    rd,
    tail: Math.max(1, m.length * long),
    feather: Math.max(0, Math.min(1, m.feather / 100)),
    opacity: Math.max(0, Math.min(1, m.opacity / 100)),
  };
}

/** Same as denoise.rs h_luma / h_chroma / HALF_RES_SIGMA. */
const hLuma = (sigma: number, a: number) => sigma * (0.4 + 2.1 * a);
const hChroma = (sigma: number, a: number) => sigma * (0.4 + 2.6 * a);
const HALF_RES_SIGMA = 0.7;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(s);
    gl.deleteShader(s);
    throw new Error(`shader compile failed: ${log}`);
  }
  return s;
}

/**
 * Create and link a program without waiting for the link to finish. Link
 * status is checked later in `Renderer.ready()`, so with
 * KHR_parallel_shader_compile the (slow, driver-side) compile happens on a
 * background thread instead of blocking the UI.
 */
function link(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
  gl.bindAttribLocation(p, 0, "aPos");
  gl.linkProgram(p);
  return p;
}

interface Tex {
  tex: WebGLTexture;
  w: number;
  h: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  private prog: Record<string, WebGLProgram>;
  private vao: WebGLVertexArrayObject;
  private fbo: WebGLFramebuffer;
  private imageTex: WebGLTexture;
  private lutTex: WebGLTexture;
  private t: Record<string, Tex> = {};
  private histPixels: Uint8Array = new Uint8Array(0);
  private uni = new Map<string, WebGLUniformLocation | null>();
  private prepKey = "";
  private sigma = 0;
  imgW = 0;
  imgH = 0;
  private qw = 1;
  private qh = 1;
  private histH = 1;

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    if (!gl.getExtension("EXT_color_buffer_float")) {
      throw new Error("EXT_color_buffer_float is not available (needed for float render targets)");
    }
    this.parallel = gl.getExtension("KHR_parallel_shader_compile") as { COMPLETION_STATUS_KHR: number } | null;
    this.prog = {
      prep: link(gl, VERTEX, PREP_FRAG),
      copy: link(gl, VERTEX, COPY_FRAG),
      denoise: link(gl, VERTEX, DENOISE_FRAG),
      down2: link(gl, VERTEX, DOWN2_FRAG),
      combine: link(gl, VERTEX, COMBINE_FRAG),
      logluma: link(gl, VERTEX, LOGLUMA_FRAG),
      blur: link(gl, VERTEX, BLUR_FRAG),
      down: link(gl, VERTEX, DOWNSAMPLE_FRAG),
      develop: link(gl, VERTEX, DEVELOP_FRAG),
      mirror: link(gl, VERTEX, MIRROR_FRAG),
      watermark: link(gl, VERTEX, WATERMARK_FRAG),
      present: link(gl, VERTEX, PRESENT_FRAG),
    };

    this.pending = Object.values(this.prog);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    // aPos is bound to location 0 in link() for every program
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.fbo = gl.createFramebuffer()!;
    this.imageTex = gl.createTexture()!;
    this.lutTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    this.setParams(gl.NEAREST);
    const ident = new Float32Array(1024);
    for (let r = 0; r < 4; r++) for (let i = 0; i < 256; i++) ident[r * 256 + i] = i / 255;
    this.setLut(ident);
  }

  private parallel: { COMPLETION_STATUS_KHR: number } | null = null;
  private pending: WebGLProgram[] = [];

  /**
   * True once every program has finished linking. While false, callers should
   * retry shortly instead of drawing; with parallel compile this never blocks.
   * Throws if a program failed to link.
   */
  ready(): boolean {
    if (this.pending.length === 0) return true;
    const gl = this.gl;
    const still: WebGLProgram[] = [];
    for (const p of this.pending) {
      if (this.parallel && !gl.getProgramParameter(p, this.parallel.COMPLETION_STATUS_KHR)) {
        still.push(p);
        continue;
      }
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
        throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
      }
    }
    this.pending = still;
    return still.length === 0;
  }

  private setParams(filter: number, mip = false): void {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mip ? gl.LINEAR_MIPMAP_LINEAR : filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private makeTex(name: string, internal: number, format: number, type: number, w: number, h: number, filter: number, mip = false): Tex {
    const gl = this.gl;
    const old = this.t[name];
    if (old) gl.deleteTexture(old.tex);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    this.setParams(filter, mip);
    const t = { tex, w, h };
    this.t[name] = t;
    return t;
  }

  private loc(prog: WebGLProgram, name: string): WebGLUniformLocation | null {
    const key = `${(prog as unknown as { __id?: number }).__id ?? Object.keys(this.prog).find((k) => this.prog[k] === prog)}:${name}`;
    if (!this.uni.has(key)) this.uni.set(key, this.gl.getUniformLocation(prog, name));
    return this.uni.get(key)!;
  }

  private bindTex(unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  /** Run a full-target quad pass into `target`. `setup` sets program-specific uniforms. */
  private pass(prog: WebGLProgram, target: Tex, setup: () => void): void {
    const gl = this.gl;
    gl.useProgram(prog);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, target.tex, 0);
    gl.viewport(0, 0, target.w, target.h);
    gl.uniformMatrix3fv(this.loc(prog, "uTransform"), false, FULL_QUAD);
    setup();
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  setImage(img: PreviewImage): void {
    const gl = this.gl;
    const t0 = performance.now();
    this.imgW = img.width;
    this.imgH = img.height;
    this.sigma = img.noiseSigma;
    this.prepKey = "";
    gl.bindTexture(gl.TEXTURE_2D, this.imageTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, img.width, img.height, 0, gl.RGB, gl.HALF_FLOAT, img.data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.setParams(gl.NEAREST);

    const W = img.width;
    const H = img.height;
    this.qw = Math.max(1, Math.floor(W / 4));
    this.qh = Math.max(1, Math.floor(H / 4));
    this.makeTex("P", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, W, H, gl.NEAREST);
    this.makeTex("D1", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, W, H, gl.NEAREST);
    this.makeTex("D", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, W, H, gl.LINEAR);
    const hw = Math.max(1, Math.floor(W / 2));
    const hh = Math.max(1, Math.floor(H / 2));
    this.makeTex("S2", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, hw, hh, gl.NEAREST);
    this.makeTex("P2", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, hw, hh, gl.NEAREST);
    this.makeTex("D2", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, hw, hh, gl.LINEAR);
    this.makeTex("D1s", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, hw, hh, gl.LINEAR);
    this.makeTex("Lg", gl.R16F, gl.RED, gl.HALF_FLOAT, W, H, gl.LINEAR);
    this.makeTex("tmp", gl.R16F, gl.RED, gl.HALF_FLOAT, W, H, gl.LINEAR);
    this.makeTex("B1", gl.R16F, gl.RED, gl.HALF_FLOAT, W, H, gl.LINEAR);
    this.makeTex("B2", gl.R16F, gl.RED, gl.HALF_FLOAT, W, H, gl.LINEAR);
    this.makeTex("LgQ", gl.R16F, gl.RED, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    this.makeTex("tmpQ", gl.R16F, gl.RED, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    this.makeTex("B3", gl.R16F, gl.RED, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    this.makeTex("dev", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
    this.makeTex("fx", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
    this.makeTex("fx2", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
    this.histH = Math.max(1, Math.round((HIST_W * H) / W));
    this.makeTex("hist", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, HIST_W, this.histH, gl.NEAREST);
    this.histPixels = new Uint8Array(HIST_W * this.histH * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    performance.measure("gl.setImage", { start: t0 });
  }

  setLut(lut: Float32Array): void {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 256, 4, 0, gl.RED, gl.FLOAT, lut);
  }

  private blur(src: Tex, tmp: Tex, dst: Tex, sigma: number): void {
    const gl = this.gl;
    const radius = Math.max(1, Math.ceil(3 * sigma));
    const p = this.prog.blur;
    const run = (from: Tex, to: Tex, dx: number, dy: number) =>
      this.pass(p, to, () => {
        this.bindTex(0, from.tex);
        gl.uniform1i(this.loc(p, "uSrc"), 0);
        gl.uniform2f(this.loc(p, "uStep"), dx / from.w, dy / from.h);
        gl.uniform1f(this.loc(p, "uSigma"), sigma);
        gl.uniform1i(this.loc(p, "uRadius"), radius);
      });
    run(src, tmp, 1, 0);
    run(tmp, dst, 0, 1);
  }

  /**
   * Whole-image passes that depend only on the source and the denoise
   * settings: denoise, log-luma and its blurs. Cached until those change.
   */
  prepare(p: EditParams): boolean {
    if (!this.imgW) return false;
    const gl = this.gl;
    const nl = Math.max(0, Math.min(1, p.denoiseLuma / 100));
    const nc = Math.max(0, Math.min(1, p.denoiseChroma / 100));
    const nd = Math.max(0, Math.min(1, p.denoiseDetail / 100));
    const key = `${nl}|${nc}|${nd}`;
    if (key === this.prepKey) return false;
    const T = this.t;
    const W = this.imgW;
    const H = this.imgH;

    const useDenoise = (nl > 0 || nc > 0) && this.sigma > 0;
    if (useDenoise) {
      const prep = (src: WebGLTexture, dst: Tex) =>
        this.pass(this.prog.prep, dst, () => {
          this.bindTex(0, src);
          gl.uniform1i(this.loc(this.prog.prep, "uImage"), 0);
        });
      const nlm = (src: WebGLTexture, p: Tex, dst: Tex, sigma: number) => {
        const pr = this.prog.denoise;
        this.pass(pr, dst, () => {
          this.bindTex(0, src);
          this.bindTex(1, p.tex);
          gl.uniform1i(this.loc(pr, "uImage"), 0);
          gl.uniform1i(this.loc(pr, "uP"), 1);
          gl.uniform2f(this.loc(pr, "uTexel"), 1 / dst.w, 1 / dst.h);
          gl.uniform1f(this.loc(pr, "uSigma"), sigma);
          gl.uniform1f(this.loc(pr, "uHl2"), hLuma(sigma, nl) ** 2);
          gl.uniform1f(this.loc(pr, "uHc2"), hChroma(sigma, nc) ** 2);
          gl.uniform1i(this.loc(pr, "uUseL"), nl > 0 ? 1 : 0);
          gl.uniform1i(this.loc(pr, "uUseC"), nc > 0 ? 1 : 0);
          gl.uniform1f(this.loc(pr, "uDetail"), nd);
          gl.uniform1i(this.loc(pr, "uR"), 3);
          gl.uniform1i(this.loc(pr, "uPr"), 1);
        });
      };
      const down2 = (src: Tex | WebGLTexture, srcW: number, srcH: number, dst: Tex) =>
        this.pass(this.prog.down2, dst, () => {
          this.bindTex(0, src instanceof WebGLTexture ? src : src.tex);
          gl.uniform1i(this.loc(this.prog.down2, "uSrc"), 0);
          gl.uniform2f(this.loc(this.prog.down2, "uTexel"), 1 / srcW, 1 / srcH);
        });
      // scale 1: full resolution
      prep(this.imageTex, T.P);
      nlm(this.imageTex, T.P, T.D1, this.sigma);
      // scale 2: half resolution
      down2(this.imageTex, W, H, T.S2);
      prep(T.S2.tex, T.P2);
      nlm(T.S2.tex, T.P2, T.D2, this.sigma * HALF_RES_SIGMA);
      down2(T.D1, W, H, T.D1s);
      // combine: D = D1 + up(D2) - up(down(D1))
      const cb = this.prog.combine;
      this.pass(cb, T.D, () => {
        this.bindTex(0, T.D1.tex);
        this.bindTex(1, T.D2.tex);
        this.bindTex(2, T.D1s.tex);
        gl.uniform1i(this.loc(cb, "uD1"), 0);
        gl.uniform1i(this.loc(cb, "uD2"), 1);
        gl.uniform1i(this.loc(cb, "uD1s"), 2);
      });
    } else {
      this.pass(this.prog.copy, T.D, () => {
        this.bindTex(0, this.imageTex);
        gl.uniform1i(this.loc(this.prog.copy, "uSrc"), 0);
      });
    }

    this.pass(this.prog.logluma, T.Lg, () => {
      this.bindTex(0, T.D.tex);
      gl.uniform1i(this.loc(this.prog.logluma, "uSrc"), 0);
    });
    const [s1, s2, s3] = blurSigmas(W, H);
    this.blur(T.Lg, T.tmp, T.B1, s1);
    this.blur(T.Lg, T.tmp, T.B2, s2);
    this.pass(this.prog.down, T.LgQ, () => {
      this.bindTex(0, T.Lg.tex);
      gl.uniform1i(this.loc(this.prog.down, "uSrc"), 0);
      gl.uniform2f(this.loc(this.prog.down, "uTexel"), 1 / W, 1 / H);
    });
    this.blur(T.LgQ, T.tmpQ, T.B3, s3 / 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.prepKey = key;
    return true;
  }

  private setDevelopUniforms(p: EditParams): void {
    const gl = this.gl;
    const d = this.prog.develop;
    const n = (v: number) => Math.max(-1, Math.min(1, v / 100));
    const f = (name: string, v: number) => gl.uniform1f(this.loc(d, name), v);
    f("uExposure", Math.max(-10, Math.min(10, p.exposure)));
    f("uContrast", n(p.contrast));
    f("uHighlights", n(p.highlights));
    f("uShadows", n(p.shadows));
    f("uWhites", n(p.whites));
    f("uBlacks", n(p.blacks));
    f("uTemp", n(p.temperature));
    f("uTint", n(p.tint));
    f("uVibrance", n(p.vibrance));
    f("uSaturation", n(p.saturation));
    f("uBaseContrast", Math.max(0, Math.min(1, p.baseContrast)));
    f("uTexture", n(p.texture));
    f("uClarity", n(p.clarity));
    gl.uniform1fv(this.loc(d, "uHslHue[0]"), Float32Array.from(p.hsl.hue, n));
    gl.uniform1fv(this.loc(d, "uHslSat[0]"), Float32Array.from(p.hsl.saturation, n));
    gl.uniform1fv(this.loc(d, "uHslLum[0]"), Float32Array.from(p.hsl.luminance, n));
    const gr = p.grading;
    gl.uniform3fv(this.loc(d, "uTintS"), tintOffset(gr.shadowHue, gr.shadowSat));
    gl.uniform3fv(this.loc(d, "uTintM"), tintOffset(gr.midHue, gr.midSat));
    gl.uniform3fv(this.loc(d, "uTintH"), tintOffset(gr.highHue, gr.highSat));
    f("uBalance", n(gr.balance));
    gl.uniform1i(this.loc(d, "uGradingOn"), gr.shadowSat > 0 || gr.midSat > 0 || gr.highSat > 0 ? 1 : 0);
    const T = this.t;
    this.bindTex(0, T.D.tex);
    this.bindTex(1, this.lutTex);
    this.bindTex(2, T.Lg.tex);
    this.bindTex(3, T.B1.tex);
    this.bindTex(4, T.B2.tex);
    this.bindTex(5, T.B3.tex);
    gl.uniform1i(this.loc(d, "uImage"), 0);
    gl.uniform1i(this.loc(d, "uLut"), 1);
    gl.uniform1i(this.loc(d, "uLg"), 2);
    gl.uniform1i(this.loc(d, "uB1"), 3);
    gl.uniform1i(this.loc(d, "uB2"), 4);
    gl.uniform1i(this.loc(d, "uB3"), 5);
    gl.uniform1i(this.loc(d, "uUseMaps"), 1);
  }

  /** Pass: run the per-pixel pipeline into the preview-sized framebuffer and the histogram framebuffer. */
  runDevelop(p: EditParams): void {
    if (!this.imgW) return;
    const gl = this.gl;
    const t0 = performance.now();
    const prepared = this.prepare(p);
    if (prepared) performance.measure("gl.prepare", { start: t0 });
    this.pass(this.prog.develop, this.t.dev, () => this.setDevelopUniforms(p));
    this.pass(this.prog.develop, this.t.hist, () => this.setDevelopUniforms(p));
    // dev uses mipmap filtering; it must be mip-complete before the mirror
    // pass samples it (and before display when no mirror is applied)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bindTex(0, this.t.dev.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    this.mirrorOn = p.mirror.enabled && p.mirror.opacity > 0;
    if (this.mirrorOn) {
      const g = mirrorGeom(p.mirror, this.imgW, this.imgH);
      const pr = this.prog.mirror;
      this.pass(pr, this.t.fx, () => {
        this.bindTex(0, this.t.dev.tex);
        gl.uniform1i(this.loc(pr, "uTex"), 0);
        gl.uniform2f(this.loc(pr, "uSize"), this.imgW, this.imgH);
        gl.uniform2f(this.loc(pr, "uCenter"), g.cx, g.cy);
        gl.uniform2f(this.loc(pr, "uRadii"), g.rx, g.ry);
        gl.uniform2f(this.loc(pr, "uCosSin"), g.cos, g.sin);
        gl.uniform2f(this.loc(pr, "uDir"), g.dx, g.dy);
        gl.uniform2f(this.loc(pr, "uLine"), g.lx, g.ly);
        gl.uniform1f(this.loc(pr, "uTail"), g.tail);
        gl.uniform1f(this.loc(pr, "uFeather"), g.feather);
        gl.uniform1f(this.loc(pr, "uOpacity"), g.opacity);
      });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.mirrorOn) {
      this.bindTex(0, this.t.fx.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    // watermark on top of whatever came out of the mirror stage
    const wm = p.watermark;
    this.watermarkOn = wm.enabled && wm.opacity > 0 && !!this.wmTex && this.wmPath === wm.path;
    if (this.watermarkOn) {
      const src = this.mirrorOn ? this.t.fx : this.t.dev;
      const long = Math.max(this.imgW, this.imgH);
      const dw = Math.max(1, wm.size * long);
      const dh = (dw * this.wmH) / this.wmW;
      const pr = this.prog.watermark;
      this.pass(pr, this.t.fx2, () => {
        this.bindTex(0, src.tex);
        this.bindTex(1, this.wmTex!);
        gl.uniform1i(this.loc(pr, "uTex"), 0);
        gl.uniform1i(this.loc(pr, "uWm"), 1);
        gl.uniform2f(this.loc(pr, "uSize"), this.imgW, this.imgH);
        gl.uniform4f(this.loc(pr, "uRect"), wm.x * this.imgW - dw / 2, wm.y * this.imgH - dh / 2, dw, dh);
        gl.uniform1f(this.loc(pr, "uOpacity"), Math.max(0, Math.min(1, wm.opacity / 100)));
      });
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.bindTex(0, this.t.fx2.tex);
      gl.generateMipmap(gl.TEXTURE_2D);
    }
    // fence so the histogram read-back can wait without blocking the UI thread
    if (this.histFence) gl.deleteSync(this.histFence);
    this.histFence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
  }

  private histFence: WebGLSync | null = null;

  /** True when the GPU has finished the last runDevelop, so readHistogram() will not stall. */
  histogramReady(): boolean {
    if (!this.histFence) return false;
    const gl = this.gl;
    const s = gl.clientWaitSync(this.histFence, 0, 0);
    return s === gl.ALREADY_SIGNALED || s === gl.CONDITION_SATISFIED;
  }

  private mirrorOn = false;
  private watermarkOn = false;
  private wmTex: WebGLTexture | null = null;
  private wmPath = "";
  private wmW = 1;
  private wmH = 1;
  private output(): Tex {
    if (this.watermarkOn) return this.t.fx2;
    return this.mirrorOn ? this.t.fx : this.t.dev;
  }

  /** Upload (or clear) the watermark overlay. `path` identifies which file the pixels belong to. */
  setWatermark(path: string, width: number, height: number, rgba: Uint8Array | null): void {
    const gl = this.gl;
    if (this.wmTex) {
      gl.deleteTexture(this.wmTex);
      this.wmTex = null;
    }
    this.wmPath = path;
    if (!rgba || !path) return;
    this.wmTex = gl.createTexture()!;
    this.wmW = width;
    this.wmH = height;
    gl.bindTexture(gl.TEXTURE_2D, this.wmTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.setParams(gl.LINEAR, true);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  /** Size of the image as displayed after rotation. */
  displaySize(rotation: number): { w: number; h: number } {
    return rotation % 180 === 0 ? { w: this.imgW, h: this.imgH } : { w: this.imgH, h: this.imgW };
  }

  /** Draw the developed image to the canvas with pan/zoom, rotation and output sharpening. */
  draw(view: View, sharpen: number, rotation = 0): void {
    const gl = this.gl;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, cw, ch);
    gl.clearColor(0.09, 0.09, 0.09, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.imgW) return;
    const pr = this.prog.present;
    gl.useProgram(pr);
    gl.bindVertexArray(this.vao);
    this.bindTex(0, this.output().tex);
    gl.uniform1i(this.loc(pr, "uTex"), 0);
    gl.uniform2f(this.loc(pr, "uTexel"), 1 / this.imgW, 1 / this.imgH);
    gl.uniform1f(this.loc(pr, "uSharpen"), Math.max(0, Math.min(1.5, sharpen / 100)));
    const W = this.imgW;
    const H = this.imgH;
    let px: [number, number, number];
    let py: [number, number, number];
    switch (((rotation % 360) + 360) % 360) {
      case 90:
        px = [0, -H, H];
        py = [W, 0, 0];
        break;
      case 180:
        px = [-W, 0, W];
        py = [0, -H, H];
        break;
      case 270:
        px = [0, H, 0];
        py = [-W, 0, W];
        break;
      default:
        px = [W, 0, 0];
        py = [0, H, 0];
    }
    const kx = (2 * view.scale) / cw;
    const ky = (-2 * view.scale) / ch;
    const A = kx * px[0];
    const B = kx * px[1];
    const C = kx * px[2] + (2 * view.x) / cw - 1;
    const D = ky * py[0];
    const E = ky * py[1];
    const F = ky * py[2] + 1 - (2 * view.y) / ch;
    gl.uniformMatrix3fv(this.loc(pr, "uTransform"), false, [A, D, 0, B, E, 0, C, F, 1]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  readHistogram(): Histogram {
    const gl = this.gl;
    const r = new Uint32Array(256);
    const g = new Uint32Array(256);
    const b = new Uint32Array(256);
    if (!this.imgW) return { r, g, b };
    const t0 = performance.now();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.t.hist.tex, 0);
    gl.readPixels(0, 0, HIST_W, this.histH, gl.RGBA, gl.UNSIGNED_BYTE, this.histPixels);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (this.histFence) {
      gl.deleteSync(this.histFence);
      this.histFence = null;
    }
    performance.measure("gl.readPixels", { start: t0 });
    const px = this.histPixels;
    for (let i = 0; i < px.length; i += 4) {
      r[px[i]]++;
      g[px[i + 1]]++;
      b[px[i + 2]]++;
    }
    return { r, g, b };
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.imageTex);
    gl.deleteTexture(this.lutTex);
    for (const t of Object.values(this.t)) gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(this.fbo);
    for (const p of Object.values(this.prog)) gl.deleteProgram(p);
  }
}
