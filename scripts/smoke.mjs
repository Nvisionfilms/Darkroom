// App smoke test: drives the real Darkroom window through every major tool
// and fails on any error toast, WebGL error or missing result.
//
//   node scripts/smoke.mjs <photo>
//
// Needs the debug app running with the webview debugging port open (the
// `bun run test -- --app <photo>` runner does that on Windows). The photo is
// copied to a temp folder first, so its real sidecar is never touched.

import { copyFileSync, mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
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
    let x0 = c.width, x1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 8) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
        }
      }
    }
    const span = x1 >= x0 ? x1 - x0 : 0;
    const cx = Math.max(0, Math.floor(c.width / 2) - 8);
    const cy = Math.max(0, Math.floor(c.height / 2) - 8);
    const mid = g.getImageData(cx, cy, 16, 16).data;
    let centre = 0;
    for (let i = 3; i < mid.length; i += 4) centre = Math.max(centre, mid[i]);
    return { w: c.width, h: c.height, lit: lit / n, centre, span };
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
  // the redesign lists one workspace's sections at a time; the steps below open
  // sections from every workspace, so they are all listed from here on
  await js(`window.__darkroom.showAllSections(true)`);
  await sleep(400);
});

await step("filmstrip thumbnail generated", async () => {
  expect(await waitFor(`[...document.querySelectorAll('.thumb')].some(t => t.querySelector('img'))`), "no thumbnail appeared");
});

