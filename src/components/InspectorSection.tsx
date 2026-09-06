import type { ReactNode } from "react";

type InspectorSectionProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  shortcut?: string;
  note?: ReactNode;
  children: ReactNode;
};

export function InspectorSection({ title, open, onToggle, shortcut, note, children }: InspectorSectionProps) {
  return (
    <section className={"inspector-section" + (open ? " open" : "")}>
      <button className="inspector-section-head" type="button" onClick={onToggle} aria-expanded={open}>
        <span className="inspector-section-title">{title}</span>
        <span className="inspector-section-meta">
          {note}
          {shortcut && <kbd>{shortcut}</kbd>}
          <span className="inspector-chevron" aria-hidden="true">
            {open ? "⌄" : "›"}
          </span>
        </span>
      </button>
      {open && <div className="inspector-section-body">{children}</div>}
    </section>
  );
}
