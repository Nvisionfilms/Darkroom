import type { UpdateStatus } from "../updater";

interface Props {
  version: string;
  status: UpdateStatus;
  /** false on phones: they are updated by whatever installed them */
  canUpdate: boolean;
  os: string;
  /** the folder the Open Photos dialog starts in, or "" for the last one used */
  photoFolder: string;
  /** the library folder each import is copied into, a session folder at a time; "" = off */
  libraryFolder: string;
  onPickLibraryFolder: () => void;
  onClearLibraryFolder: () => void;
  onPickPhotoFolder: () => void;
  onClearPhotoFolder: () => void;
  onCheck: () => void;
  onInstall: () => void;
  onClose: () => void;
}

const UPDATE_CHANNEL = "updates.nvisionfilms.com";

export function AboutDialog({
  version,
  status,
  canUpdate,
  os,
  photoFolder,
  libraryFolder,
  onPickLibraryFolder,
  onClearLibraryFolder,
  onPickPhotoFolder,
  onClearPhotoFolder,
  onCheck,
  onInstall,
  onClose,
}: Props) {
  // Android checks and downloads; only the install is Android's own business
  const android = !canUpdate && os === "android";
  const shows = canUpdate || android;
  const busy = shows && (status.kind === "checking" || status.kind === "installing");
  let line: string;
  switch (status.kind) {
    case "checking":
      line = "Checking for a newer version…";
      break;
    case "latest":
      line = `You're on the latest version (${status.version}).`;
      break;
    case "available":
      line = `Version ${status.update.version} is available.`;
      break;
    case "manual":
      line = `Version ${status.version} is available. Downloading it opens Android's installer.`;
      break;
    case "installing":
      line = status.progress === null ? "Downloading…" : `Downloading… ${Math.round(status.progress * 100)}%`;
      break;
    case "error":
      line = `Update check failed: ${status.message}`;
      break;
    default:
      line = android
        ? "NFrame Studio checks the update channel and hands the download to your browser; Android installs it."
        : "Updates are delivered through the secure NFrame Studio update channel.";
  }
  return (
    <div className="modal-backdrop" onClick={busy ? undefined : onClose}>
      <div className="modal about" onClick={(e) => e.stopPropagation()}>
        <h2>NFrame Studio</h2>
        <div className="about-version">Photo editing &amp; creative effects · by NVision</div>
        <div className="about-version">Version {version}</div>
        <div className="about-line">
          {shows
            ? line
            : os === "ios"
              ? "Updates arrive through TestFlight, or by installing again from the Mac."
              : "Updates arrive however you installed the app; it cannot update itself."}
        </div>
        {shows && status.kind === "installing" && (
          <span className="update-progress about-progress">
            <span className="update-bar" style={{ width: `${Math.round((status.progress ?? 0) * 100)}%` }} />
          </span>
        )}
        <div className="setting-row">
          <div className="setting-label">
            <strong>Photos folder</strong>
            <small>Where Open Photos starts. Leave it unset to use the last folder you opened.</small>
          </div>
          <div className="setting-value" title={photoFolder || undefined}>
            {photoFolder || <em>not set</em>}
          </div>
          <div className="setting-actions">
            <button onClick={onPickPhotoFolder}>Choose…</button>
            {photoFolder && (
              <button className="tab" onClick={onClearPhotoFolder}>
                Clear
              </button>
            )}
          </div>
        </div>

        {os !== "android" && os !== "ios" && (
          <div className="setting-row">
            <div className="setting-label">
              <strong>Library folder</strong>
              <small>
                Every Open Photos import is copied into a new session folder here, edits and all. Leave it unset to
                open photos where they are.
              </small>
            </div>
            <div className="setting-value" title={libraryFolder || undefined}>
              {libraryFolder || <em>not set</em>}
            </div>
            <div className="setting-actions">
              <button onClick={onPickLibraryFolder}>Choose…</button>
              {libraryFolder && (
                <button className="tab" onClick={onClearLibraryFolder}>
                  Clear
                </button>
              )}
            </div>
          </div>
        )}

        {shows && (
          <div className="about-repo" title="NFrame Studio update channel">
            {UPDATE_CHANNEL}
          </div>
        )}
        <div className="modal-actions">
          <button onClick={onClose} disabled={busy}>
            Close
          </button>
          {shows &&
            (status.kind === "available" ? (
              <button className="primary" onClick={onInstall}>
                Install {status.update.version} and restart
              </button>
            ) : status.kind === "manual" ? (
              <button className="primary" onClick={onInstall}>
                Download {status.version}
              </button>
            ) : (
              <button className="primary" onClick={onCheck} disabled={busy}>
                Check for updates
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