await step("picture profiles visibly change what is on screen", async () => {
  // Measured on the preview itself. The profiles were once strengthened in the
  // export's copy of the table and not the preview's, so every exported file
  // changed while the screen stayed exactly as it was - and a test of the table,
  // or of the export, cannot see that. Only the picture you are looking at can.
  const look = async () =>
    JSON.parse(
      await js(`window.__darkroom.capture().then(async b => {
        const bm = await createImageBitmap(b);
        const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
        const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0);
        const d = g.getImageData(0, 0, cv.width, cv.height).data;
        const ys = []; let sat = 0, n = 0;
        for (let i = 0; i < d.length; i += 4) {
          ys.push((0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255);
          const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
          if (mx > 8) { sat += (mx - mn) / mx; n++; }
        }
        ys.sort((a, b) => a - b);
        const q = (f) => ys[Math.floor((ys.length - 1) * f)];
        return JSON.stringify({ spread: q(0.75) - q(0.25), sat: sat / n });
      })`),
    );
  const setProfile = (id) =>
    js(`(() => {
      const sel = [...document.querySelectorAll('select')].find(x => [...x.options].some(o => o.value === 'vivid'));
      if (!sel) return false;
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, ${JSON.stringify(id)});
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);

  await js(`__smoke.open('Color'); true`);
  await sleep(500);
  expect(await setProfile("standard"), "no profile selector found");
  await sleep(1500);
  const standard = await look();
  await setProfile("flat");
  await sleep(1600);
  const flat = await look();
  await setProfile("landscape");
  await sleep(1600);
  const landscape = await look();
  await setProfile("vivid");
  await sleep(1600);
  const vivid = await look();
  await setProfile("standard");
  await sleep(1200);

  // Flat is meant to be flat: measured, about a quarter off the tonal spread
  expect(flat.spread < standard.spread - 0.06, `Flat barely flattens the preview: ${standard.spread.toFixed(3)} -> ${flat.spread.toFixed(3)}`);
  // Landscape is meant to be colourful: measured, +0.12 saturation
  expect(landscape.sat > standard.sat + 0.04, `Landscape barely adds colour to the preview: ${standard.sat.toFixed(3)} -> ${landscape.sat.toFixed(3)}`);
  // Vivid is meant to be punchy: measured, +0.10 spread
  expect(vivid.spread > standard.spread + 0.035, `Vivid barely adds punch to the preview: ${standard.spread.toFixed(3)} -> ${vivid.spread.toFixed(3)}`);
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

await step("a retouch spot actually repairs, and its rings go when you press Done", async () => {
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  await js(`__smoke.open('Object Remover'); true`);
  await js(`__smoke.button('Remove objects').click(); true`);
  expect(await waitFor(`!!document.querySelector('.heal-surface')`, 4000), "repair tool did not activate");

  const before = (await js(`__smoke.shot()`)).mean;
  const box = JSON.parse(
    await js(`(() => { const r = document.querySelector('.heal-surface').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`),
  );
  // a click is a press and a release in the same place: one round spot
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 1 });
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 0 });
  expect(await waitFor(`document.querySelectorAll('.heal-spot').length === 1`, 6000), "spot did not appear");
  await sleep(2500);

  const spot = sidecar()?.heal?.[0];
  expect(spot && (Math.abs(spot.sx - spot.x) > 1e-3 || Math.abs(spot.sy - spot.y) > 1e-3), "no source patch was chosen");

  // the point of the tool: the picture has to change
  const after = (await js(`__smoke.shot()`)).mean;
  expect(Math.abs(after - before) > 1e-5, `placing a spot changed nothing in the picture (${before} -> ${after})`);

  // Done puts the tool away, and the rings with it - leaving them up hid the
  // repair they had just made
  await js(`__smoke.button('Done removing')?.click(); true`);
  await js(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
  expect(
    await waitFor(`document.querySelectorAll('.heal-spot').length === 0`, 4000),
    "the rings are still on the photo after Done",
  );
  // and the repair is still there with them gone
  const kept = sidecar()?.heal?.length ?? 0;
  expect(kept === 1, `the repair itself went away too (${kept} left)`);

  await js(`__smoke.open('Object Remover'); true`);
  await sleep(300);
  await js(`__smoke.button('Remove all spots')?.click(); true`);
  await sleep(1200);
});

await step("a notice takes itself away", async () => {
  // "Applied to 12 photos" is a receipt, not a warning, and it used to sit
  // there until it was clicked.
  await js(`__smoke.button('All')?.click(); true`);
  await sleep(300);
  await js(`__smoke.button('⚑ Mark')?.click(); true`);
  expect(await waitFor(`!!document.querySelector('.toast.notice')`, 4000), "no notice appeared to test");
  expect(await waitFor(`!document.querySelector('.toast.notice')`, 9000), "the notice never went away on its own");
  await js(`__smoke.button('⚑ Mark')?.click(); true`);
  // and let that one go too, so the next step does not inherit it
  await waitFor(`!!document.querySelector('.toast.notice')`, 4000);
  expect(await waitFor(`!document.querySelector('.toast.notice')`, 9000), "the second notice stayed up");
  await sleep(400);
});

await step("a repair can be painted along a path, not just stamped in circles", async () => {
  // Dragging the photo with the retouch tool records the path the brush swept,
  // so a wire or a line marking can be followed. A click is still one circle.
  const sec = await js(`(() => { __smoke.open('Object Remover'); return 1; })()`);
  expect(sec === 1, "no Object Remover section");
  await sleep(400);
  await js(`__smoke.button('Remove objects')?.click(); true`);
  await sleep(600);
  expect(await js(`!!document.querySelector('.heal-surface')`), "the retouch surface is not on the photo");

  const box = JSON.parse(
    await js(`(() => { const r = document.querySelector('.heal-surface').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }); })()`),
  );
  const span = Math.min(box.w * 0.18, 150);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x - span, y: box.y, button: "left", clickCount: 1, buttons: 1 });
  for (let i = -span + 15; i <= span; i += 15) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + i, y: box.y - i * 0.2, button: "left", buttons: 1 });
    await sleep(30);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + span, y: box.y - span * 0.2, button: "left", clickCount: 1, buttons: 0 });
  await sleep(2500);

  const spot = await js(`import('/src/api.ts').then(m => m.readEdits(${JSON.stringify(photo)})).then(e => {
    const h = (e?.heal ?? [])[0];
    return JSON.stringify(h ? { path: (h.path ?? []).length, radius: h.radius, moved: Math.abs(h.sx - h.x) + Math.abs(h.sy - h.y) } : null);
  })`);
  const h = JSON.parse(spot);
  expect(h, "no retouch spot was created by the drag");
  expect(h.path > 1, `the drag recorded no path, only ${h.path} point(s)`);
  expect(h.path <= 8, `the path was not thinned to the shader's limit: ${h.path} points`);
  expect(h.moved > 0, "the spot never found anywhere to copy from");

  // the path has to be checked where it lives, since a drag is the only way in
  const covered = await js(`import('/src/heal.ts').then(m => {
    const pts = [[0, 0], [10, 0], [20, 5]];
    const near = m.distToPath(pts, 15, 2);
    const far = m.distToPath(pts, 15, 40);
    return JSON.stringify({ near, far });
  })`);
  const c = JSON.parse(covered);
  expect(c.near < 3, `a point beside the path reads as ${c.near} away`);
  expect(c.far > 30, `a point well off the path reads as only ${c.far} away`);

  // put the tool away: its surface covers the whole photo and would swallow
  // every pointer event the later steps need
  await js(`__smoke.button('Remove all spots')?.click(); true`);
  await sleep(400);
  await js(`__smoke.button('Done removing')?.click(); true`);
  expect(await waitFor(`!document.querySelector('.heal-surface')`, 4000), "the retouch tool stayed on");
  await sleep(1200);
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
      `(() => { const sel = [...document.querySelectorAll('.blend-panel select')].find(x => [...x.options].some(o => o.value === 'screen')); Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'screen'); sel.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`,
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

await step("the vignette darkens the corners and leaves the middle alone", async () => {
  // The shader is a separate implementation of vignette.rs, so the preview is
  // where that twin is actually exercised.
  const corners = async () => {
    const r = await js(`window.__darkroom.capture().then(async b => {
      const bm = await createImageBitmap(b);
      const cv = document.createElement('canvas'); cv.width = bm.width; cv.height = bm.height;
      const g = cv.getContext('2d', { willReadFrequently: true }); g.drawImage(bm, 0, 0);
      const px = (x, y) => { const d = g.getImageData(Math.round(x), Math.round(y), 1, 1).data; return (d[0] + d[1] + d[2]) / 3 / 255; };
      const W = cv.width, H = cv.height;
      const corner = (px(W * 0.04, H * 0.06) + px(W * 0.96, H * 0.06) + px(W * 0.04, H * 0.94) + px(W * 0.96, H * 0.94)) / 4;
      return JSON.stringify({ corner, middle: px(W / 2, H / 2) });
    })`);
    return JSON.parse(r);
  };

  const before = await corners();
  expect(await js(`__smoke.toggle('Vignette')`), "the vignette toggle did not switch on");
  await js(`__smoke.slider(__smoke.open('Vignette'), 'Amount', -100); true`);
  await sleep(1400);
  const dark = await corners();
  expect(dark.corner < before.corner - 0.05, `the corners did not darken: ${before.corner.toFixed(3)} -> ${dark.corner.toFixed(3)}`);
  expect(Math.abs(dark.middle - before.middle) < 0.02, `the middle was darkened too: ${before.middle.toFixed(3)} -> ${dark.middle.toFixed(3)}`);

  // And the other way takes them towards white, as the slider reads. Measured
  // against the darkened corners rather than the untouched ones: a photo whose
  // corners are already near white has no room to show the lightening.
  await js(`__smoke.slider(__smoke.open('Vignette'), 'Amount', 100); true`);
  await sleep(1400);
  const light = await corners();
  expect(
    light.corner > dark.corner + 0.2,
    `the two ends of the slider do the same thing: dark ${dark.corner.toFixed(3)}, light ${light.corner.toFixed(3)}`,
  );
  expect(
    light.corner >= before.corner - 0.005,
    `a positive amount darkened instead: ${before.corner.toFixed(3)} -> ${light.corner.toFixed(3)}`,
  );

  expect(!(await js(`__smoke.toggle('Vignette')`)), "the vignette toggle did not switch off");
  await sleep(1200);
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

await step("a starburst can be limited to the lights inside a mask", async () => {
  const base = await js(`__smoke.shot()`);
  await js(`[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes('Add mask')).click(); true`);
  await sleep(300);
  await js(`[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === 'Radial gradient').click(); true`);
  await sleep(600);
  // hide the red overlay: the star must stay inside the mask without it
  await js(`(() => { const c = document.querySelector('.mask-show input'); if (c && c.checked) c.click(); })(); true`);
  expect(await js(`__smoke.toggle('Starburst')`), "the starburst toggle did not switch on");
  await js(`__smoke.slider(__smoke.open('Starburst'), 'Threshold', 10); true`);
  await js(`__smoke.slider(__smoke.open('Starburst'), 'Amount', 100); true`);
  await js(`__smoke.slider(__smoke.open('Starburst'), 'Length', 100); true`);
  await sleep(1600);
  const whole = await js(`__smoke.shot()`);
  expect(whole.mean > base.mean + 0.008, "the whole-frame star brightened nothing");
  const set = (v) => js(`(() => { const s = document.querySelector('#star-source'); const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set; d.call(s, ${JSON.stringify(v)}); s.dispatchEvent(new Event('change', { bubbles: true })); return s.value; })()`);
  const picked = await js(`[...document.querySelectorAll('#star-source option')].map(o => o.value).find(v => v) || ''`);
  expect(picked.length > 0, "the starburst offers no mask to come from");
  await set(picked);
  await sleep(2500);
  const masked = await js(`__smoke.shot()`);
  expect(
    masked.mean - base.mean < (whole.mean - base.mean) * 0.9,
    `a starburst limited to a mask still lit the whole frame: +${(whole.mean - base.mean).toFixed(4)} -> +${(masked.mean - base.mean).toFixed(4)}`,
  );
  await set("");
  await sleep(1500);
  const again = await js(`__smoke.shot()`);
  expect(Math.abs(again.mean - whole.mean) < 0.004, "going back to the whole photo did not bring the whole-frame star back");
  expect(!(await js(`__smoke.toggle('Starburst')`)), "the starburst toggle did not switch off");
  await js(`[...document.querySelectorAll('.mask-delete')].forEach(b => b.click()); true`);
  await sleep(1500);
});

await step("a subtract mask takes its area back out of the mask above it", async () => {
  const plain = await js(`__smoke.shot()`);
  const addMask = async (kind, button) => {
    const before = await js(`document.querySelectorAll('.mask-row').length`);
    await js(`[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes(${JSON.stringify(button)})).click(); true`);
    // wait for the list of kinds to open rather than guessing how long that takes
    expect(await waitFor(`!!document.querySelector('.mask-add-item')`, 5000), "the list of mask kinds did not open");
    await js(
      `[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === ${JSON.stringify(kind)}).click(); true`,
    );
    expect(await waitFor(`document.querySelectorAll('.mask-row').length > ${before}`, 5000), "the mask did not appear in the list");
    await sleep(300);
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

await step("a subtraction under a mask with no adjustments still reaches the shader", async () => {
  // The red overlay is the only visible sign of this, and capture() strips the
  // overlay on purpose, so the grouping is checked where it lives instead - in
  // the app's own module, through the app's own module graph.
  const r = await js(`import('/src/mask.ts').then(async m => {
    const t = await import('/src/types.ts');
    const head = Object.assign(t.newMask('radial', []), { id: 'head' });
    const sub = Object.assign(t.newMask('brush', [], 'subtract'), { id: 'sub' });
    const ids = (showId) => m.shaderMasks([head, sub], showId, 8).map(x => x.id).join(',');
    return JSON.stringify({
      nothingSelected: ids(null),
      headSelected: ids('head'),
      subSelected: ids('sub'),
      headAdjusted: m.shaderMasks([Object.assign({}, head, { adjust: Object.assign({}, head.adjust, { exposure: 2 }) }), sub], null, 8).map(x => x.id).join(','),
    });
  })`);
  const g = JSON.parse(r);
  // a head that changes nothing and is not being looked at: nothing to evaluate
  expect(g.nothingSelected === "", `expected an empty list, got "${g.nothingSelected}"`);
  // selecting either one brings the whole group in, so the brush can be painted
  expect(g.headSelected === "head,sub", `head selected gave "${g.headSelected}"`);
  expect(g.subSelected === "head,sub", `subtraction selected gave "${g.subSelected}"`);
  // and an adjustment on the head brings it in without anything being selected
  expect(g.headAdjusted === "head,sub", `adjusted head gave "${g.headAdjusted}"`);
});

await step("motion trails keep drawing while the mask overlay is up", async () => {
  // the trail used to vanish whenever Show mask was ticked, which is not what
  // you want when the mask is the thing the trail is cut from
  await js(`[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes('Add mask')).click(); true`);
  await sleep(300);
  await js(`[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === 'Radial gradient').click(); true`);
  await sleep(600);
  expect(await js(`__smoke.toggle('Motion Trails')`), "the trails toggle did not switch on");
  expect(
    await waitFor(`(() => { const o = __smoke.overlay(); return !!o && o.lit > 0.004; })()`, 12000),
    "no trail was drawn to begin with",
  );
  await js(`(() => { const c = document.querySelector('.mask-show input'); if (!c.checked) c.click(); })(); true`);
  await sleep(1500);
  const o = await js(`__smoke.overlay()`);
  expect(o && o.lit > 0.004, `the trail vanished when the mask overlay went up: ${JSON.stringify(o)}`);

  await js(`(() => { const c = document.querySelector('.mask-show input'); if (c.checked) c.click(); })(); true`);
  expect(!(await js(`__smoke.toggle('Motion Trails')`)), "the trails toggle did not switch off");
  await js(`[...document.querySelectorAll('.mask-delete')].forEach(b => b.click()); true`);
  // let the debounced sidecar write land before the filmstrip steps start
  await sleep(1800);
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

  // and at 1:1, where the photo rectangle the mask used to be fitted to does
  // not exist: the mask has to follow the viewer's own transform instead
  await js(`window.dispatchEvent(new CustomEvent('darkroom:zoom', { detail: '100' })); true`);
  await sleep(2000);
  const z = await js(`__smoke.overlay()`);
  expect(z && z.lit > 0.004, `no trail at 1:1: ${JSON.stringify(z)}`);
  expect(z.centre < 24, `at 1:1 the trail covered the subject (centre alpha ${z.centre})`);
  // the trail is a fraction of the PHOTO, so zooming in makes it bigger on
  // screen too (the span saturates against the canvas edge, hence the modest
  // factor - the arithmetic itself is pinned in the next step)
  expect(z.span > o.span * 1.2, `the trail did not grow with the photo: ${o.span}px at Fit, ${z.span}px at 1:1`);
  await js(`window.dispatchEvent(new CustomEvent('darkroom:zoom', { detail: 'fit' })); true`);
  await sleep(1500);

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

await step("trail distances are measured against the photo, not the window", async () => {
  // This is what made the trail float: with the distance measured against the
  // canvas, the echoes kept their size in screen pixels while the photo under
  // them grew and shrank. Pinned here as arithmetic, because on screen the
  // trail runs off the edge of the canvas before the difference is obvious.
  const r = await js(`import('/src/trail.ts').then(t => JSON.stringify({
    fit: t.trailDistance(0.2, 6000, 0.25),
    oneToOne: t.trailDistance(0.2, 6000, 1),
    clamped: t.trailDistance(5, 6000, 1),
    blurFit: t.trailBlur(1, 6000, 0.25),
    blurOne: t.trailBlur(1, 6000, 1),
    copies: [t.trailCopies(0.4), t.trailCopies(2.4), t.trailCopies(9)],
    fade: t.trailFadeRetention(100),
  }))`);
  const t = JSON.parse(r);
  expect(t.oneToOne === 1200, `distance at 1:1 should be 0.2 x 6000 = 1200, got ${t.oneToOne}`);
  expect(t.fit === 300, `distance zoomed out 4x should be a quarter of that, got ${t.fit}`);
  expect(t.oneToOne === t.fit * 4, "the distance did not follow the zoom");
  expect(t.clamped === 0.7 * 6000, `length should clamp at 0.7, got ${t.clamped}`);
  expect(t.blurOne === t.blurFit * 4, "the blur did not follow the zoom");
  expect(t.blurOne === 32, `blur should clamp at 32 photo pixels, got ${t.blurOne}`);
  expect(JSON.stringify(t.copies) === "[4,24,24]", `copies: ${JSON.stringify(t.copies)}`);

  // The export lays trails on the cropped picture, so the preview must measure
  // them against the crop too - against the whole image they were twice as long
  // on screen as in the file for a crop that kept half the width.
  const crop = JSON.parse(await js(`import('/src/trail.ts').then(m => JSON.stringify({
    whole: m.trailLongEdge({ width: 2000, height: 1333 }),
    half: m.trailLongEdge({ width: 2000, height: 1333, outW: 1000, outH: 1333 }),
    tall: m.trailLongEdge({ width: 2000, height: 1333, outW: 500, outH: 900 }),
    junk: m.trailLongEdge({ width: 2000, height: 1333, outW: 0, outH: 0 }),
  }))`));
  expect(crop.whole === 2000, `no crop should use the whole image: ${crop.whole}`);
  expect(crop.half === 1333, `a half-width crop should be measured by its own long edge: ${crop.half}`);
  expect(crop.tall === 900, `a tall crop should use its height: ${crop.tall}`);
  expect(crop.junk === 2000, `an unknown crop should fall back to the whole image: ${crop.junk}`);
  expect(Math.abs(t.fade - 0.98) < 1e-9, `full fade should retain 0.98, got ${t.fade}`);
});

await step("the subject matte is pulled onto the picture's own edges", async () => {
  // The model sees a 320-pixel copy, so its matte knows where the subject is but
  // not exactly where it ends. Here the picture has a hard edge down the middle
  // and the matte's edge is a soft ramp sitting six pixels late; refining it has
  // to move the matte onto the real edge and tighten it, without eating into the
  // subject or filling in the background.
  const r = await js(`import('/src/subject.ts').then(m => {
    const w = 640, h = 420, at = 320;
    const guide = new Uint8Array(w * h);
    const mask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        guide[y * w + x] = x < at ? 230 : 40;
        const t = Math.max(0, Math.min(1, (at + 12 - x) / 12));
        mask[y * w + x] = Math.round(t * 255);
      }
    }
    const out = m.refineMatte(mask, guide, w, h);
    const row = (v) => Array.from({ length: w }, (_, x) => v[210 * w + x]);
    const edge = (v) => { const r = row(v); for (let x = 1; x < w; x++) if (r[x] < 128 && r[x - 1] >= 128) return x; return -1; };
    // steepness at the boundary: a tighter matte has a sharper step in it
    const steep = (v) => { const r = row(v); let m = 0; for (let x = 1; x < w; x++) m = Math.max(m, Math.abs(r[x] - r[x - 1])); return m; };
    return JSON.stringify({ before: edge(mask), after: edge(out), sBefore: steep(mask), sAfter: steep(out), inside: out[210 * w + 40], outside: out[210 * w + 600] });
  })`);
  const g = JSON.parse(r);
  expect(g.before >= 325, `the test's own matte should start late, it was at ${g.before}`);
  // how far the window can pull the edge depends on its size, which scales with
  // the picture, so what is asserted is that most of the error goes away - on a
  // real photo the matte is larger still and it lands exactly
  const errBefore = Math.abs(g.before - 320);
  const errAfter = Math.abs(g.after - 320);
  expect(errAfter <= errBefore / 2, `the matte barely moved: ${errBefore}px out -> ${errAfter}px out`);
  expect(g.sAfter > g.sBefore * 1.2, `the matte did not tighten: step ${g.sBefore} -> ${g.sAfter}`);
  expect(g.inside > 240, `the inside of the subject was eaten: ${g.inside}`);
  expect(g.outside < 15, `the background was filled in: ${g.outside}`);
});

await step("a painted brush subtraction takes its area out of the mask above it", async () => {
  // The reported case: a mask with a brush subtraction under it, painted by
  // hand. Everything here is driven through the real brush surface, so what is
  // measured is whether painting actually removes the mask's effect.
  const add = async (kind, button) => {
    await js(
      `[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes(${JSON.stringify(button)})).click(); true`,
    );
    await sleep(300);
    await js(
      `[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === ${JSON.stringify(kind)}).click(); true`,
    );
    await sleep(700);
  };
  const plain = (await js(`__smoke.shot()`)).mean;

  await add("Radial gradient", "Add mask");
  await js(`__smoke.slider(document.querySelector('.mask-edit'), 'Exposure', 4); true`);
  await sleep(1200);
  const bright = (await js(`__smoke.shot()`)).mean;
  expect(bright > plain + 0.01, `the mask did not brighten anything: ${plain.toFixed(3)} -> ${bright.toFixed(3)}`);

  await add("Brush", "Subtract");
  expect(await js(`document.querySelectorAll('.mask-row.subtract').length === 1`), "the brush subtraction was not added");
  await sleep(600);
  expect(await js(`!!document.querySelector('.brush-overlay')`), "no brush surface to paint on");

  // paint right across the middle of the radial, where its effect is strongest
  const box = JSON.parse(
    await js(`(() => { const r = document.querySelector('.brush-overlay').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width }); })()`),
  );
  const span = Math.min(box.w * 0.2, 180);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x - span, y: box.y, button: "left", clickCount: 1, buttons: 1 });
  for (let i = -span + 20; i <= span; i += 20) {
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x + i, y: box.y, button: "left", buttons: 1 });
    await sleep(40);
  }
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x + span, y: box.y, button: "left", clickCount: 1, buttons: 0 });
  await sleep(1800);

  const painted = await js(`import('/src/api.ts').then(m => m.readEdits(${JSON.stringify(photo)})).then(e => {
    const b = (e?.masks ?? []).find(m => m.kind === 'brush');
    return b ? b.strokes.reduce((n, s) => n + s.x.length, 0) : 0;
  })`);
  expect(painted > 1, `the brush recorded nothing (${painted} points)`);

  const cut = (await js(`__smoke.shot()`)).mean;
  expect(
    cut < bright - (bright - plain) * 0.25,
    `painting the subtraction removed nothing: plain ${plain.toFixed(3)}, bright ${bright.toFixed(3)}, after painting ${cut.toFixed(3)}`,
  );

  await js(`[...document.querySelectorAll('.mask-delete')].forEach(b => b.click()); true`);
  // let the debounced sidecar write land before the next steps start
  await sleep(1800);
});

await step("subject detection can keep just the main subject", async () => {
  // The model finds whatever stands out, so a player in the foreground and a
  // referee behind them come back in one matte. Two islands here, one much
  // bigger: only the bigger one may survive, with its soft edge intact.
  const r = await js(`import('/src/subject.ts').then(m => {
    const w = 200, h = 120;
    const mask = new Uint8Array(w * h);
    const blob = (cx, cy, rr) => {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - cx, y - cy);
        if (d <= rr) mask[y * w + x] = 255;
        else if (d <= rr + 3) mask[y * w + x] = Math.round(255 * (1 - (d - rr) / 3));
      }
    };
    blob(50, 60, 30);   // the subject
    blob(160, 40, 10);  // someone in the background
    const out = m.largestRegion(mask, w, h);
    const sum = (v) => { let n = 0; for (let i = 0; i < v.length; i++) n += v[i] > 0 ? 1 : 0; return n; };
    return JSON.stringify({
      keptCentre: out[60 * w + 50],
      keptEdge: out[60 * w + (50 + 31)],
      dropped: out[40 * w + 160],
      droppedFringe: out[40 * w + (160 + 11)],
      before: sum(mask),
      after: sum(out),
    });
  })`);
  const g = JSON.parse(r);
  expect(g.keptCentre === 255, `the main subject was not kept solid: ${g.keptCentre}`);
  expect(g.keptEdge > 0 && g.keptEdge < 255, `the kept subject lost its soft edge: ${g.keptEdge}`);
  expect(g.dropped === 0, `the background subject survived: ${g.dropped}`);
  expect(g.droppedFringe === 0, `the background subject left a fringe behind: ${g.droppedFringe}`);
  expect(g.after < g.before, `nothing was removed: ${g.before} -> ${g.after}`);
});

await step("a brush paints with a finger, not just a mouse", async () => {
  // On a phone the browser claims a drag on the photo for scrolling and cancels
  // the pointer stream, so the brush painted nothing while a mouse worked
  // perfectly. Driven here as real touch events with touch emulation on, which
  // is the only way that difference shows up.
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  try {
    await js(`[...__smoke.open('Masks').querySelectorAll('.mask-toolbar button')].find(b => b.textContent.includes('Add mask')).click(); true`);
    await sleep(300);
    await js(`[...document.querySelectorAll('.mask-add-item')].find(b => b.querySelector('strong').textContent === 'Brush').click(); true`);
    await sleep(900);
    expect(await js(`!!document.querySelector('.brush-overlay')`), "the brush surface is not on the photo");
    // the phone needs this: without it the browser claims the drag for scrolling
    expect(
      await js(`getComputedStyle(document.querySelector('.brush-overlay')).touchAction === 'none'`),
      "the brush surface still lets the browser take the gesture",
    );

    const box = await js(`(() => { const r = document.querySelector('.brush-overlay').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`);
    const { x, y } = JSON.parse(box);
    const at = (dx) => [{ x: x + dx, y, radiusX: 8, radiusY: 8, force: 1, id: 1 }];
    await send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: at(-60) });
    for (let dx = -40; dx <= 60; dx += 20) {
      await send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: at(dx) });
      await sleep(40);
    }
    await send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await sleep(1500);

    const strokes = await js(`(window.__smokeMasks ?? 0, document.querySelectorAll('.mask-row').length)`);
    expect(strokes > 0, "the brush mask vanished");
    const painted = await js(`import('/src/api.ts').then(m => m.readEdits(${JSON.stringify(photo)})).then(e => {
      const b = (e?.masks ?? []).find(m => m.kind === 'brush');
      return b ? b.strokes.reduce((n, s) => n + s.x.length, 0) : 0;
    })`);
    expect(painted > 1, `a finger drag painted nothing (${painted} points recorded)`);
  } finally {
    await send("Emulation.setTouchEmulationEnabled", { enabled: false });
    await js(`[...document.querySelectorAll('.mask-delete')].forEach(b => b.click()); true`);
    await sleep(1500);
  }
});

