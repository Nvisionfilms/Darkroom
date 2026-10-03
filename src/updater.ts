import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/**
 * Where Android looks for its own release. The Tauri updater cannot install an
 * APK - only Android's own package installer may - so the phone checks this
 * small manifest instead and hands the download to the browser, which puts the
 * installer in front of you the way any sideloaded app does.
 */
const ANDROID_MANIFEST = "https://updates.nvisionfilms.com/darkroom/assets/android.json";

interface AndroidRelease {
  version: string;
  url: string;
  notes?: string;
}

/**
 * Is `a` a later version than `b`? Plain numeric dot-separated compare, which
 * is all our versions ever are; anything unparseable counts as 0 so a malformed
 * manifest can never nag.
 */
export function isNewer(a: string, b: string): boolean {
  const part = (v: string) => v.trim().replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const x = part(a);
  const y = part(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

async function androidRelease(): Promise<AndroidRelease | null> {
  const res = await fetch(ANDROID_MANIFEST, { cache: "no-store" });
  if (!res.ok) throw new Error(`update manifest: ${res.status}`);
  const j = (await res.json()) as Partial<AndroidRelease>;
  if (!j || typeof j.version !== "string" || typeof j.url !== "string") return null;
  return { version: j.version, url: j.url, notes: typeof j.notes === "string" ? j.notes : undefined };
}

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest"; version: string }
  | { kind: "available"; update: Update }
  /** Android: a newer APK exists, which the browser has to download and install */
  | { kind: "manual"; version: string; url: string; notes?: string }
  | { kind: "installing"; progress: number | null }
  | { kind: "error"; message: string };

/**
 * Shared update state: checks GitHub Releases (the updater endpoint in
 * tauri.conf.json), downloads the signed bundle and relaunches.
 */
/**
 * `enabled` is false where the Tauri updater cannot run - on a phone. Android
 * still gets told about a new version; it just downloads the APK through the
 * browser instead of replacing itself.
 */
export function useUpdater(currentVersion: string, enabled = true, os = "") {
  const android = !enabled && os === "android";
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);
  // install() reads the status it was given rather than closing over a stale one
  const statusRef = useRef<UpdateStatus>({ kind: "idle" });
  statusRef.current = status;

  const checkNow = useCallback(async () => {
    setStatus({ kind: "checking" });
    if (android) {
      try {
        const r = await androidRelease();
        if (r && isNewer(r.version, currentVersion)) setStatus({ kind: "manual", ...r });
        else setStatus({ kind: "latest", version: currentVersion });
      } catch (e) {
        setStatus({ kind: "error", message: String(e) });
      }
      return;
    }
    try {
      const u = await check({ timeout: 15000 });
      if (u) {
        updateRef.current = u;
        setStatus({ kind: "available", update: u });
      } else {
        setStatus({ kind: "latest", version: currentVersion });
      }
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, [currentVersion]);

  const install = useCallback(async () => {
    if (android) {
      // the browser downloads it and Android's installer takes it from there
      const s = statusRef.current;
      if (s.kind === "manual") await openUrl(s.url).catch((e) => setStatus({ kind: "error", message: String(e) }));
      return;
    }
    const u = updateRef.current;
    if (!u) return;
    setStatus({ kind: "installing", progress: null });
    let total = 0;
    let done = 0;
    try {
      await u.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          setStatus({ kind: "installing", progress: total > 0 ? Math.min(1, done / total) : null });
        } else if (ev.event === "Finished") setStatus({ kind: "installing", progress: 1 });
      });
      await relaunch();
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  }, [android]);

  const dismiss = useCallback(() => setStatus({ kind: "idle" }), []);

  // automatic check a few seconds after launch (packaged builds only)
  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (android) {
      const t = window.setTimeout(() => {
        androidRelease()
          .then((r) => {
            if (r && isNewer(r.version, currentVersion)) setStatus({ kind: "manual", ...r });
          })
          .catch(() => {});
      }, 3000);
      return () => window.clearTimeout(t);
    }
    if (!enabled) return;
    const t = window.setTimeout(() => {
      check({ timeout: 15000 })
        .then((u) => {
          if (u) {
            updateRef.current = u;
            setStatus({ kind: "available", update: u });
          }
        })
        .catch(() => {});
    }, 3000);
    return () => window.clearTimeout(t);
  }, [enabled, android, currentVersion]);

  return { status, checkNow, install, dismiss };
}
