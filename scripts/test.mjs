// One command for all of Darkroom's tests.
//
//   bun run test                       pipeline checks + unit tests + type check
//   bun run test -- --app <photo>      also builds and launches the app and runs
//                                      the UI smoke test on a copy of <photo>
//
// The pipeline checks run on synthetic images, so they need no files and run
// in CI too. The app smoke test drives the real window through the webview's
// debugging port, which is only available on Windows (WebView2).

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const args = process.argv.slice(2);
const appIdx = args.indexOf("--app");
const photo = appIdx >= 0 ? args[appIdx + 1] : null;
const isWin = process.platform === "win32";
const results = [];

const run = (name, cmd, cmdArgs, opts = {}) => {
  console.log(`\n=== ${name} ===`);
  const t0 = Date.now();
  const r = spawnSync(cmd, cmdArgs, { cwd: root, stdio: "inherit", shell: isWin, ...opts });
  const ok = r.status === 0;
  results.push({ name, ok, s: ((Date.now() - t0) / 1000).toFixed(1) });
  return ok;
};

run("Rust: pipeline checks and unit tests", "cargo", ["test", "--lib", "--manifest-path", "src-tauri/Cargo.toml"]);
run("TypeScript: type check", "bunx", ["tsc", "--noEmit", "-p", "tsconfig.json"]);
run("Twin constants: CPU pipeline vs shaders", "node", ["scripts/twins.mjs"]);

const reachable = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
};

if (photo) {
  if (!isWin) {
    console.log("\n=== App smoke test ===\nskipped: the webview debugging port is only available on Windows");
    results.push({ name: "App smoke test", ok: true, s: "skipped" });
  } else if (!existsSync(photo)) {
    console.log(`\n=== App smoke test ===\nphoto not found: ${photo}`);
    results.push({ name: "App smoke test", ok: false, s: "-" });
  } else if (run("Rust: build the debug app", "cargo", ["build", "--manifest-path", "src-tauri/Cargo.toml"])) {
    console.log("\n=== App smoke test ===");
    const started = [];
    try {
      if (!(await reachable("http://localhost:1420/"))) {
        const vite = spawn("bunx", ["vite"], { cwd: root, shell: true, stdio: "ignore" });
        started.push(vite);
        if (!(await until(() => reachable("http://localhost:1420/"), 60000))) throw new Error("the dev server did not start");
      }
      const profile = mkdtempSync(join(tmpdir(), "darkroom-webview-"));
      const app = spawn(join(root, "src-tauri", "target", "debug", "darkroom.exe"), [], {
        cwd: root,
        stdio: "ignore",
        env: {
          ...process.env,
          WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: "--remote-debugging-port=9222",
          WEBVIEW2_USER_DATA_FOLDER: profile,
        },
      });
      started.push(app);
      if (!(await until(() => reachable("http://127.0.0.1:9222/json"), 60000))) throw new Error("the app did not open its debugging port");
      await until(async () => {
        try {
          const pages = await (await fetch("http://127.0.0.1:9222/json")).json();
          return pages.some((p) => p.type === "page" && p.url.includes("localhost:1420"));
        } catch {
          return false;
        }
      }, 30000);
      await new Promise((r) => setTimeout(r, 4000));
      run("App smoke test", "node", ["scripts/smoke.mjs", photo], { shell: false });
    } catch (e) {
      console.log(`app smoke test could not run: ${e.message}`);
      results.push({ name: "App smoke test", ok: false, s: "-" });
    } finally {
      for (const p of started.reverse()) {
        if (isWin) spawnSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
        else p.kill();
      }
    }
  } else {
    results.push({ name: "App smoke test", ok: false, s: "-" });
  }
}

console.log("\n=== Summary ===");
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}  (${r.s}${r.s === "skipped" || r.s === "-" ? "" : " s"})`);
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
