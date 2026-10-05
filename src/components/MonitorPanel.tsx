import type { MonitorInfo } from "../types";

interface Props {
  /** null when the server is off */
  info: MonitorInfo | null;
  onToggle: () => void;
}

/** Phone monitor: a QR code that opens the live page served by the app. */
export function MonitorPanel({ info, onToggle }: Props) {
  const active = !!info?.active;
  const qr = info?.qrSvg ? `data:image/svg+xml;utf8,${encodeURIComponent(info.qrSvg)}` : "";
  const viewers = info?.viewers ?? 0;
  return (
    <div className="monitor-panel">
      <div className="tether-row">
        <button className={active ? "primary" : ""} onClick={onToggle}>
          {active ? "Stop sharing" : "Start phone monitor"}
        </button>
        <span className={"tether-state" + (active ? " on" : "")}>
          {active ? `${viewers} phone${viewers === 1 ? "" : "s"} watching` : "Off"}
        </span>
      </div>
      {active && info && (
        <div className="monitor-qr">
          <img src={qr} alt="QR code for the monitor page" />
          <div className="monitor-url">
            <span>Scan with the phone camera, or type</span>
            <code>{info.url}</code>
            <span>Double-tap the picture on the phone for 1:1.</span>
          </div>
        </div>
      )}
      <div className="hint">
        The phone must be on the same Wi‑Fi as this computer; a phone hotspot works too. If Windows asks to let NFrame Studio
        through the firewall, allow it on private networks. The page shows the developed image and follows your edits.
      </div>
    </div>
  );
}
