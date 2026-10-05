import type { UpdateStatus } from "../updater";

interface Props {
  status: UpdateStatus;
  onInstall: () => void;
  onDismiss: () => void;
}

/** Slim banner shown when the automatic launch-time check finds a newer version. */
export function UpdateBanner({ status, onInstall, onDismiss }: Props) {
  if (status.kind === "available") {
    const u = status.update;
    return (
      <div className="update-banner">
        <span>
          NFrame Studio {u.version} is available{u.body ? `: ${u.body.split("\n")[0]}` : ""}
        </span>
        <button className="primary" onClick={onInstall}>
          Install and restart
        </button>
        <button onClick={onDismiss}>Later</button>
      </div>
    );
  }
  if (status.kind === "manual") {
    return (
      <div className="update-banner">
        <span>
          NFrame Studio {status.version} is available{status.notes ? `: ${status.notes.split("\n")[0]}` : ""}
        </span>
        <button className="primary" onClick={onInstall}>
          Download
        </button>
        <button onClick={onDismiss}>Later</button>
      </div>
    );
  }
  if (status.kind === "installing") {
    return (
      <div className="update-banner">
        <span>Downloading update…</span>
        <span className="update-progress">
          <span className="update-bar" style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
        </span>
      </div>
    );
  }
  return null;
}
