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
  problems() {
    return [document.querySelector('.toast')?.textContent, document.querySelector('.viewer-error')?.textContent].filter(Boolean);
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

await step("no errors at the end", async () => {
  await sleep(500);
});

ws.close();
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
