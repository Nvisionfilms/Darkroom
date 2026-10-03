import {
  cropIsIdentity,
  MASK_ADJUST_KEYS,
  type Crop,
  type EditParams,
  type Histogram,
  type Mask,
  type Mirror,
  type PreviewImage,
} from "../types";
import { maskKindCode, shaderMasks, type Rect } from "../mask";
import { makeWarp, warpHasVignette, warpIsIdentity, type Warp } from "../geometry";
import { look as profileLook } from "../profiles";
import { columnMajor, lookInput } from "../camlog";
import { modeId, placement } from "../blend";
import { starActive, starDispersion, starFadeExp, starGain, starLenPx, starLines, starThreshold } from "../star";
import {
  BLUR_FRAG,
  COMBINE_FRAG,
  COPY_FRAG,
  DARK_FRAG,
  DENOISE_FRAG,
  DEVELOP_FRAG,
  DOWN2_FRAG,
  DOWNSAMPLE_FRAG,
  HEAL_FRAG,
  IDENTITY3,
  LOGLUMA_FRAG,
  MASK_ADJ_STRIDE,
  MASK_MODE_ADD,
  MASK_MODE_SUBTRACT,
  MAX_HEAL,
  MAX_PATH,
  MAX_MASKS,
  MIRROR_FRAG,
  PREP_FRAG,
  PRESENT_FRAG,
  STAR_ADD_FRAG,
  STAR_HI_FRAG,
  STAR_STREAK_FRAG,
  VERTEX,
  WATERMARK_FRAG,
} from "./shaders";

/** A mask raster kept on the JS side, mirrored into a slot texture when the mask is in use. */
interface RasterEntry {
  data: Uint8Array;
  w: number;
  h: number;
  version: number;
}

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

