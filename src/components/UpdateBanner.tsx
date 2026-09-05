import { useEffect, useState } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

/**
 * Checks GitHub Releases for a newer version on startup and offers to install
 * it. Only runs in packaged builds; `tauri dev` has no update endpoint.
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (import.meta.env.DEV) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      check()
        .then((u) => {
          if (!cancelled && u) setUpdate(u);
        })
        .catch(() => {
          /* offline or no release yet: stay quiet */
        });
    }, 3000);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  if (!update || dismissed) return null;

  const install = async () => {
    setError(null);
    setProgress(0);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          done += ev.data.chunkLength;
          if (total > 0) setProgress(Math.min(1, done / total));
        } else if (ev.event === "Finished") setProgress(1);
      });
      await relaunch();
    } catch (e) {
      setError(String(e));
      setProgress(null);
    }
  };

  return (
    <div className="update-banner">
      <span>
        Darkroom {update.version} is available
        {update.body ? `: ${update.body.split("\n")[0]}` : ""}
      </span>
      {progress === null ? (
        <>
          <button className="primary" onClick={install}>
            Install and restart
          </button>
          <button onClick={() => setDismissed(true)}>Later</button>
        </>
      ) : (
        <span className="update-progress">
          <span className="update-bar" style={{ width: `${Math.round(progress * 100)}%` }} />
        </span>
      )}
      {error && <span className="update-error">{error}</span>}
    </div>
  );
}
