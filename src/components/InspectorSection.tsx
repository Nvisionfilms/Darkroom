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

  useEffect(() => {
    const jump = () => {
      window.requestAnimationFrame(() => {
        sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
    };

    // Make the left rail behave like real workspace navigation instead of a
    // decorative button. Develop returns to the Tone section and exits Crop if
    // crop mode is active. Effects jumps directly to Motion Trails.
    if (title === "Tone") {
      const developButton = document.querySelector(".toolrail button:nth-of-type(2)");
      if (!developButton) return;
      const onDevelop = () => {
        const cropButton = document.querySelector(".toolrail button:nth-of-type(3)") as HTMLButtonElement | null;
        if (cropButton?.classList.contains("active")) cropButton.click();
        jump();
      };
      developButton.addEventListener("click", onDevelop);
      return () => developButton.removeEventListener("click", onDevelop);
    }

    if (title === "Motion Trails") {
      const effectsButton = document.querySelector(".toolrail button:nth-of-type(4)");
      if (!effectsButton) return;
      effectsButton.addEventListener("click", jump);
      return () => effectsButton.removeEventListener("click", jump);
    }
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
