// App smoke test: drives the real Darkroom window through every major tool
// and fails on any error toast, WebGL error or missing result.
//
//   node scripts/smoke.mjs <photo>
//
// Needs the debug app running with the webview debugging port open (the
// `bun run test -- --app <photo>` runner does that on Windows). The photo is
// copied to a temp folder first, so its real sidecar is never touched.

import { copyFileSync, mkdtempSync, readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";

const PORT = process.env.DARKROOM_CDP_PORT || "9222";
const source = process.argv[2];
if (!source || !existsSync(source)) {
  console.error("usage: node scripts/smoke.mjs <photo>");
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), "darkroom-smoke-"));
const photo = join(dir, basename(source)).split("\\").join("/");
copyFileSync(source, photo);
// the same picture again, to stand in for the second exposure
const second = join(dir, "second-" + basename(source)).split("\\").join("/");
copyFileSync(source, second);
const sidecar = () => {
  try {
    return JSON.parse(readFileSync(photo + ".drk.json", "utf8")).edits;
  } catch {
    return null;
  }
};

// ---- minimal CDP client ----
const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
const page = list.find((p) => p.type === "page");
if (!page) throw new Error("no Darkroom page on the debugging port");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  const h = m.id && pending.get(m.id);
  if (h) {
    pending.delete(m.id);
    m.error ? h.rej(new Error(JSON.stringify(m.error))) : h.res(m.result);
  }
};
await new Promise((r) => (ws.onopen = r));
const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
const js = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "page exception");
  return r.result?.value;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- page helpers ----
await js(`window.__smoke = {
  button(text) { return [...document.querySelectorAll('button')].find(b => b.textContent.trim() === text); },
  section(title) { return [...document.querySelectorAll('.inspector-section')].find(s => s.dataset.section === title); },
  open(title) { const s = this.section(title); if (!s) throw new Error('no section ' + title); if (!s.classList.contains('open')) s.querySelector('.inspector-section-head').click(); return s; },
  slider(root, label, value) {
    const el = [...root.querySelectorAll('.slider')].find(x => x.querySelector('.slider-label')?.textContent.trim() === label);
    if (!el) throw new Error('no slider ' + label);
    const input = el.querySelector('input[type=range]');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  },
  sliderValue(root, label) {
    const el = [...root.querySelectorAll('.slider')].find(x => x.querySelector('.slider-label')?.textContent.trim() === label);
    if (!el) throw new Error('no slider ' + label);
    return parseFloat(el.querySelector('input[type=range]').value);
  },
  iconButton(titleStart) {
    return [...document.querySelectorAll('.icon-button')].find(b => (b.title || '').startsWith(titleStart));
  },
  problems() {
    return [document.querySelector('.toast')?.textContent, document.querySelector('.viewer-error')?.textContent].filter(Boolean);
  },
  toggle(title) {
    const box = this.open(title).querySelector('.feature-toggle input');
    if (!box) throw new Error('no toggle in ' + title);
    box.click();
    return box.checked;
  },
  // The app's own capture path: it draws the picture and reads it back in the
  // same tick, which is the only way a WebGL canvas reads back reliably.
  async shot() {
    const blob = await window.__darkroom.capture();
    if (!blob) throw new Error('the viewer would not give up a frame');
    const bm = await createImageBitmap(blob);
    const c = document.createElement('canvas');
    c.width = bm.width;
    c.height = bm.height;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bm, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const W = c.width, H = c.height;
    let sum = 0, rough = 0, split = 0, n = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 1; x < W - 1; x++) {
        const i = (y * W + x) * 4;
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        // second difference along the row: smooth gradients read as zero,
        // grain and other per-pixel texture do not
        rough += Math.abs(2 * d[i + 1] - d[i - 3] - d[i + 5]);
        split += Math.abs(d[i] - d[i + 2]);
        n++;
      }
    }
    return { w: W, h: H, mean: sum / n / 255, rough: rough / n / 255, split: split / n / 255 };
  },
  // the Motion Trails overlay is an ordinary 2D canvas, so it reads directly
  overlay() {
    const c = document.querySelector('.motion-trail-preview');
    if (!c || !c.width) return null;
    const g = c.getContext('2d', { willReadFrequently: true });
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, lit = 0;
    for (let i = 3; i < d.length; i += 4) {
      n++;
      if (d[i] > 8) lit++;
    }
    const cx = Math.max(0, Math.floor(c.width / 2) - 8);
    const cy = Math.max(0, Math.floor(c.height / 2) - 8);
    const mid = g.getImageData(cx, cy, 16, 16).data;
    let centre = 0;
    for (let i = 3; i < mid.length; i += 4) centre = Math.max(centre, mid[i]);
    return { w: c.width, h: c.height, lit: lit / n, centre };
  },
}; true`);

