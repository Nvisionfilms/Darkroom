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
    const scrollSectionIntoPanel = () => {
      const section = sectionRef.current;
      const panel = section?.closest(".panel") as HTMLElement | null;
      if (!section || !panel) return;

      const panelRect = panel.getBoundingClientRect();
      const sectionRect = section.getBoundingClientRect();
      const top = panel.scrollTop + sectionRect.top - panelRect.top - 8;
      panel.scrollTo({ top: Math.max(0, top), behavior: "smooth" });
    };

    const jump = () => {
      // React may be opening this section from the same rail click. Wait for the
      // state commit/layout before calculating the panel scroll position. The
      // delayed retry also covers sections that were already open, where there
      // is no state change to trigger a second render.
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(scrollSectionIntoPanel);
      });
      window.setTimeout(scrollSectionIntoPanel, 90);
    };

    let buttonIndex: number | null = null;
    if (title === "Tone") buttonIndex = 2; // Develop
    else if (title === "Crop & Straighten") buttonIndex = 3; // Crop
    else if (title === "Motion Trails") buttonIndex = 4; // Effects
    else if (title === "Tethered Capture") buttonIndex = 5; // Tether
    if (buttonIndex === null) return;

    const railButton = document.querySelector(`.toolrail button:nth-of-type(${buttonIndex})`) as HTMLButtonElement | null;
    if (!railButton) return;

    const onRailClick = () => {
      // Develop should return to the normal develop workspace even if the crop
      // workspace is active. App.tsx owns crop state, so use its existing Crop
      // button to exit that mode rather than duplicating state here.
      if (title === "Tone") {
        const cropButton = document.querySelector(".toolrail button:nth-of-type(3)") as HTMLButtonElement | null;
        if (cropButton?.classList.contains("active")) cropButton.click();
      }
      jump();
    };

    railButton.addEventListener("click", onRailClick);
    return () => railButton.removeEventListener("click", onRailClick);
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
