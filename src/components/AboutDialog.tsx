import type { UpdateStatus } from "../updater";

interface Props {
  version: string;
  status: UpdateStatus;
  onCheck: () => void;
  onInstall: () => void;
  onClose: () => void;
}

const REPO = "https://github.com/Nvisionfilms/Darkroom";

export function AboutDialog({ version, status, onCheck, onInstall, onClose }: Props) {
  const busy = status.kind === "checking" || status.kind === "installing";
  let line: string;
  switch (status.kind) {
    case "checking":
      line = "Checking GitHub for a newer version…";
      break;
    case "latest":
      line = `You're on the latest version (${status.version}).`;
      break;
    case "available":
      line = `Version ${status.update.version} is available.`;
      break;
    case "installing":
      line = status.progress === null ? "Downloading…" : `Downloading… ${Math.round(status.progress * 100)}%`;
      break;
    case "error":
      line = `Update check failed: ${status.message}`;
      break;
    default:
      line = "Updates are downloaded from the GitHub releases page.";
  }
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal about" onClick={(e) => e.stopPropagation()}>
        <h2>Darkroom</h2>
        <div className="about-version">Version {version}</div>
        <div className="about-line">{line}</div>
        {status.kind === "installing" && (
          <span className="update-progress about-progress">
            <span className="update-bar" style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
          </span>
        )}
        <div className="about-repo" title={REPO}>
          {REPO}
        </div>
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
          {status.kind === "available" ? (
            <button className="primary" onClick={onInstall}>
              Install {status.update.version} and restart
            </button>
          ) : (
            <button className="primary" onClick={onCheck} disabled={busy}>
              Check for updates
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