const results = [];
const step = async (name, fn) => {
  const t0 = Date.now();
  try {
    await fn();
    const problems = await js(`__smoke.problems()`);
    if (problems.length) throw new Error(problems.join(" / "));
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  PASS  ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, error: String(e.message || e) });
    console.log(`  FAIL  ${name}\n        ${String(e.message || e).split("\n")[0]}`);
    await js(`document.querySelector('.toast')?.click(); true`).catch(() => {});
  }
};
const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const waitFor = async (expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await js(expr)) return true;
    await sleep(250);
  }
  return false;
};

console.log(`Darkroom smoke test on ${basename(source)}`);

await step("app is mounted", async () => {
  expect(await js(`!!document.querySelector('.app')`), "the React app did not mount");
});

await step("opens the photo", async () => {
  await js(`window.__darkroom.load(${JSON.stringify(photo)})`);
  expect(await waitFor(`document.querySelector('.file-context strong')?.textContent === ${JSON.stringify(basename(photo))}`), "the photo did not open");
  await sleep(1500);
});

await step("filmstrip thumbnail generated", async () => {
  expect(await waitFor(`[...document.querySelectorAll('.thumb')].some(t => t.querySelector('img'))`), "no thumbnail appeared");
});

await step("every inspector section opens", async () => {
  const titles = await js(`[...document.querySelectorAll('.inspector-section')].map(s => s.dataset.section)`);
  expect(titles.length >= 12, `only ${titles.length} sections`);
  for (const t of titles) await js(`__smoke.open(${JSON.stringify(t)}); true`);
  await sleep(800);
});

await step("tone slider saves to the sidecar", async () => {
  await js(`__smoke.slider(__smoke.open('Tone'), 'Exposure', 1.25); true`);
  expect(await waitFor(`true`, 1), "");
  await sleep(1200);
  expect(sidecar()?.exposure === 1.25, `sidecar exposure is ${sidecar()?.exposure}`);
});