await step("the vectorscope's skin line is where skin actually lands", async () => {
  // The line is derived from real complexions rather than copied from a
  // diagram, so what has to hold is that complexions fall on it and other
  // colours do not.
  const r = await js(`import('/src/scopes.ts').then(m => {
    const deg = (x) => (x * 180) / Math.PI;
    const onLine = m.SKIN_REFERENCES.map(([r, g, b]) => deg(m.angleFromSkinLine(r, g, b)));
    const others = {
      sky: deg(m.angleFromSkinLine(0.45, 0.62, 0.86)),
      grass: deg(m.angleFromSkinLine(0.35, 0.55, 0.24)),
      lips: deg(m.angleFromSkinLine(0.72, 0.25, 0.28)),
      magenta: deg(m.angleFromSkinLine(0.8, 0.2, 0.7)),
    };
    const grey = m.chroma(0.5, 0.5, 0.5);
    return JSON.stringify({ worstSkin: Math.max(...onLine), others, grey, angle: deg(m.skinAngle()) });
  })`);
  const v = JSON.parse(r);
  // every complexion, light through deep, has to sit close to the line
  expect(v.worstSkin < 12, `a complexion sits ${v.worstSkin.toFixed(1)} degrees off the skin line`);
  // and things that are not skin have to sit clearly off it
  for (const [name, d] of Object.entries(v.others)) {
    expect(d > 25, `${name} sits only ${d.toFixed(1)} degrees off the skin line`);
  }
  // grey has no hue, so it belongs at the middle of the scope
  expect(Math.abs(v.grey[0]) < 1e-6 && Math.abs(v.grey[1]) < 1e-6, `grey is not at the centre: ${JSON.stringify(v.grey)}`);
  // Skin is warm - more red than blue - so it sits up and to the left on the
  // scope, which is the second quadrant. Worked out from the complexions alone
  // it lands within a few degrees of the broadcast I-line at 123, which is a
  // good sign that the derivation is sound rather than a coincidence of taste.
  expect(
    v.angle > 110 && v.angle < 140,
    `the skin line points somewhere odd: ${v.angle.toFixed(1)} degrees, expected near 123`,
  );
});

