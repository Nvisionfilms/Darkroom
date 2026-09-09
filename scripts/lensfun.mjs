// Build src-tauri/data/lensfun.json from the lensfun database (CC-BY-SA 3.0).
// Only the fields Darkroom uses are kept: camera crop factors and lens
// distortion / vignetting / TCA calibrations.
//   bun run scripts/lensfun.mjs
import { XMLParser } from "fast-xml-parser";
import { writeFileSync } from "node:fs";

const API = "https://api.github.com/repos/lensfun/lensfun/contents/data/db";
const list = await (await fetch(API, { headers: { "User-Agent": "darkroom-lensfun" } })).json();
const files = list.filter((f) => f.name.endsWith(".xml") && !f.name.startsWith("compat"));
console.log(files.length, "xml files");
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", isArray: (n) => ["camera", "lens", "model", "mount", "distortion", "vignetting", "tca"].includes(n) });
const cameras = [];
const lenses = [];
const num = (v) => (v === undefined ? undefined : parseFloat(v));
const name = (m) => {
  if (!m) return "";
  const arr = Array.isArray(m) ? m : [m];
  const plain = arr.find((x) => typeof x === "string") ?? arr.find((x) => x["@lang"] === "en")?.["#text"] ?? arr[0]?.["#text"] ?? "";
  return String(plain).trim();
};
for (const f of files) {
  const xml = await (await fetch(f.download_url)).text();
  const db = parser.parse(xml).lensdatabase;
  if (!db) continue;
  for (const c of db.camera ?? []) {
    cameras.push({ maker: name(c.maker), model: name(c.model), mount: name(c.mount?.[0] ?? c.mount), crop: num(c.cropfactor) ?? 1 });
  }
  for (const l of db.lens ?? []) {
    const cal = l.calibration ?? {};
    const dist = (cal.distortion ?? []).map((d) => ({
      f: num(d["@focal"]),
      m: d["@model"],
      p: d["@model"] === "ptlens" ? [num(d["@a"]) ?? 0, num(d["@b"]) ?? 0, num(d["@c"]) ?? 0] : d["@model"] === "poly5" ? [num(d["@k1"]) ?? 0, num(d["@k2"]) ?? 0, 0] : [num(d["@k1"]) ?? 0, 0, 0],
    }));
    const vig = (cal.vignetting ?? []).filter((v) => v["@model"] === "pa").map((v) => ({ f: num(v["@focal"]), ap: num(v["@aperture"]), d: num(v["@distance"]), k: [num(v["@k1"]) ?? 0, num(v["@k2"]) ?? 0, num(v["@k3"]) ?? 0] }));
    const tca = (cal.tca ?? []).map((t) => ({
      f: num(t["@focal"]),
      m: t["@model"],
      p: t["@model"] === "linear" ? [num(t["@kr"]) ?? 1, num(t["@kb"]) ?? 1] : [num(t["@vr"]) ?? 1, num(t["@vb"]) ?? 1],
    }));
    if (!dist.length && !vig.length && !tca.length) continue;
    lenses.push({
      maker: name(l.maker),
      model: name(l.model),
      mounts: (l.mount ?? []).map(name),
      crop: num(l.cropfactor) ?? 1,
      aspect: l["aspect-ratio"] ? String(l["aspect-ratio"]) : "3:2",
      dist,
      vig,
      tca,
    });
  }
}
const out = { cameras, lenses };
writeFileSync("src-tauri/data/lensfun.json", JSON.stringify(out));
console.log("cameras", cameras.length, "lenses", lenses.length, "bytes", JSON.stringify(out).length);