await step("picture profile switches", async () => {
  await js(`(() => { const sel = __smoke.open('Tone').querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'mono'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(1200);
  expect(sidecar()?.profile === "mono", `profile is ${sidecar()?.profile}`);
  await js(`(() => { const sel = __smoke.open('Tone').querySelector('select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'standard'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
  await sleep(600);
});

await step("crop mode opens and closes", async () => {
  await js(`document.querySelector('.toolrail button:nth-of-type(3)').click(); true`);
  expect(await waitFor(`!!document.querySelector('.crop-frame')`, 4000), "crop frame did not appear");
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  expect(await waitFor(`!document.querySelector('.crop-frame')`, 4000), "crop mode did not close");
});

await step("linear gradient mask adds and deletes", async () => {
  await js(`__smoke.open('Masks'); true`);
  await sleep(300);
  await js(`__smoke.button('+ Add mask').click(); true`);
  await sleep(300);
  await js(`[...document.querySelectorAll('.mask-add-item')].find(b => b.textContent.includes('Linear gradient')).click(); true`);
  expect(await waitFor(`document.querySelectorAll('.mask-panel .mask-row').length === 1`, 4000), "mask row did not appear");
  expect(await waitFor(`document.querySelectorAll('.mo-handle').length >= 2`, 4000), "mask handles did not appear");
  await js(`__smoke.slider(document.querySelector('.mask-edit'), 'Exposure', -1); true`);
  await sleep(1200);
  expect(sidecar()?.masks?.[0]?.adjust?.exposure === -1, "mask adjustment was not saved");
  await js(`document.querySelector('.mask-panel .mask-delete').click(); true`);
  expect(await waitFor(`document.querySelectorAll('.mask-panel .mask-row').length === 0`, 4000), "mask was not deleted");
});

await step("object remover places a spot with a source patch", async () => {
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await js(`__smoke.open('Object Remover'); true`);
  await js(`__smoke.button('Remove objects').click(); true`);
  expect(await waitFor(`!!document.querySelector('.heal-surface')`, 4000), "repair tool did not activate");
  await js(`(() => { const s = document.querySelector('.heal-surface'); const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true; })()`);
  expect(await waitFor(`document.querySelectorAll('.heal-spot').length === 1`, 6000), "spot did not appear");
  await sleep(1500);
  const spot = sidecar()?.heal?.[0];
  expect(spot && (Math.abs(spot.sx - spot.x) > 1e-3 || Math.abs(spot.sy - spot.y) > 1e-3), "no source patch was chosen");
  await js(`__smoke.button('Remove all spots').click(); true`);
  await js(`__smoke.button('Done removing')?.click(); true`);
  expect(await waitFor(`document.querySelectorAll('.heal-spot').length === 0`, 4000), "spots were not removed");
});

await step("transform and lens sliders apply", async () => {
  await js(`__smoke.slider(__smoke.open('Transform'), 'Vertical', 20); true`);
  await js(`__smoke.slider(__smoke.open('Lens Corrections'), 'Vignette', -30); true`);
  await sleep(1200);
  const e = sidecar();
  expect(e?.transform?.vertical === 20 && e?.lens?.manualVignette === -30, "transform/lens values were not saved");
  await js(`__smoke.slider(__smoke.open('Transform'), 'Vertical', 0); __smoke.slider(__smoke.open('Lens Corrections'), 'Vignette', 0); true`);
  await sleep(600);
});

await step("preset saves, applies and deletes", async () => {
  const name = "Smoke Test " + Date.now().toString(36);
  const panel = await js(`!!__smoke.open('Presets')`);
  expect(panel, "no presets section");
  await js(`(() => { const i = document.querySelector('.preset-name'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, ${JSON.stringify(name)}); i.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
  await sleep(200);
  await js(`__smoke.button('Save').click(); true`);
  expect(await waitFor(`[...document.querySelectorAll('.preset-panel .mask-name')].some(n => n.textContent === ${JSON.stringify(name)})`, 5000), "preset did not appear");
  await js(`__smoke.slider(__smoke.open('Tone'), 'Exposure', -2); true`);
  await sleep(900);
  await js(`[...document.querySelectorAll('.preset-panel .mask-row')].find(r => r.textContent.includes(${JSON.stringify(name)})).click(); true`);
  await sleep(1200);
  expect(sidecar()?.exposure === 1.25, `applying the preset left exposure at ${sidecar()?.exposure}`);
  await js(`[...document.querySelectorAll('.preset-panel .mask-row')].find(r => r.textContent.includes(${JSON.stringify(name)})).querySelector('.mask-delete').click(); true`);
  expect(await waitFor(`![...document.querySelectorAll('.preset-panel .mask-name')].some(n => n.textContent === ${JSON.stringify(name)})`, 5000), "preset was not deleted");
});

await step("double exposure loads, blends and clears", async () => {
    await js(`__smoke.open('Double Exposure'); true`);
    await sleep(300);
    expect(await js(`!!document.querySelector('.blend-drop')`), "no drop zone");
    await js(`window.__darkroom.doubleExpose(${JSON.stringify(second)})`);
    expect(await waitFor(`!!document.querySelector('.blend-file')`, 20000), "the second photo did not load");
    await sleep(1500);
    expect(sidecar()?.blend?.path === second, `blend path is ${sidecar()?.blend?.path}`);
    expect(sidecar()?.blend?.mode === "expose", "the default mode should be a true double exposure");
    await js(`__smoke.slider(document.querySelector('.blend-panel'), 'Opacity', 60); true`);
    await sleep(1200);
    expect(sidecar()?.blend?.opacity === 60, `opacity is ${sidecar()?.blend?.opacity}`);
    await js(
      `(() => { const sel = document.querySelector('.blend-panel select'); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'screen'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
    );
    await sleep(1200);
    expect(sidecar()?.blend?.mode === "screen", `mode is ${sidecar()?.blend?.mode}`);
    await js(`__smoke.button('Remove').click(); true`);
    expect(await waitFor(`!document.querySelector('.blend-file')`, 5000), "the second photo was not removed");
    await sleep(1200);
    expect(!sidecar()?.blend?.path, "the sidecar still carries a second photo");
  });

// Also the tidy-up: this test opens copies out of a temp folder, and the
// filmstrip is restored from a saved session, so leaving them in would put
// throwaway files in front of the user on the next launch.
await step("undo and redo step through edits", async () => {
  await js(`__smoke.slider(__smoke.open('Tone'), 'Exposure', 0.5); true`);
  await sleep(700);
  await js(`__smoke.slider(__smoke.open('Tone'), 'Contrast', 40); true`);
  await sleep(700);
  expect(await js(`__smoke.sliderValue(__smoke.open('Tone'), 'Contrast')`) === 40, "contrast did not take");
  const undo = `__smoke.iconButton('Undo')`;
  expect(await js(`!!${undo} && !${undo}.disabled`), "undo is not offered after editing");
  await js(`${undo}.click(); true`);
  expect(
    await waitFor(`__smoke.sliderValue(__smoke.open('Tone'), 'Contrast') === 0`, 4000),
    "undo did not take back the contrast change",
  );
  expect(
    await js(`__smoke.sliderValue(__smoke.open('Tone'), 'Exposure')`) === 0.5,
    "undo went back too far: the exposure change should still stand",
  );
  const redo = `__smoke.iconButton('Redo')`;
  expect(await js(`!!${redo} && !${redo}.disabled`), "redo is not offered after an undo");
  await js(`${redo}.click(); true`);
  expect(
    await waitFor(`__smoke.sliderValue(__smoke.open('Tone'), 'Contrast') === 40`, 4000),
    "redo did not put the contrast change back",
  );
  // leave the photo as it was
  await js(`__smoke.slider(__smoke.open('Tone'), 'Contrast', 0); __smoke.slider(__smoke.open('Tone'), 'Exposure', 1.25); true`);
  await sleep(900);
});

await step("film grain roughens the picture without moving its exposure", async () => {
  await js(`__smoke.slider(__smoke.open('Grain'), 'Amount', 0); true`);
  // the capture path downscales and re-encodes, which washes the finest grain
  // out of the measurement; coarse grain comes through it and exercises the
  // same code
  await js(`__smoke.slider(__smoke.open('Grain'), 'Size', 100); true`);
  await sleep(700);
  const clean = await js(`__smoke.shot()`);
  await js(`__smoke.slider(__smoke.open('Grain'), 'Amount', 100); true`);
  await sleep(1000);
  const grainy = await js(`__smoke.shot()`);
  expect(
    grainy.rough > clean.rough * 1.25,
    `grain did not roughen the picture: ${clean.rough.toFixed(4)} -> ${grainy.rough.toFixed(4)}`,
  );
  expect(
    Math.abs(grainy.mean - clean.mean) < 0.03,
    `grain shifted the exposure: ${clean.mean.toFixed(3)} -> ${grainy.mean.toFixed(3)}`,
  );
  await js(`__smoke.slider(__smoke.open('Grain'), 'Amount', 0); true`);
  await js(`__smoke.slider(__smoke.open('Grain'), 'Size', 40); true`);
  await sleep(500);
});

await step("the starburst filter lights up the highlights", async () => {
  const off = await js(`__smoke.shot()`);
  expect(await js(`__smoke.toggle('Starburst')`), "the starburst toggle did not switch on");
  await js(`__smoke.slider(__smoke.open('Starburst'), 'Threshold', 10); true`);
  await js(`__smoke.slider(__smoke.open('Starburst'), 'Amount', 100); true`);
  await js(`__smoke.slider(__smoke.open('Starburst'), 'Length', 100); true`);
  await sleep(1400);
  const on = await js(`__smoke.shot()`);
  expect(on.mean > off.mean + 0.008, `the star brightened nothing: ${off.mean.toFixed(3)} -> ${on.mean.toFixed(3)}`);
  expect(!(await js(`__smoke.toggle('Starburst')`)), "the starburst toggle did not switch off");
  await sleep(900);
  const back = await js(`__smoke.shot()`);
  expect(Math.abs(back.mean - off.mean) < 0.004, `switching the star off did not restore the picture: ${off.mean.toFixed(3)} -> ${back.mean.toFixed(3)}`);
});

await step("a subtract mask takes its area back out of the mask above it", async () => {
  const plain = await js(`__smoke.shot()`);
  const addMask = async (kind, button) => {
    await js(`[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes(${JSON.stringify(button)})).click(); true`);
    await sleep(300);
    await js(
      `[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === ${JSON.stringify(kind)}).click(); true`,
    );
    await sleep(600);
  };
  await addMask("Radial gradient", "Add mask");
  expect(await js(`document.querySelectorAll('.mask-row').length === 1`), "the mask was not added");
  await js(`__smoke.slider(document.querySelector('.mask-edit'), 'Exposure', 4); true`);
  await sleep(1200);
  const bright = await js(`__smoke.shot()`);
  expect(bright.mean > plain.mean + 0.01, `the mask did not brighten anything: ${plain.mean.toFixed(3)} -> ${bright.mean.toFixed(3)}`);

  await addMask("Radial gradient", "Subtract");
  expect(await js(`document.querySelectorAll('.mask-row.subtract').length === 1`), "the subtract mask was not added");
  await sleep(1200);
  const cut = await js(`__smoke.shot()`);
  expect(
    cut.mean < plain.mean + (bright.mean - plain.mean) * 0.35,
    `the subtraction barely took anything back: plain ${plain.mean.toFixed(3)}, bright ${bright.mean.toFixed(3)}, cut ${cut.mean.toFixed(3)}`,
  );

  // leave the photo as it was
  await js(`[...document.querySelectorAll('.mask-delete')].forEach(b => b.click()); true`);
  await sleep(700);
  expect(await js(`document.querySelectorAll('.mask-row').length === 0`), "the masks were not deleted");
});

await step("motion trails can be cut from a mask", async () => {
  await js(`[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes('Add mask')).click(); true`);
  await sleep(300);
  await js(`[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === 'Radial gradient').click(); true`);
  await sleep(600);
  expect(await js(`__smoke.toggle('Motion Trails')`), "the trails toggle did not switch on");
  await sleep(500);
  // switching trails on picks up the mask the photo already has
  const picked = await js(`document.querySelector('#trail-source')?.value || ''`);
  expect(picked.length > 0, "enabling trails did not pick up the mask");
  expect(
    await waitFor(`(() => { const o = __smoke.overlay(); return !!o && o.lit > 0.004; })()`, 12000),
    `no trail was drawn: ${JSON.stringify(await js(`__smoke.overlay()`))}`,
  );
  const o = await js(`__smoke.overlay()`);
  expect(o.centre < 24, `the trail covered the masked subject instead of streaking around it (centre alpha ${o.centre})`);

  // and the whole frame still trails when asked to
  await js(`(() => { const s = document.querySelector('#trail-source'); const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; d.call(s, ''); s.dispatchEvent(new Event('change', { bubbles: true })); })(); true`);
  expect(
    await waitFor(`(() => { const o = __smoke.overlay(); return !!o && o.centre > 24; })()`, 12000),
    "the whole-frame trail stopped working",
  );

  expect(!(await js(`__smoke.toggle('Motion Trails')`)), "the trails toggle did not switch off");
  await js(`[...document.querySelectorAll('.mask-delete')].forEach(b => b.click()); true`);
  // let the debounced sidecar write land before the filmstrip steps start
  await sleep(1500);
});

await step("the look exports as a .cube LUT and says what it left behind", async () => {
  const cube = join(dir, "look.cube").split("\\").join("/");
  // a colour setting a LUT can carry, and a spatial one it cannot
  await js(`__smoke.slider(__smoke.open('Tone'), 'Exposure', 0.8); true`);
  await js(`__smoke.slider(__smoke.open('Detail'), 'Clarity', 40); true`);
  await sleep(1200);
  const left = await js(`import('/src/api.ts').then(async m => {
    const c = await import('/src/curve.ts');
    const e = await m.readEdits(${JSON.stringify(photo)});
    return m.exportCube(${JSON.stringify(cube)}, e, [...c.buildLut(e.curves)], 33, 'smoke');
  })`);
  expect(Array.isArray(left), `exportCube did not return a list: ${JSON.stringify(left)}`);
  expect(left.includes("Clarity"), `Clarity should have been reported as excluded: ${JSON.stringify(left)}`);

  const text = readFileSync(cube, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith("#"));
  expect(/^TITLE "smoke"$/m.test(text), "the cube has no TITLE");
  expect(/^LUT_3D_SIZE 33$/m.test(text), "the cube has no LUT_3D_SIZE");
  const rows = lines.filter((l) => /^[\d.]/.test(l));
  expect(rows.length === 33 ** 3, `the cube has ${rows.length} entries, expected ${33 ** 3}`);
  const bad = rows.find((l) => l.split(/\s+/).length !== 3 || l.split(/\s+/).some((v) => !Number.isFinite(parseFloat(v))));
  expect(!bad, `a malformed row: ${bad}`);
  // an exposure lift has to show: mid grey comes out brighter than it went in
  const mid = rows[(16 * 33 + 16) * 33 + 16].split(/\s+/).map(Number);
  expect(mid[1] > 0.5, `mid grey did not brighten through the LUT: ${mid.join(" ")}`);

  await js(`__smoke.slider(__smoke.open('Detail'), 'Clarity', 0); true`);
  await js(`__smoke.slider(__smoke.open('Tone'), 'Exposure', 0); true`);
  // let the debounced sidecar write land before the filmstrip steps start
  await sleep(1800);
});

await step("the filmstrip offers the batch actions", async () => {
  expect(await js(`!!document.querySelector('.filmstrip-actions')`), "no filmstrip actions");
  const before = await js(`document.querySelectorAll('.thumb').length`);
  await js(`__smoke.button('All').click(); true`);
  expect(
    await waitFor(`document.querySelectorAll('.thumb.picked').length === ${before}`, 4000),
    "Select all did not pick every photo",
  );
});

await step("right-click removes a photo from the filmstrip", async () => {
  const before = await js(`document.querySelectorAll('.thumb').length`);
  expect(before > 0, "no thumbnails to remove");
  await js(
    `(() => { const t = document.querySelector('.thumb'); const r = t.getBoundingClientRect(); t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 })); return true; })()`,
  );
  expect(await waitFor(`!!document.querySelector('.thumb-menu')`, 4000), "no context menu appeared");
  await js(`__smoke.button('Remove from filmstrip').click(); true`);
  expect(
    await waitFor(`document.querySelectorAll('.thumb').length === ${before - 1}`, 4000),
    "the photo was not removed from the filmstrip",
  );
  // and the rest of this test run's temp photos go with select all + Delete
  await js(`__smoke.button('All')?.click(); true`);
  await sleep(300);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true })); true`);
  expect(await waitFor(`document.querySelectorAll('.thumb').length === 0`, 5000), "Delete did not clear the filmstrip");
});

await step("no errors at the end", async () => {
  await sleep(500);
});

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