await step("the scopes read the picture, not an empty buffer", async () => {
  // Waveform and parade are built from the frame the renderer hands over; if
  // that ever came back empty the scopes would be blank and look "broken".
  const r = await js(`import('/src/scopes.ts').then(m => {
    const w = 8, h = 4;
    const data = new Uint8Array(w * h * 4);
    for (let i = 0; i < w * h; i++) {
      // a left-to-right ramp, so the waveform has to slope
      const v = Math.round((i % w) / (w - 1) * 255);
      data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
    }
    const frame = { data, width: w, height: h };
    const wf = m.waveform(frame, w, 16, m.luma);
    const rowOf = (col) => { for (let row = 0; row < 16; row++) if (wf[row * w + col] > 0) return row; return -1; };
    return JSON.stringify({ total: wf.reduce((a, b) => a + b, 0), darkCol: rowOf(0), brightCol: rowOf(w - 1) });
  })`);
  const v = JSON.parse(r);
  expect(v.total === 32, `the waveform counted ${v.total} pixels of 32`);
  // brightness runs up the plot, so the bright end must sit higher
  expect(v.brightCol < v.darkCol, `the waveform is upside down or flat: dark ${v.darkCol}, bright ${v.brightCol}`);
});

await step("a file dropped anywhere in the window reaches the double exposure", async () => {
  // OS drags cannot be synthesised, so the decision is checked where it is made.
  const r = await js(`import('/src/dropTarget.ts').then(m => {
    const win = { left: 0, top: 0, right: 1400, bottom: 900 };
    return JSON.stringify({
      onPhoto: m.dropGoesToBlend(true, 600 * 2, 400 * 2, win, 2),
      offZone: m.dropGoesToBlend(true, 40 * 2, 880 * 2, win, 2),
      outside: m.dropGoesToBlend(true, 1500 * 2, 400 * 2, win, 2),
      closed: m.dropGoesToBlend(false, 600 * 2, 400 * 2, win, 2),
      noDpr: m.dropGoesToBlend(true, 600, 400, win, 0),
      first: m.firstPhoto(['C:/x/notes.txt', 'C:/x/folder', 'C:/x/IMG_0001.CR3', 'C:/x/b.jpg']),
      none: m.firstPhoto(['C:/x/notes.txt', 'C:/x/archive.zip']),
      dotDir: m.firstPhoto(['C:/some.dir/readme']),
      extra: m.firstPhoto(['C:/x/shot.zzz'], ['.zzz']),
      braw: m.firstPhoto(['D:/clip/frame.braw']),
    });
  })`);
  const v = JSON.parse(r);
  expect(v.onPhoto, "a drop on the photo was not taken");
  expect(v.offZone, "a drop a little off the zone was not taken");
  expect(!v.outside, "a drop outside the window was taken");
  expect(!v.closed, "a drop was claimed with the section closed");
  expect(v.noDpr, "a missing pixel ratio broke the hit test");
  expect(v.first === "C:/x/IMG_0001.CR3", `the first photo was not found: ${v.first}`);
  expect(v.none === null, `a drop with no photo in it found one: ${v.none}`);
  expect(v.dotDir === null, `a dot in a folder name was read as an extension: ${v.dotDir}`);
  expect(v.extra === "C:/x/shot.zzz", "the app's own list of formats was ignored");
  expect(v.braw === "D:/clip/frame.braw", "a cinema RAW was not recognised");
});

