import type { TetherStatus } from "../types";

interface Props {
  status: TetherStatus;
  folder: string;
  autoOpen: boolean;
  onChooseFolder: () => void;
  onToggle: () => void;
  onAutoOpen: (v: boolean) => void;
}

/**
 * Tethered capture: Darkroom watches the folder the camera software saves
 * into and opens each shot as it lands. Works for USB and Wi‑Fi alike because
 * the vendor app (or the camera's FTP push) does the transfer.
 */
export function TetherPanel({ status, folder, autoOpen, onChooseFolder, onToggle, onAutoOpen }: Props) {
  const shots = status.count === 1 ? "1 shot" : `${status.count} shots`;
  return (
    <div className="tether-panel">
      <div className="tether-folder">
        <span className="tether-folder-path" title={folder || undefined}>
          {folder || "No capture folder chosen"}
        </span>
        <button onClick={onChooseFolder} disabled={status.active}>
          Choose…
        </button>
      </div>
      <div className="tether-row">
        <button className={status.active ? "primary" : ""} onClick={onToggle} disabled={!folder && !status.active}>
          {status.active ? "Stop watching" : "Start watching"}
        </button>
        <span className={"tether-state" + (status.active ? " on" : "")}>{status.active ? `Live · ${shots}` : "Off"}</span>
      </div>
      <label className="feature-toggle">
        <span>
          <strong>Open each new shot</strong>
          <small>Off: new shots only queue in the filmstrip.</small>
        </span>
        <input type="checkbox" checked={autoOpen} onChange={(e) => onAutoOpen(e.target.checked)} />
      </label>
      <details className="tether-help">
        <summary>Camera setup</summary>
        <p>
          <strong>Canon, USB or Wi‑Fi:</strong> open EOS Utility → Remote Shooting. In Preferences → Destination Folder,
          pick the folder above and turn off “Create subfolder”.
        </p>
        <p>
          <strong>Sony, USB or Wi‑Fi:</strong> open Imaging Edge Desktop → Remote and set its save folder to the folder
          above. Bodies with FTP transfer (FX3, A7 series) can also push straight into it.
        </p>
        <p>Anything that drops files into the folder works the same way, including a card reader.</p>
      </details>
    </div>
  );
}
