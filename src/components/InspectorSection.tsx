import { useEffect, useRef, type ReactNode } from "react";

type InspectorSectionProps = {
  title: string;
  open: boolean;
  onToggle: () => void;
  shortcut?: string;
  note?: ReactNode;
  children: ReactNode;
};

export function InspectorSection({ title, open, onToggle, shortcut, note, children }: InspectorSectionProps) {
  const sectionRef = useRef<HTMLElement>(null);

  // The left-rail Effects button opens Motion Trails/Watermark in App.tsx. It
  // previously looked like a dead button when the inspector was scrolled above
  // those sections. Keep the rail lightweight but make that navigation visible.
  useEffect(() => {
    if (title !== "Motion Trails") return;
    const effectsButton = document.querySelector(".toolrail button:nth-of-type(4)");
    if (!effectsButton) return;
    const jumpToEffects = () => {
      window.requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };
    effectsButton.addEventListener("click", jumpToEffects);
    return () => effectsButton.removeEventListener("click", jumpToEffects);
  }, [title]);

  return (
    <section ref={sectionRef} className={"inspector-section" + (open ? " open" : "")} data-section={title}>
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