await step("a double exposure can use the photo you are editing, picked from the filmstrip", async () => {
  await js(`__smoke.open('Double Exposure'); true`);
  await sleep(500);
  // start clean: whatever an earlier step left in the panel
  await js(`(() => { const b = [...document.querySelectorAll('.blend-panel button')].find(x => x.textContent.trim() === 'Remove'); if (b) b.click(); return 1; })()`);
  await sleep(700);
  const listed = await js(`(() => {
    const sel = [...document.querySelectorAll('.blend-panel select')].find(x => [...x.options].some(o => o.textContent.includes('this photo')));
    return sel ? JSON.stringify([...sel.options].map(o => o.textContent.trim())) : null;
  })()`);
  expect(listed, "the filmstrip picker is not in the panel");
  expect(listed.includes("(this photo)"), `the open photo is not offered as its own second exposure: ${listed}`);

  await js(`(() => {
    const sel = [...document.querySelectorAll('.blend-panel select')].find(x => [...x.options].some(o => o.textContent.includes('this photo')));
    const opt = [...sel.options].find(o => o.textContent.includes('this photo'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })(); true`);
  expect(
    await waitFor(`(() => { const t = document.querySelector('.blend-file strong'); return !!t && t.textContent.includes(${JSON.stringify(basename(photo))}); })()`, 12000),
    "choosing the open photo from the filmstrip did not load it",
  );
  await sleep(1800);
  const saved = sidecar()?.blend;
  expect(saved?.path === photo, `the second exposure is not the same photo: ${saved?.path}`);

  await js(`(() => { const b = [...document.querySelectorAll('.blend-panel button')].find(x => x.textContent.trim() === 'Remove'); if (b) b.click(); return 1; })()`);
  await sleep(1200);
});

