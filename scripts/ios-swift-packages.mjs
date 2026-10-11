// Put the Tauri Swift packages back into the generated Xcode project.
//
// `tauri ios init` (2.11.4 and 2.11.5) writes a project.yml that references the
// Rust static library and Apple's own SDK frameworks, and nothing else - not the
// Tauri Swift package, not the Swift half of any plugin. Those define
// _register_plugin, _on_webview_created, _run_plugin_command and swift-rs's
// _retain_object / _string_from_bytes, so the app fails to link with exactly
// those symbols missing, every time.
//
// Everything needed is already on disk: each crate ships its Package.swift in
// the cargo registry. This finds them from Cargo.lock and adds them to
// project.yml. Run it after every `tauri ios init`, then regenerate:
//
//   bun scripts/ios-swift-packages.mjs
//   (cd src-tauri/gen/apple && xcodegen generate)
//
// It is a workaround for someone else's bug, not a fix, and it is written to say
// so loudly if the generated file ever stops looking the way it does today.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const lockPath = join(root, "src-tauri/Cargo.lock");
const ymlPath = join(root, "src-tauri/gen/apple/project.yml");

for (const [what, p] of [["Cargo.lock", lockPath], ["the generated project.yml", ymlPath]]) {
  if (!existsSync(p)) {
    console.error(`cannot find ${what} at ${p}` + (p === ymlPath ? " - run `bun tauri ios init` first" : ""));
    process.exit(1);
  }
}

/** Every crate version in the lock file, by name. */
const versions = new Map();
for (const block of readFileSync(lockPath, "utf8").split("[[package]]")) {
  const name = /\nname = "([^"]+)"/.exec(block)?.[1];
  const version = /\nversion = "([^"]+)"/.exec(block)?.[1];
  if (name && version) versions.set(name, version);
}

/** Where cargo unpacked the crate sources (the registry hash varies). */
const registries = (() => {
  const base = join(homedir(), ".cargo/registry/src");
  if (!existsSync(base)) return [];
  return readdirSync(base).map((d) => join(base, d));
})();

/** A crate's Swift package: the tauri crate keeps it in mobile/ios-api, plugins in ios/. */
function swiftPackage(crate) {
  const version = versions.get(crate);
  if (!version) return null;
  const sub = crate === "tauri" ? "mobile/ios-api" : "ios";
  for (const reg of registries) {
    const dir = join(reg, `${crate}-${version}`, sub);
    const manifest = join(dir, "Package.swift");
    if (!existsSync(manifest)) continue;
    const name = /\bname:\s*"([^"]+)"/.exec(readFileSync(manifest, "utf8"))?.[1];
    if (name) return { name, path: dir };
  }
  return null;
}

const wanted = ["tauri", ...[...versions.keys()].filter((c) => c.startsWith("tauri-plugin-"))];
const found = wanted.map(swiftPackage).filter(Boolean);
// one entry per package name: two crates cannot both be "Tauri"
const packages = [...new Map(found.map((p) => [p.name, p])).values()];

if (!packages.length) {
  console.error("no Tauri Swift packages found in the cargo registry - is the crate source vendored elsewhere?");
  process.exit(1);
}

let yml = readFileSync(ymlPath, "utf8");
if (/^packages:/m.test(yml)) {
  console.log("project.yml already declares packages; nothing to do");
  process.exit(0);
}

// 1. the package list, at the top level
const block = ["packages:", ...packages.flatMap((p) => [`  ${p.name}:`, `    path: ${p.path}`]), ""].join("\n");
const anchor = /^targets:$/m;
if (!anchor.test(yml)) {
  console.error("project.yml has no top-level `targets:` - the generated layout changed, so this script needs rewriting");
  process.exit(1);
}
yml = yml.replace(anchor, `${block}targets:`);

// 2. depend on them from the iOS target, which is the one that links the app
const deps = /( *)dependencies:\n/;
const m = deps.exec(yml);
if (!m) {
  console.error("project.yml has no `dependencies:` under a target - the generated layout changed");
  process.exit(1);
}
const indent = `${m[1]}  `;
const lines = packages.map((p) => `${indent}- package: ${p.name}`).join("\n");
yml = yml.replace(deps, `${m[0]}${lines}\n`);

writeFileSync(ymlPath, yml);
console.log(`added ${packages.length} Swift packages to project.yml:`);
for (const p of packages) console.log(`  ${p.name}\n    ${p.path}`);
console.log("\nnow regenerate the Xcode project:\n  (cd src-tauri/gen/apple && xcodegen generate)");