/** Same as denoise.rs h_luma / h_chroma / RESPONSE / HALF_RES_SIGMA. */
const RESPONSE = 2.0;
const hLuma = (sigma: number, a: number) => sigma * (0.4 + 4.0 * a ** RESPONSE);
const hChroma = (sigma: number, a: number) => sigma * (0.4 + 5.2 * a ** RESPONSE);
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
      heal: link(gl, VERTEX, HEAL_FRAG),
      logluma: link(gl, VERTEX, LOGLUMA_FRAG),
      dark: link(gl, VERTEX, DARK_FRAG),
      blur: link(gl, VERTEX, BLUR_FRAG),
      down: link(gl, VERTEX, DOWNSAMPLE_FRAG),
      develop: link(gl, VERTEX, DEVELOP_FRAG),
      starHi: link(gl, VERTEX, STAR_HI_FRAG),
      starStreak: link(gl, VERTEX, STAR_STREAK_FRAG),
      starAdd: link(gl, VERTEX, STAR_ADD_FRAG),
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
    gl.uniformMatrix3fv(this.loc(prog, "uUvMat"), false, IDENTITY3);
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
    this.makeTex("H", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, W, H, gl.NEAREST);
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
    // haze veil: dark channel, quarter res, blurred with the clarity radius
    this.makeTex("Dk", gl.R16F, gl.RED, gl.HALF_FLOAT, W, H, gl.NEAREST);
    this.makeTex("DkQ", gl.R16F, gl.RED, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    this.makeTex("V", gl.R16F, gl.RED, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    // globally developed picture, sampled by luminance-range masks
    this.makeTex("devG", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR);
    // mask rasters (brush, subject) live at half resolution, one array
    // texture layer each so they cost a single texture unit
    this.mw = Math.max(1, Math.ceil(W / 2));
    this.mh = Math.max(1, Math.ceil(H / 2));
    if (this.maskTex) gl.deleteTexture(this.maskTex);
    this.maskTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.texImage3D(gl.TEXTURE_2D_ARRAY, 0, gl.R8, this.mw, this.mh, MAX_MASKS, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D_ARRAY, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.slotContent = new Array(MAX_MASKS).fill("");
    this.rasters.clear();
    this.makeTex("dev", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
    this.makeTex("fx", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
    this.makeTex("fx2", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
    // cross-screen filter: highlights and their streaks, both quarter res
    this.makeTex("HiQ", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    this.makeTex("StQ", gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, this.qw, this.qh, gl.LINEAR);
    this.makeTex("fx0", gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, W, H, gl.LINEAR, true);
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

  // ---- object remover ----

  private healPos = new Float32Array(MAX_HEAL * 4);
  private healShape = new Float32Array(MAX_HEAL * 4);
  // nine per spot: [c0, cu, cv] for each channel, a plane over the patch
  private healOffset = new Float32Array(MAX_HEAL * 9);
  private healPath = new Float32Array(MAX_HEAL * MAX_PATH * 2);
  private healPathN = new Int32Array(MAX_HEAL);
  private healCount = 0;
  private healKey = "";

  /**
   * Set the object-remover spots. `offsets` are the per-spot colour matches
   * computed from the preview (see src/heal.ts) so the GPU does not have to
   * average discs; `key` identifies this set for caching.
   */
  setHeal(
    spots: {
      x: number;
      y: number;
      sx: number;
      sy: number;
      radius: number;
      feather: number;
      opacity: number;
      enabled: boolean;
      kind: string;
      path?: [number, number][];
    }[],
    /** nine per spot: [c0, cu, cv] per channel */
    offsets: number[][],
    key: string,
  ): void {
    const long = Math.max(this.imgW, this.imgH);
    let n = 0;
    for (let i = 0; i < spots.length && n < MAX_HEAL; i++) {
      const s = spots[i];
      if (!s.enabled || s.opacity <= 0 || s.radius <= 0) continue;
      const o = n * 4;
      this.healPos[o] = s.x * this.imgW;
      this.healPos[o + 1] = s.y * this.imgH;
      this.healPos[o + 2] = s.sx * this.imgW;
      this.healPos[o + 3] = s.sy * this.imgH;
      this.healShape[o] = Math.max(1, s.radius * long);
      this.healShape[o + 1] = 1 - Math.max(0, Math.min(1, s.feather / 100));
      this.healShape[o + 2] = Math.max(0, Math.min(1, s.opacity / 100));
      this.healShape[o + 3] = 0;
      const off = offsets[i] ?? [0, 0, 0];
      for (let k = 0; k < 9; k++) this.healOffset[n * 9 + k] = off[k] ?? 0;
      const path = (s.path ?? []).slice(0, MAX_PATH);
      this.healPathN[n] = path.length;
      for (let k = 0; k < path.length; k++) {
        this.healPath[(n * MAX_PATH + k) * 2] = path[k][0] * this.imgW;
        this.healPath[(n * MAX_PATH + k) * 2 + 1] = path[k][1] * this.imgH;
      }
      n++;
    }
    this.healCount = n;
    this.healKey = key;
  }

  /**
   * Whole-image passes that depend only on the source, the object remover and
   * the denoise settings: heal, denoise, log-luma and its blurs. Cached until
   * those change.
   */
  prepare(p: EditParams): boolean {
    if (!this.imgW) return false;
    const gl = this.gl;
    const nl = Math.max(0, Math.min(1, p.denoiseLuma / 100));
    const nc = Math.max(0, Math.min(1, p.denoiseChroma / 100));
    const nd = Math.max(0, Math.min(1, p.denoiseDetail / 100));
    const key = `${nl}|${nc}|${nd}|${this.healKey}`;
    if (key === this.prepKey) return false;
    const T = this.t;
    const W = this.imgW;
    const H = this.imgH;

    // object remover, before everything else
    let source = this.imageTex;
    if (this.healCount > 0) {
      const hp = this.prog.heal;
      this.pass(hp, T.H, () => {
        this.bindTex(0, this.imageTex);
        gl.uniform1i(this.loc(hp, "uSrc"), 0);
        gl.uniform2f(this.loc(hp, "uSize"), W, H);
        gl.uniform1i(this.loc(hp, "uNumSpots"), this.healCount);
        gl.uniform4fv(this.loc(hp, "uSpotPos[0]"), this.healPos);
        gl.uniform4fv(this.loc(hp, "uSpotShape[0]"), this.healShape);
        gl.uniform3fv(this.loc(hp, "uSpotPlane[0]"), this.healOffset);
        gl.uniform2fv(this.loc(hp, "uSpotPath[0]"), this.healPath);
        gl.uniform1iv(this.loc(hp, "uSpotPathN[0]"), this.healPathN);
      });
      source = T.H.tex;
    }

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
      prep(source, T.P);
      nlm(source, T.P, T.D1, this.sigma);
      // scale 2: half resolution
      down2(source, W, H, T.S2);
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
        this.bindTex(0, source);
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
    // haze veil (twin of detail.rs: dark channel -> downsample4 -> gaussian s3/4)
    this.pass(this.prog.dark, T.Dk, () => {
      this.bindTex(0, T.D.tex);
      gl.uniform1i(this.loc(this.prog.dark, "uSrc"), 0);
    });
    this.pass(this.prog.down, T.DkQ, () => {
      this.bindTex(0, T.Dk.tex);
      gl.uniform1i(this.loc(this.prog.down, "uSrc"), 0);
      gl.uniform2f(this.loc(this.prog.down, "uTexel"), 1 / W, 1 / H);
    });
    this.blur(T.DkQ, T.tmpQ, T.V, s3 / 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.prepKey = key;
    return true;
  }

  // ---- masks ----

  private mw = 1;
  private mh = 1;
  private maskTex: WebGLTexture | null = null;
  private rasters = new Map<string, RasterEntry>();
  /** which raster (id:version) each slot texture currently holds */
  private slotContent: string[] = [];

  /** Resolution of brush/subject rasters for the current image. */
  maskSize(): { w: number; h: number } {
    return { w: this.mw, h: this.mh };
  }

  hasRaster(id: string): boolean {
    return this.rasters.has(id);
  }

  /** The live raster buffer of a mask (painting writes into it, then calls updateMaskRaster). */
  getRaster(id: string): Uint8Array | null {
    const r = this.rasters.get(id);
    return r && r.w === this.mw && r.h === this.mh ? r.data : null;
  }

  /** Register (or replace) the raster of a brush/subject mask. Size must equal maskSize(). */
  setMaskRaster(id: string, data: Uint8Array): void {
    const prev = this.rasters.get(id);
    this.rasters.set(id, { data, w: this.mw, h: this.mh, version: (prev?.version ?? 0) + 1 });
  }

  dropMaskRaster(id: string): void {
    this.rasters.delete(id);
  }

  /** The raster changed in place (painting): upload just the dirty rectangle if it is on a slot. */
  /**
   * Push the part of a brush raster that just changed into its slot.
   *
   * The rectangle is copied into a tightly packed buffer rather than uploaded
   * straight out of the full raster with UNPACK_ROW_LENGTH / SKIP_PIXELS /
   * SKIP_ROWS. That shorter route is what the spec is for, and it is what this
   * did, but texSubImage3D rejected every one of those uploads with
   * INVALID_OPERATION on this driver - silently, since nothing checks
   * glGetError on a hot path. The paint never reached the texture, so brush
   * masks did nothing at all and a brush subtraction erased nothing. A packed
   * copy of a dirty rectangle costs a few hundred microseconds and works
   * everywhere.
   */
  updateMaskRaster(id: string, rect: Rect): void {
    const r = this.rasters.get(id);
    if (!r) return;
    r.version += 1;
    const slot = this.slotContent.findIndex((c) => c.startsWith(id + ":"));
    if (slot < 0 || !this.maskTex) return;
    const gl = this.gl;
    const x = Math.max(0, Math.floor(rect.x));
    const y = Math.max(0, Math.floor(rect.y));
    const w = Math.min(r.w - x, Math.ceil(rect.w));
    const h = Math.min(r.h - y, Math.ceil(rect.h));
    if (w <= 0 || h <= 0) return;
    const patch = new Uint8Array(w * h);
    for (let row = 0; row < h; row++) {
      patch.set(r.data.subarray((y + row) * r.w + x, (y + row) * r.w + x + w), row * w);
    }
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, x, y, slot, w, h, 1, gl.RED, gl.UNSIGNED_BYTE, patch);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.slotContent[slot] = `${id}:${r.version}`;
  }

  private uploadSlot(slot: number, id: string): void {
    const r = this.rasters.get(id);
    const key = r ? `${id}:${r.version}` : "";
    if (this.slotContent[slot] === key || !this.maskTex) return;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const empty = new Uint8Array(this.mw * this.mh);
    const data = r && r.w === this.mw && r.h === this.mh ? r.data : empty;
    gl.texSubImage3D(gl.TEXTURE_2D_ARRAY, 0, 0, 0, slot, this.mw, this.mh, 1, gl.RED, gl.UNSIGNED_BYTE, data);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    this.slotContent[slot] = key;
  }

  // ---- creative look (.cube) ----

  private lookTex: WebGLTexture | null = null;
  private lookPath = "";
  private lookSize = 0;

  /** Upload (or clear) the look lattice as a 3D texture. */
  setLook(path: string, size: number, rgbaF16: Uint16Array | null): void {
    const gl = this.gl;
    if (this.lookTex) {
      gl.deleteTexture(this.lookTex);
      this.lookTex = null;
    }
    this.lookPath = path;
    this.lookSize = 0;
    if (!rgbaF16 || !path || size < 2) return;
    const max = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number;
    if (size > max) {
      throw new Error(`this graphics card supports looks up to ${max} points per axis; the file has ${size}`);
    }
    this.lookTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, this.lookTex);
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA16F, size, size, size, 0, gl.RGBA, gl.HALF_FLOAT, rgbaF16);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.lookSize = size;
  }

  hasLook(path: string): boolean {
    return !!this.lookTex && this.lookPath === path;
  }

  // ---- double exposure ----

  private blendTex: WebGLTexture | null = null;
  private blendPath = "";
  private blendW = 0;
  private blendH = 0;

  /**
   * The second picture of a double exposure, as linear RGB half floats in the
   * same shape `setImage` takes. Passing a null buffer clears it.
   */
  setBlend(path: string, width: number, height: number, rgbF16: Uint16Array | null): void {
    const gl = this.gl;
    if (this.blendTex) {
      gl.deleteTexture(this.blendTex);
      this.blendTex = null;
    }
    this.blendPath = path;
    this.blendW = 0;
    this.blendH = 0;
    if (!rgbF16 || !path || width < 1 || height < 1) return;
    this.blendTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.blendTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB16F, width, height, 0, gl.RGB, gl.HALF_FLOAT, rgbF16);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.blendW = width;
    this.blendH = height;
  }

  hasBlend(path: string): boolean {
    return !!this.blendTex && this.blendPath === path;
  }

  /** Uniforms for the double exposure. Twin of blend::Source::new. */
  private setBlendUniforms(p: EditParams): void {
    const gl = this.gl;
    const d = this.prog.develop;
    const b = p.blend;
    const on = b.enabled && b.opacity > 0 && this.hasBlend(b.path) && this.blendW > 0;
    gl.uniform1i(this.loc(d, "uBlendOn"), on ? 1 : 0);
    gl.uniform1i(this.loc(d, "uBlendMode"), on ? modeId(b.mode) : 0);
    gl.uniform1f(this.loc(d, "uBlendAlpha"), on ? Math.max(0, Math.min(1, b.opacity / 100)) : 0);
    gl.uniform1f(this.loc(d, "uBlendEv"), b.exposure);
    gl.uniform1i(this.loc(d, "uBlendInvert"), b.invert ? 1 : 0);
    gl.uniform1i(this.loc(d, "uBlendFlip"), b.flip ? 1 : 0);
    const pl = placement(b, this.imgW, this.imgH, Math.max(1, this.blendW), Math.max(1, this.blendH));
    gl.uniform2f(this.loc(d, "uBlendC"), pl.cx, pl.cy);
    gl.uniform2f(this.loc(d, "uBlendDen"), pl.denx, pl.deny);
    gl.uniform2f(this.loc(d, "uBlendRot"), pl.cos, pl.sin);
    // the sampler always needs a complete texture bound, overlay or not
    gl.activeTexture(gl.TEXTURE10);
    gl.bindTexture(gl.TEXTURE_2D, this.blendTex ?? this.imageTex);
    gl.uniform1i(this.loc(d, "uBlend"), 10);
  }

  /**
   * Masks the shader evaluates: enabled masks with a non-zero adjustment,
   * plus the one being shown/edited (so its overlay is visible even before
   * it has any adjustment). At most MAX_MASKS, in stack order.
   *
   * A subtract mask is judged by its own strength rather than by adjustments
   * it does not have, and it is dropped when the mask it cuts into was, so it
   * can never slide up onto an earlier mask the way it would if the list were
   * simply filtered (twin of mask.rs prepare).
   */
  private maskList(p: EditParams, showId: string | null): { list: Mask[]; show: number; useLuma: boolean } {
    const list = shaderMasks(p.masks, showId, MAX_MASKS);
    return {
      list,
      show: showId ? list.findIndex((m) => m.id === showId) : -1,
      useLuma: list.some((m) => m.kind === "luminance"),
    };
  }

  private setMaskUniforms(list: Mask[], show: number, useLuma: boolean): void {
    const gl = this.gl;
    const d = this.prog.develop;
    const n = list.length;
    const kind = new Int32Array(MAX_MASKS);
    const mode = new Int32Array(MAX_MASKS);
    const invert = new Int32Array(MAX_MASKS);
    const amount = new Float32Array(MAX_MASKS);
    const p0 = new Float32Array(MAX_MASKS * 4);
    const p1 = new Float32Array(MAX_MASKS * 4);
    const adj = new Float32Array(MAX_MASKS * MASK_ADJ_STRIDE);
    const W = this.imgW;
    const H = this.imgH;
    const long = Math.max(W, H);
    for (let i = 0; i < n; i++) {
      const m = list[i];
      kind[i] = maskKindCode(m.kind);
      mode[i] = m.mode === "subtract" ? MASK_MODE_SUBTRACT : MASK_MODE_ADD;
      invert[i] = m.invert ? 1 : 0;
      amount[i] = Math.max(0, Math.min(1, m.amount / 100));
      const o = i * 4;
      switch (m.kind) {
        case "linear": {
          const ax = m.x0 * W;
          const ay = m.y0 * H;
          p0[o] = ax;
          p0[o + 1] = ay;
          p0[o + 2] = m.x1 * W - ax;
          p0[o + 3] = m.y1 * H - ay;
          break;
        }
        case "radial": {
          const rot = (m.rotation * Math.PI) / 180;
          p0[o] = m.cx * W;
          p0[o + 1] = m.cy * H;
          p0[o + 2] = Math.max(1, m.rx * long);
          p0[o + 3] = Math.max(1, m.ry * long);
          p1[o] = Math.cos(rot);
          p1[o + 1] = Math.sin(rot);
          p1[o + 2] = Math.max(0.01, Math.min(1, m.feather / 100));
          break;
        }
        case "luminance":
          p0[o] = m.lumLo;
          p0[o + 1] = m.lumHi;
          p0[o + 2] = m.lumFeather;
          break;
        default:
          p0[o] = i; // raster slot == list index
          this.uploadSlot(i, m.id);
      }
      for (let k = 0; k < MASK_ADJUST_KEYS.length; k++) adj[i * MASK_ADJ_STRIDE + k] = m.adjust[MASK_ADJUST_KEYS[k]];
    }
    gl.uniform1i(this.loc(d, "uNumMasks"), n);
    gl.uniform1i(this.loc(d, "uUseLumaG"), useLuma ? 1 : 0);
    gl.uniform1i(this.loc(d, "uShowMask"), show);
    gl.uniform1iv(this.loc(d, "uMaskKind[0]"), kind);
    gl.uniform1iv(this.loc(d, "uMaskMode[0]"), mode);
    gl.uniform1iv(this.loc(d, "uMaskInvert[0]"), invert);
    gl.uniform1fv(this.loc(d, "uMaskAmount[0]"), amount);
    gl.uniform4fv(this.loc(d, "uMaskP0[0]"), p0);
    gl.uniform4fv(this.loc(d, "uMaskP1[0]"), p1);
    gl.uniform1fv(this.loc(d, "uMaskAdj[0]"), adj);
    gl.activeTexture(gl.TEXTURE8);
    gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.maskTex);
    gl.uniform1i(this.loc(d, "uMasks"), 8);
  }

  /** Resolved lens/perspective geometry for the preview. */
  warp(p: EditParams): Warp {
    return makeWarp(p.transform, p.lens, p.lensProfile, this.imgW, this.imgH);
  }

  private setDevelopUniforms(p: EditParams): void {
    const gl = this.gl;
    const d = this.prog.develop;
    const lkp = profileLook(p.profile);
    const n = (v: number) => Math.max(-1, Math.min(1, v / 100));
    const f = (name: string, v: number) => gl.uniform1f(this.loc(d, name), v);
    // the picture profile adds to the user's own settings (twin of
    // Uniforms::from_params in pipeline.rs)
    const add8 = (a: number[], b: number[]) => Float32Array.from(a, (v, i) => n(v + b[i]));
    f("uExposure", Math.max(-10, Math.min(10, p.exposure)));
    f("uContrast", n(p.contrast + lkp.contrast));
    f("uHighlights", n(p.highlights));
    f("uShadows", n(p.shadows));
    f("uWhites", n(p.whites));
    f("uBlacks", n(p.blacks));
    f("uTemp", n(p.temperature + lkp.temperature));
    f("uTint", n(p.tint));
    f("uVibrance", n(p.vibrance + lkp.vibrance));
    f("uSaturation", n(p.saturation + lkp.saturation));
    f("uBaseContrast", Math.max(0, Math.min(1, p.baseContrast)));
    f("uTexture", n(p.texture));
    f("uClarity", n(p.clarity));
    f("uDehaze", n(p.dehaze));
    gl.uniform2f(this.loc(d, "uSize"), this.imgW, this.imgH);
    // grain takes its own 0..100, not the shared -1..1 mapping
    f("uGrainAmount", Math.max(0, Math.min(100, p.grain.amount)));
    f("uGrainSize", Math.max(0, Math.min(100, p.grain.size)));
    f("uGrainColour", Math.max(0, Math.min(100, p.grain.colour)));
    gl.uniform1i(this.loc(d, "uMono"), lkp.mono ? 1 : 0);
    gl.uniform3fv(this.loc(d, "uMonoMix"), lkp.monoMix);
    // lens vignetting correction (scene-referred)
    const warp = this.warp(p);
    gl.uniform1i(this.loc(d, "uVigOn"), warpHasVignette(warp) ? 1 : 0);
    gl.uniform3fv(this.loc(d, "uVigK"), warp.vig);
    f("uVigAmount", warp.vigAmount);
    f("uMv", warp.mv);
    f("uMvStart", warp.mvStart);
    f("uRmax", warp.rmax);
    f("uHs", warp.hs);
    f("uCs", warp.cs);
    // creative look
    const lookOn = p.look.enabled && p.look.amount > 0 && this.hasLook(p.look.path);
    gl.uniform1i(this.loc(d, "uLookOn"), lookOn ? 1 : 0);
    f("uLookAmount", Math.max(0, Math.min(1, p.look.amount / 100)));
    f("uLookSize", Math.max(2, this.lookSize));
    gl.uniform3f(this.loc(d, "uLookMin"), 0, 0, 0);
    gl.uniform3f(this.loc(d, "uLookMax"), 1, 1, 1);
    const li = lookInput(p.look.input);
    gl.uniform1i(this.loc(d, "uLookLog"), li.encoding);
    gl.uniformMatrix3fv(this.loc(d, "uLookMat"), false, columnMajor(li.matrix));
    gl.activeTexture(gl.TEXTURE9);
    gl.bindTexture(gl.TEXTURE_3D, this.lookTex);
    gl.uniform1i(this.loc(d, "uLook"), 9);
    this.setBlendUniforms(p);
    gl.uniform1fv(this.loc(d, "uHslHue[0]"), add8(p.hsl.hue, lkp.bandHue));
    gl.uniform1fv(this.loc(d, "uHslSat[0]"), add8(p.hsl.saturation, lkp.bandSat));
    gl.uniform1fv(this.loc(d, "uHslLum[0]"), add8(p.hsl.luminance, lkp.bandLum));
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
    this.bindTex(6, T.V.tex);
    this.bindTex(7, T.devG.tex);
    gl.uniform1i(this.loc(d, "uImage"), 0);
    gl.uniform1i(this.loc(d, "uLut"), 1);
    gl.uniform1i(this.loc(d, "uLg"), 2);
    gl.uniform1i(this.loc(d, "uB1"), 3);
    gl.uniform1i(this.loc(d, "uB2"), 4);
    gl.uniform1i(this.loc(d, "uB3"), 5);
    gl.uniform1i(this.loc(d, "uDark"), 6);
    gl.uniform1i(this.loc(d, "uLumaG"), 7);
    gl.uniform1i(this.loc(d, "uUseMaps"), 1);
  }

  /**
   * Pass: run the per-pixel pipeline into the preview-sized framebuffer and
   * the histogram framebuffer. `showMaskId` paints that mask's weight in red
   * on top of the picture (and keeps it evaluated even with no adjustment).
   */
  runDevelop(p: EditParams, showMaskId: string | null = null): void {
    if (!this.imgW) return;
    const gl = this.gl;
    const t0 = performance.now();
    const prepared = this.prepare(p);
    if (prepared) performance.measure("gl.prepare", { start: t0 });
    const { list, show, useLuma } = this.maskList(p, showMaskId);
    if (useLuma) {
      // luminance-range masks read the picture developed with global settings only
      this.pass(this.prog.develop, this.t.devG, () => {
        this.setDevelopUniforms(p);
        this.setMaskUniforms([], -1, false);
      });
    }
    const setup = () => {
      this.setDevelopUniforms(p);
      this.setMaskUniforms(list, show, useLuma);
    };
    this.pass(this.prog.develop, this.t.dev, setup);
    this.pass(this.prog.develop, this.t.hist, setup);
    // dev uses mipmap filtering; it must be mip-complete before the mirror
    // pass samples it (and before display when no mirror is applied)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bindTex(0, this.t.dev.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    // the cross-screen filter is on the lens, so it comes first - before the
    // trails echo it and before the watermark is laid on top
    this.starOn = this.runStar(p);
    const base = this.starOn ? this.t.fx0 : this.t.dev;
    this.mirrorOn = p.mirror.enabled && p.mirror.opacity > 0;
    if (this.mirrorOn) {
      const g = mirrorGeom(p.mirror, this.imgW, this.imgH);
      const pr = this.prog.mirror;
      this.pass(pr, this.t.fx, () => {
        this.bindTex(0, base.tex);
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
    // The watermark is no longer a pass of its own: it is composited by the
    // present pass, against the cropped output, so its corner stays its corner
    // whatever the crop is. Twin of the late watermark_pass in export.rs.
    const wm = p.watermark;
    this.watermarkOn = wm.enabled && wm.opacity > 0 && !!this.wmTex && this.wmPath === wm.path;
    this.wmPlace = { x: wm.x, y: wm.y, size: wm.size, opacity: Math.max(0, Math.min(1, wm.opacity / 100)) };
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

  /**
   * Pass: the cross-screen filter, as three passes into fx0. Returns whether it
   * ran, which decides what the rest of the chain reads. Twin of star.rs.
   */
  private runStar(p: EditParams): boolean {
    const s = p.star;
    if (!starActive(s)) return false;
    const gl = this.gl;
    const long = Math.max(this.imgW, this.imgH);
    const lenQ = starLenPx(s.length, long) / 4;
    // a streak shorter than a quarter of a pixel on the map is no streak
    if (lenQ < 0.25) return false;

    const hi = this.prog.starHi;
    this.pass(hi, this.t.HiQ, () => {
      this.bindTex(0, this.t.dev.tex);
      gl.uniform1i(this.loc(hi, "uTex"), 0);
      gl.uniform1f(this.loc(hi, "uThreshold"), starThreshold(s.threshold));
    });
    const sk = this.prog.starStreak;
    this.pass(sk, this.t.StQ, () => {
      this.bindTex(0, this.t.HiQ.tex);
      gl.uniform1i(this.loc(sk, "uHi"), 0);
      gl.uniform2f(this.loc(sk, "uQSize"), this.t.HiQ.w, this.t.HiQ.h);
      gl.uniform1f(this.loc(sk, "uLenQ"), lenQ);
      gl.uniform1f(this.loc(sk, "uFade"), starFadeExp(s.falloff));
      gl.uniform1f(this.loc(sk, "uDisp"), starDispersion(s.dispersion));
      gl.uniform1i(this.loc(sk, "uLines"), starLines(s.points));
      gl.uniform1f(this.loc(sk, "uAngle"), (s.angle * Math.PI) / 180);
    });
    const ad = this.prog.starAdd;
    this.pass(ad, this.t.fx0, () => {
      this.bindTex(0, this.t.dev.tex);
      this.bindTex(1, this.t.StQ.tex);
      gl.uniform1i(this.loc(ad, "uTex"), 0);
      gl.uniform1i(this.loc(ad, "uStreak"), 1);
      gl.uniform1f(this.loc(ad, "uGain"), starGain(s.amount));
    });
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.bindTex(0, this.t.fx0.tex);
    gl.generateMipmap(gl.TEXTURE_2D);
    return true;
  }

  private starOn = false;
  private mirrorOn = false;
  private watermarkOn = false;
  private wmPlace = { x: 0.85, y: 0.92, size: 0.2, opacity: 0.8 };
  private wmTex: WebGLTexture | null = null;
  private wmPath = "";
  private wmW = 1;
  private wmH = 1;
  private output(): Tex {
    if (this.mirrorOn) return this.t.fx;
    return this.starOn ? this.t.fx0 : this.t.dev;
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

  /** Size of the crop output before 90° rotation (whole image when cropping is off or being edited). */
  cropSize(crop?: Crop | null, cropMode = false): { w: number; h: number } {
    if (!crop || cropMode || cropIsIdentity(crop)) return { w: this.imgW, h: this.imgH };
    return {
      w: Math.max(1, Math.round(Math.max(0.01, Math.min(1, crop.w)) * this.imgW)),
      h: Math.max(1, Math.round(Math.max(0.01, Math.min(1, crop.h)) * this.imgH)),
    };
  }

  /** Size of the image as displayed after crop and rotation. */
  displaySize(rotation: number, crop?: Crop | null, cropMode = false): { w: number; h: number } {
    const c = this.cropSize(crop, cropMode);
    return rotation % 180 === 0 ? c : { w: c.h, h: c.w };
  }

  /**
   * Draw the developed image to the canvas with pan/zoom, crop/straighten,
   * lens and perspective correction, rotation and output sharpening.
   */
  draw(view: View, sharpen: number, rotation = 0, crop?: Crop | null, cropMode = false, warp?: Warp | null): void {
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
    gl.uniform3f(this.loc(pr, "uOutside"), 0.09, 0.09, 0.09);
    // lens distortion / chromatic aberration / perspective, twin of geometry.rs
    gl.uniform2f(this.loc(pr, "uSize"), this.imgW, this.imgH);
    const wp = warp && !warpIsIdentity(warp) ? warp : null;
    gl.uniform1i(this.loc(pr, "uWarpOn"), wp ? 1 : 0);
    if (wp) {
      gl.uniform1i(this.loc(pr, "uTransformOn"), wp.transformOn ? 1 : 0);
      gl.uniform1f(this.loc(pr, "uHs"), wp.hs);
      gl.uniform2f(this.loc(pr, "uOfs"), wp.ox, wp.oy);
      gl.uniform1f(this.loc(pr, "uInvScale"), wp.invScale);
      gl.uniform2f(this.loc(pr, "uAspect"), wp.ax, wp.ay);
      gl.uniform2f(this.loc(pr, "uCosSinT"), wp.cos, wp.sin);
      gl.uniform2f(this.loc(pr, "uPersp"), wp.ph, wp.pv);
      gl.uniform1i(this.loc(pr, "uDistModel"), wp.distModel);
      gl.uniform3fv(this.loc(pr, "uDist"), wp.dist);
      gl.uniform1f(this.loc(pr, "uDistAmount"), wp.distAmount);
      gl.uniform1f(this.loc(pr, "uCs"), wp.cs);
      gl.uniform1f(this.loc(pr, "uKm"), wp.km);
      gl.uniform2f(this.loc(pr, "uTca"), wp.tcaR, wp.tcaB);
    }
    // crop/straighten: the quad shows the crop output (or the whole straightened
    // canvas in crop mode); uUvMat maps quad coords to source texture coords
    const out = this.cropSize(crop, cropMode);
    // The watermark belongs to the finished frame, so it is measured against
    // the cropped output rather than the original: its corner stays its corner
    // however the photo is cropped.
    // the quad covers the cropped frame before rotation, which is the space
    // the watermark is stored in
    gl.uniform1i(this.loc(pr, "uWmOn"), this.watermarkOn ? 1 : 0);
    if (this.watermarkOn && this.wmTex) {
      const wp = this.wmPlace;
      const dw = Math.max(1, wp.size * Math.max(out.w, out.h));
      const dh = (dw * this.wmH) / this.wmW;
      this.bindTex(3, this.wmTex);
      gl.uniform1i(this.loc(pr, "uWmTex"), 3);
      gl.uniform2f(this.loc(pr, "uOutSize"), out.w, out.h);
      gl.uniform4f(this.loc(pr, "uWmRect"), wp.x * out.w - dw / 2, wp.y * out.h - dh / 2, dw, dh);
      gl.uniform1f(this.loc(pr, "uWmOpacity"), wp.opacity);
    }
    const active = !!crop && crop.enabled && !cropIsIdentity(crop);
    const ang = active ? (crop!.angle * Math.PI) / 180 : 0;
    const ca = Math.cos(ang);
    const sa = Math.sin(ang);
    const IW = this.imgW;
    const IH = this.imgH;
    const cx = IW / 2;
    const cy = IH / 2;
    const x0 = active && !cropMode ? Math.max(0, Math.min(1, crop!.x)) * IW : 0;
    const y0 = active && !cropMode ? Math.max(0, Math.min(1, crop!.y)) * IH : 0;
    const tx = cx + ca * (x0 - cx) - sa * (y0 - cy);
    const ty = cy + sa * (x0 - cx) + ca * (y0 - cy);
    gl.uniformMatrix3fv(this.loc(pr, "uUvMat"), false, [
      (ca * out.w) / IW,
      (sa * out.w) / IH,
      0,
      (-sa * out.h) / IW,
      (ca * out.h) / IH,
      0,
      tx / IW,
      ty / IH,
      1,
    ]);
    const W = out.w;
    const H = out.h;
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
    if (this.maskTex) gl.deleteTexture(this.maskTex);
    if (this.lookTex) gl.deleteTexture(this.lookTex);
    gl.deleteTexture(this.imageTex);
    gl.deleteTexture(this.lutTex);
    for (const t of Object.values(this.t)) gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(this.fbo);
    for (const p of Object.values(this.prog)) gl.deleteProgram(p);
  }
}