await step("tone match pulls the photo towards a reference, backs off with strength, and undoes", async () => {
  // A dark, low-contrast reference: the photo is bright, so a working match has
  // to pull it down, and has to give every slider back when asked.
  const dataUrl = await js(`(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 64; const g = c.getContext('2d'); const gr = g.createLinearGradient(0, 0, 64, 0); gr.addColorStop(0, '#0d0d0d'); gr.addColorStop(1, '#4a4a4a'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return c.toDataURL('image/png'); })()`);
  const refFile = join(dir, "smoke-reference.png").split("\\").join("/");
  writeFileSync(refFile, Buffer.from(dataUrl.split(",")[1], "base64"));

  const start = await js(`import('/src/api.ts').then(m => m.readEdits(${JSON.stringify(photo)})).then(e => JSON.stringify({ exposure: e?.exposure ?? 0, contrast: e?.contrast ?? 0, temperature: e?.temperature ?? 0 }))`);
  const was = JSON.parse(start);

  // the command itself, so a failure can be told apart from a UI problem
  const direct = JSON.parse(
    await js(`Promise.all([import('/src/api.ts'), import('/src/types.ts'), import('/src/curve.ts')]).then(async ([api, t, cv]) => {
      const p = t.defaultParams();
      const r = await api.matchTone(${JSON.stringify(refFile)}, p, Array.from(cv.buildLut(p.curves)));
      return JSON.stringify({ exposure: r.values.exposure, before: r.distanceBefore, after: r.distanceAfter, refMedian: r.reference.q[3], beforeMedian: r.before.q[3], afterMedian: r.after.q[3] });
    })`),
  );
  expect(direct.refMedian < direct.beforeMedian - 0.1, `the test reference is not darker than the photo: ${direct.refMedian} vs ${direct.beforeMedian}`);
  expect(direct.exposure < -0.3, `a dark reference did not darken the photo: exposure ${direct.exposure}`);
  expect(direct.after < direct.before * 0.5, `the match barely closed the gap: ${direct.before} -> ${direct.after}`);
  expect(Math.abs(direct.afterMedian - direct.refMedian) < Math.abs(direct.beforeMedian - direct.refMedian) * 0.4, "the median did not move towards the reference");

  // and through the app: the sliders move, strength backs them off, undo restores
  await js(`window.__darkroom.toneMatch(${JSON.stringify(refFile)}); true`);
  expect(await waitFor(`!!document.querySelector('.tonematch-panel .tm-curves')`, 20000), "the match result never appeared in the panel");
  await sleep(800);
  const matched = JSON.parse(await js(`JSON.stringify({ exposure: __smoke.sliderValue(__smoke.open('Tone'), 'Exposure') })`));
  expect(matched.exposure < was.exposure - 0.3, `the Exposure slider did not move: ${was.exposure} -> ${matched.exposure}`);

  await js(`__smoke.slider(__smoke.open('Tone Match'), 'Strength', 0); true`);
  await sleep(700);
  const off = JSON.parse(await js(`JSON.stringify({ exposure: __smoke.sliderValue(__smoke.open('Tone'), 'Exposure') })`));
  expect(Math.abs(off.exposure - was.exposure) < 0.06, `strength 0 did not give the photo back: ${was.exposure} vs ${off.exposure}`);

  await js(`__smoke.slider(__smoke.open('Tone Match'), 'Strength', 100); true`);
  await sleep(700);
  await js(`__smoke.button('Undo match')?.click(); true`);
  await sleep(800);
  const back = JSON.parse(await js(`JSON.stringify({ exposure: __smoke.sliderValue(__smoke.open('Tone'), 'Exposure'), contrast: __smoke.sliderValue(__smoke.open('Tone'), 'Contrast') })`));
  expect(Math.abs(back.exposure - was.exposure) < 0.06, `Undo match left Exposure at ${back.exposure}, was ${was.exposure}`);
  expect(Math.abs(back.contrast - was.contrast) < 1.5, `Undo match left Contrast at ${back.contrast}, was ${was.contrast}`);
  expect(!(await js(`!!document.querySelector('.tonematch-panel .tm-curves')`)), "the result stayed up after Undo match");
  await sleep(1500);
});

