import { useCallback, useEffect, useRef, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest"; version: string }
  | { kind: "available"; update: Update }
  | { kind: "installing"; progress: number | null }
  | { kind: "error"; message: string };

/**
 * Shared update state: checks GitHub Releases (the updater endpoint in
 * tauri.conf.json), downloads the signed bundle and relaunches.
 */
/** `enabled` is false on phones, which cannot update themselves. */
export function useUpdater(currentVersion: string, enabled = true) {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });
  const updateRef = useRef<Update | null>(null);

  const checkNow = useCallback(async () => {
    setStatus({ kind: "checking" });
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
  }, []);

  const dismiss = useCallback(() => setStatus({ kind: "idle" }), []);

  // automatic check a few seconds after launch (packaged builds only)
  useEffect(() => {
    if (import.meta.env.DEV || !enabled) return;
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
  }, [enabled]);

  return { status, checkNow, install, dismiss };
}
