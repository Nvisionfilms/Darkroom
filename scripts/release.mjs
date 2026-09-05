// Cut a release: bump the version everywhere, commit, tag, push.
// The GitHub Action then builds the installers and publishes latest.json,
// and installed apps pick the update up on their next launch.
//
//   bun run release 0.2.0
//   bun run release patch|minor|major
import { readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const arg = process.argv[2];
if (!arg) {
  console.error("usage: bun run release <version | patch | minor | major>");
  process.exit(2);
}

const pkgPath = "package.json";
const confPath = "src-tauri/tauri.conf.json";
const cargoPath = "src-tauri/Cargo.toml";

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const current = pkg.version;
let next = arg;
if (["patch", "minor", "major"].includes(arg)) {
  const [ma, mi, pa] = current.split(".").map(Number);
  next = arg === "major" ? `${ma + 1}.0.0` : arg === "minor" ? `${ma}.${mi + 1}.0` : `${ma}.${mi}.${pa + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) {
  console.error(`invalid version ${next}`);
  process.exit(2);
}

const run = (cmd) => {
  console.log("$", cmd);
  execSync(cmd, { stdio: "inherit" });
};

const dirty = execSync("git status --porcelain").toString().trim();
if (dirty) {
  console.error("commit or stash your changes first:\n" + dirty);
  process.exit(1);
}

pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const conf = JSON.parse(readFileSync(confPath, "utf8"));
conf.version = next;
writeFileSync(confPath, JSON.stringify(conf, null, 2) + "\n");

const cargo = readFileSync(cargoPath, "utf8").replace(/^version = "[^"]+"/m, `version = "${next}"`);
writeFileSync(cargoPath, cargo);

run("cargo update -p darkroom --manifest-path src-tauri/Cargo.toml --offline");
run(`git add ${pkgPath} ${confPath} ${cargoPath} src-tauri/Cargo.lock`);
run(`git commit -m "release v${next}"`);
run(`git tag v${next}`);
run("git push");
run(`git push origin v${next}`);
console.log(`\nTagged v${next}. Watch the build at https://github.com/Nvisionfilms/Darkroom/actions`);
