// Put the Tauri Swift packages back into the generated Xcode project.
//
// `tauri ios init` (2.11.4 and 2.11.5) writes a project.yml that references the
// Rust static library and Apple's own SDK frameworks, and nothing else - not the
// Tauri Swift package, not the Swift half of any plugin. Those define
// _register_plugin, _on_webview_created, _run_plugin_command and swift-rs's
// _retain_object / _string_from_bytes, so the app fails to link with exactly
// those symbols missing, every time.
//
// Everything needed is already on disk, in the cargo registry. It cannot be
// pointed at where it lies, though: SwiftPM takes a local package's identity
// from its DIRECTORY NAME. The tauri one would be "ios-api", every plugin would
// be "ios" and collide with the others, and each plugin asks for Tauri at
// "../.tauri/tauri-api" - so the name has to be right or nothing resolves.
//
// They are copied into gen/apple in the layout they expect:
//
//   .tauri/tauri-api        Tauri, under the name the plugins look it up by
//   tauri-plugin-dialog     each plugin, under its own crate name
//   tauri-plugin-opener
//
// Run after every `tauri ios init`, which overwrites project.yml:
//
//   bun scripts/ios-swift-packages.mjs
//   (cd src-tauri/gen/apple && xcodegen generate)
//
// This is a workaround for someone else's bug, not a fix, and it is written to
// say so loudly if the generated file stops looking the way it does today.

import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const lockPath = join(root, "src-tauri/Cargo.lock");
const appleDir = join(root, "src-tauri/gen/apple");
const ymlPath = join(appleDir, "project.yml");

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

/** Where cargo unpacked the crate sources; the registry hash varies. */
const registries = (() => {
  const base = join(homedir(), ".cargo/registry/src");
  return existsSync(base) ? readdirSync(base).map((d) => join(base, d)) : [];
})();

/** A crate's Swift package: tauri keeps its in mobile/ios-api, plugins in ios/. */
function swiftPackage(crate) {
  const version = versions.get(crate);
  if (!version) return null;
  const sub = crate === "tauri" ? "mobile/ios-api" : "ios";
  for (const reg of registries) {
    const from = join(reg, `${crate}-${version}`, sub);
    if (!existsSync(join(from, "Package.swift"))) continue;
    const name = /\bname:\s*"([^"]+)"/.exec(readFileSync(join(from, "Package.swift"), "utf8"))?.[1];
    // dir is where it has to end up: the directory name IS the SwiftPM identity
    if (name) return { name, from, dir: crate === "tauri" ? ".tauri/tauri-api" : crate };
  }
  return null;
}

const crates = ["tauri", ...[...versions.keys()].filter((c) => c.startsWith("tauri-plugin-"))];
const found = crates.map(swiftPackage).filter(Boolean);
// one entry per package name: two crates cannot both be "Tauri"
const packages = [...new Map(found.map((p) => [p.name, p])).values()];

if (!packages.length) {
  console.error("no Tauri Swift packages found in the cargo registry - is the crate source vendored elsewhere?");
  process.exit(1);
}

// Copied rather than symlinked: SwiftPM resolves a symlink to its real path,
// which would put a plugin back in the registry, where "../.tauri/tauri-api"
// does not exist.
for (const p of packages) {
  const dest = join(appleDir, p.dir);
  rmSync(dest, { recursive: true, force: true });
  cpSync(p.from, dest, { recursive: true, dereference: true });
}

let yml = readFileSync(ymlPath, "utf8").replace(/\r\n/g, "\n");
if (/^packages:/m.test(yml)) {
  console.log("project.yml already declares packages; only the copies were refreshed");
  process.exit(0);
}

// 1. the package list, at the top level; paths are relative to project.yml
const block = ["packages:", ...packages.flatMap((p) => [`  ${p.name}:`, `    path: ${p.dir}`]), ""].join("\n");
if (!/^targets:$/m.test(yml)) {
  console.error("project.yml has no top-level `targets:` - the generated layout changed, so this script needs rewriting");
  process.exit(1);
}
yml = yml.replace(/^targets:$/m, `${block}targets:`);

// 2. depend on them from the iOS target, the one that links the app
const deps = /( *)dependencies:\n/;
const m = deps.exec(yml);
if (!m) {
  console.error("project.yml has no `dependencies:` under a target - the generated layout changed");
  process.exit(1);
}
const lines = packages.map((p) => `${m[1]}  - package: ${p.name}`).join("\n");
yml = yml.replace(deps, `${m[0]}${lines}\n`);

writeFileSync(ymlPath, yml);
console.log(`staged ${packages.length} Swift packages and added them to project.yml:`);
for (const p of packages) console.log(`  ${p.name.padEnd(20)} gen/apple/${p.dir}`);
console.log("\nnow regenerate the Xcode project:\n  (cd src-tauri/gen/apple && xcodegen generate)");