await step("tone match arithmetic backs a match off evenly", async () => {
  const r = await js(`import('/src/toneMatch.ts').then(m => {
    const from = { exposure: 0.2, contrast: 10, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 0, tint: 0, saturation: 0 };
    const to = { exposure: 1.0, contrast: -30, highlights: 0, shadows: 0, whites: 0, blacks: 0, temperature: 40, tint: 0, saturation: 0 };
    return JSON.stringify({ zero: m.blendTune(from, to, 0), one: m.blendTune(from, to, 1), half: m.blendTune(from, to, 0.5), over: m.blendTune(from, to, 7), closed: [m.closed(1, 0.1), m.closed(0, 0), m.closed(1, 3)] });
  })`);
  const v = JSON.parse(r);
  expect(v.zero.exposure === 0.2 && v.zero.contrast === 10, "strength 0 is not the photo as it was");
  expect(v.one.exposure === 1 && v.one.temperature === 40, "strength 1 is not the full match");
  expect(Math.abs(v.half.exposure - 0.6) < 1e-9 && Math.abs(v.half.contrast + 10) < 1e-9 && Math.abs(v.half.temperature - 20) < 1e-9, `half strength is not halfway in each: ${JSON.stringify(v.half)}`);
  expect(v.over.exposure === 1, "a strength past 100% extrapolated");
  expect(Math.abs(v.closed[0] - 90) < 1e-6, `closed gap is ${v.closed[0]}`);
  expect(v.closed[1] === 100 && v.closed[2] === 0, `closed gap edge cases: ${JSON.stringify(v.closed)}`);
});

