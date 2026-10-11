import { useCallback, useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { mobileUpdate } from "./api";

interface MobileRelease {
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

/**
 * The release a phone could install.
 *
 * The Tauri updater cannot replace a phone app in place, so the phone reads a
 * small manifest instead and opens the link it names. On Android that is an APK
 * the browser downloads and the package installer opens; on iOS it is an
 * `itms-services:` link, because an iPhone will not install a file a browser
 * downloaded. Rust picks the manifest for the platform it was built for.
 *
 * The manifest is read by Rust rather than fetched from here. The webview is
 * served from tauri.localhost, so a fetch to the update domain is cross-origin,
 * and the browser refuses it before it reaches the network - which is exactly
 * what "Update check failed: TypeError: Failed to fetch" was.
 */
async function mobileRelease(): Promise<MobileRelease | null> {
  const j = (await mobileUpdate()) as Partial<MobileRelease> | null;
  if (!j || typeof j.version !== "string" || typeof j.url !== "string") return null;
  return { version: j.version, url: j.url, notes: typeof j.notes === "string" ? j.notes : undefined };
}

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest"; version: string }
  | { kind: "available"; update: Update }
  /** a phone: a newer build exists, which the phone's own installer has to put on */
  | { kind: "manual"; version: string; url: string; notes?: string }
  | { kind: "installing"; progress: number | null }
  | { kind: "error"; message: string };

/**
 * Shared update state: checks GitHub Releases (the updater endpoint in
 * tauri.conf.json), downloads the signed bundle and relaunches.
 */
/**
 * `enabled` is false where the Tauri updater cannot run - on a phone. A phone is
 * still told about a new version; it just hands the install to the platform
 * instead of replacing itself.
 */
export function useUpdater(currentVersion: string, enabled = true, os = "") {
  const mobile = !enabled && (os === "android" || os === "ios");
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);
  // install() reads the status it was given rather than closing over a stale one
  const statusRef = useRef<UpdateStatus>({ kind: "idle" });
  statusRef.current = status;

  const checkNow = useCallback(async () => {
    setStatus({ kind: "checking" });
    if (mobile) {
      try {
        const r = await mobileRelease();
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
    if (mobile) {
      // Android: the browser downloads the APK and the package installer opens
      // it. iOS: the link is itms-services:, which Apple's installer answers.
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
  }, [mobile]);

  const dismiss = useCallback(() => setStatus({ kind: "idle" }), []);

  // automatic check a few seconds after launch (packaged builds only)
  useEffect(() => {
    if (import.meta.env.DEV) return;
    if (mobile) {
      const t = window.setTimeout(() => {
        mobileRelease()
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
  }, [enabled, mobile, currentVersion]);

  return { status, checkNow, install, dismiss };
}