await step("a library watermark lands on an export of a photo that had none", async () => {
  // Make a solid red mark, keep it in the library, then export the photo with it
  // chosen at export time. The photo itself has no watermark saved, which is the
  // normal case for a batch: the mark was only ever placed on one photo.
  const dataUrl = await js(`(() => { const c = document.createElement('canvas'); c.width = 64; c.height = 32; const g = c.getContext('2d'); g.fillStyle = '#ff0000'; g.fillRect(0, 0, 64, 32); return c.toDataURL('image/png'); })()`);
  const markFile = join(dir, "smoke-mark.png").split("\\").join("/");
  writeFileSync(markFile, Buffer.from(dataUrl.split(",")[1], "base64"));
  const out = join(dir, "marked.jpg").split("\\").join("/");

  const r = await js(`Promise.all([import('/src/api.ts'), import('/src/exportMark.ts'), import('/src/curve.ts')]).then(async ([api, em, cv]) => {
    const saved = await api.watermarkSave(${JSON.stringify(markFile)}, 'smoke-mark');
    const lib = await api.watermarkLibrary();
    const edits = (await api.readEdits(${JSON.stringify(photo)})) ?? (await import('/src/types.ts')).defaultParams();
    const placed = { ...edits.watermark, x: 0.85, y: 0.88, size: 0.2, opacity: 100 };
    const marked = em.withMark({ ...edits, watermark: { ...edits.watermark, enabled: false, path: '' } }, saved.path, placed);
    await api.exportPath(${JSON.stringify(photo)}, {
      outPath: ${JSON.stringify(out)}, format: 'jpeg', quality: 95, bitDepth: 8, maxLongEdge: 800,
      params: marked, lut: Array.from(cv.buildLut(marked.curves)),
    });
    const none = em.withMark(marked, 'none', placed);
    return JSON.stringify({ inLibrary: lib.some(m => m.name === 'smoke-mark'), enabled: marked.watermark.enabled, noneEnabled: none.watermark.enabled, kept: em.withMark(edits, 'photo', placed) === edits });
  })`);
  const v = JSON.parse(r);
  expect(v.inLibrary, "the mark did not reach the library");
  expect(v.enabled, "choosing a mark did not switch the watermark on");
  expect(!v.noneEnabled, "choosing None left the watermark on");
  expect(v.kept, "leaving it as set on each photo changed the photo's edits");

  // and it is actually in the file, in the corner it was placed
  const b64 = readFileSync(out).toString("base64");
  const px = JSON.parse(await js(`new Promise((res, rej) => { const i = new Image(); i.onload = () => { const c = document.createElement('canvas'); c.width = i.naturalWidth; c.height = i.naturalHeight; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(i, 0, 0); let sx = 0, sy = 0, n = 0; const d = g.getImageData(0, 0, c.width, c.height).data; for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) { const k = (y * c.width + x) * 4; if (d[k] > 200 && d[k + 1] < 60 && d[k + 2] < 60) { sx += x / c.width; sy += y / c.height; n++; } } res(JSON.stringify({ n, x: n ? sx / n : 0, y: n ? sy / n : 0 })); }; i.onerror = rej; i.src = 'data:image/jpeg;base64,${b64}'; })`));
  expect(px.n > 100, `the watermark is not in the exported file (${px.n} red pixels)`);
  expect(px.x > 0.7 && px.y > 0.75, `the watermark is not in its corner: ${px.x.toFixed(2)}, ${px.y.toFixed(2)}`);

  await js(`import('/src/api.ts').then(m => m.watermarkDelete('smoke-mark'))`);
  const gone = await js(`import('/src/api.ts').then(m => m.watermarkLibrary()).then(l => !l.some(x => x.name === 'smoke-mark'))`);
  expect(gone, "the mark stayed in the library after being deleted");
});

await step("the Android update check only offers a genuinely newer version", async () => {
  // Android cannot replace itself - only its own package installer may - so it
  // polls a manifest and hands the APK to the browser. Everything rests on the
  // comparison, which must never nag about an equal or older version and must
  // not be fooled by a malformed manifest.
  const r = await js(`import('/src/updater.ts').then(m => JSON.stringify({
    newer: m.isNewer('0.2.17', '0.2.16'),
    same: m.isNewer('0.2.16', '0.2.16'),
    older: m.isNewer('0.2.15', '0.2.16'),
    minor: m.isNewer('0.3.0', '0.2.99'),
    major: m.isNewer('1.0.0', '0.9.9'),
    tagged: m.isNewer('v0.2.17', '0.2.16'),
    short: m.isNewer('0.3', '0.2.16'),
    junk: m.isNewer('', '0.2.16'),
    junkBoth: m.isNewer('not-a-version', '0.2.16'),
  }))`);
  const v = JSON.parse(r);
  expect(v.newer && v.minor && v.major && v.tagged && v.short, `a newer version was not offered: ${r}`);
  expect(!v.same && !v.older, `an equal or older version was offered: ${r}`);
  expect(!v.junk && !v.junkBoth, `a malformed manifest was offered as an update: ${r}`);

  // The check itself has to go through Rust. Fetching the manifest from the page
  // is cross-origin on a phone - the webview is served from tauri.localhost -
  // and the browser refuses it, which is what "Failed to fetch" was. On the
  // desktop the command answers null, because the app updates itself there.
  const viaRust = await js(`import('/src/api.ts').then(m => m.mobileUpdate()).then(v => JSON.stringify({ ok: true, v }), e => JSON.stringify({ ok: false, e: String(e) }))`);
  const m = JSON.parse(viaRust);
  expect(m.ok, `the mobile update command is not reachable: ${m.e}`);
  expect(m.v === null, `on the desktop the command should answer null, got ${JSON.stringify(m.v)}`);
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

await step("Auto reads the photo, and gives the same answer however the sliders were left", async () => {
  // The command itself first, so a failure can be told apart from a UI problem.
  const direct = JSON.parse(
    await js(`Promise.all([import('/src/api.ts'), import('/src/types.ts'), import('/src/curve.ts')]).then(async ([api, t, cv]) => {
      const p = t.defaultParams();
      const r = await api.autoLook(p, Array.from(cv.buildLut(p.curves)));
      return JSON.stringify({ v: r.values, before: r.distanceBefore, after: r.distanceAfter, ok: Object.values(r.values).every(Number.isFinite) });
    })`),
  );
  expect(direct.ok, `Auto returned a slider that is not a number: ${JSON.stringify(direct.v)}`);
  expect(direct.after <= direct.before + 1e-6, `Auto left the photo further from its target: ${direct.before} -> ${direct.after}`);

  const read = async () =>
    JSON.parse(
      await js(`JSON.stringify({
        exposure: __smoke.sliderValue(__smoke.open('Tone'), 'Exposure'),
        contrast: __smoke.sliderValue(__smoke.open('Tone'), 'Contrast'),
        shadows: __smoke.sliderValue(__smoke.open('Tone'), 'Shadows'),
      })`),
    );

  await js(`window.__darkroom.autoEdit(); true`);
  await sleep(2500);
  const once = await read();
  expect(
    [once.exposure, once.contrast, once.shadows].every(Number.isFinite),
    `Auto left a slider that is not a number: ${JSON.stringify(once)}`,
  );

  // fiddle with the very sliders Auto sets, then press it again
  await js(`__smoke.slider(__smoke.open('Tone'), 'Exposure', 1.7); true`);
  await js(`__smoke.slider(__smoke.open('Tone'), 'Contrast', -55); true`);
  await sleep(900);
  await js(`window.__darkroom.autoEdit(); true`);
  await sleep(2500);
  const again = await read();
  expect(
    Math.abs(again.exposure - once.exposure) < 0.02 && Math.abs(again.contrast - once.contrast) < 0.6,
    `Auto depends on what the sliders were: ${JSON.stringify(once)} then ${JSON.stringify(again)}`,
  );
  // and the part that is a matter of taste is set too
  const taste = await js(`JSON.stringify({ sharpen: __smoke.sliderValue(__smoke.open('Detail'), 'Sharpening'), clarity: __smoke.sliderValue(__smoke.open('Detail'), 'Clarity') })`);
  const t = JSON.parse(taste);
  expect(t.sharpen === 55 && t.clarity === 20, `the detail part of Auto was not applied: ${taste}`);
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
