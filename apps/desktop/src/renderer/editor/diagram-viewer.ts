const MIN = 0.1;
const MAX = 8;

function button(label: string, title: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "diagram-viewer__btn";
  b.textContent = label;
  b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

/**
 * Shows a rendered diagram full-window. Zoom with the buttons, ⌘/Ctrl-scroll or a
 * trackpad pinch (keeping the point under the pointer still); pan by dragging or
 * scrolling; Esc or the backdrop closes it. The SVG stays vector at every size.
 */
export function openDiagramViewer(svgMarkup: string): void {
  const overlay = document.createElement("div");
  overlay.className = "diagram-viewer";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Diagram");

  const stage = document.createElement("div");
  stage.className = "diagram-viewer__stage";
  const canvas = document.createElement("div");
  canvas.className = "diagram-viewer__canvas";
  canvas.innerHTML = svgMarkup;
  const svg = canvas.querySelector("svg");
  if (!svg) return;
  stage.append(canvas);

  const box = svg.viewBox.baseVal;
  const natural = box && box.width ? { w: box.width, h: box.height } : { w: svg.clientWidth || 800, h: svg.clientHeight || 600 };
  svg.removeAttribute("width");
  svg.removeAttribute("height");
  svg.style.maxWidth = "none";

  const level = document.createElement("span");
  level.className = "diagram-viewer__level";
  let scale = 1;

  const apply = () => {
    svg.style.width = `${natural.w * scale}px`;
    svg.style.height = `${natural.h * scale}px`;
    level.textContent = `${Math.round(scale * 100)}%`;
  };
  /** The diagram's top-left in the stage's scrollable content. */
  const origin = () => {
    const s = stage.getBoundingClientRect();
    const g = svg.getBoundingClientRect();
    return { x: g.left - s.left + stage.scrollLeft, y: g.top - s.top + stage.scrollTop };
  };
  /** Zooms about a point in the stage (defaults to its centre). */
  const zoomTo = (next: number, at?: { x: number; y: number }) => {
    next = Math.min(MAX, Math.max(MIN, next));
    const rect = stage.getBoundingClientRect();
    const px = at ? at.x - rect.left : rect.width / 2;
    const py = at ? at.y - rect.top : rect.height / 2;
    const o = origin();
    const before = { x: (stage.scrollLeft + px - o.x) / scale, y: (stage.scrollTop + py - o.y) / scale };
    scale = next;
    apply();
    const n = origin();
    stage.scrollLeft = before.x * scale + n.x - px;
    stage.scrollTop = before.y * scale + n.y - py;
  };
  const fit = () => {
    const pad = 48;
    // Small diagrams grow to fill the window, but no more than 2×.
    scale = Math.min(2, Math.max(MIN, Math.min((stage.clientWidth - pad) / natural.w, (stage.clientHeight - pad) / natural.h)));
    apply();
    stage.scrollTo(0, 0);
  };

  const close = () => {
    overlay.remove();
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
    else if (e.key === "+" || e.key === "=") zoomTo(scale * 1.25);
    else if (e.key === "-") zoomTo(scale / 1.25);
    else if (e.key === "0") fit();
    else if (e.key === "1") zoomTo(1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  const bar = document.createElement("div");
  bar.className = "diagram-viewer__bar";
  bar.append(
    button("−", "Zoom out (−)", () => zoomTo(scale / 1.25)),
    level,
    button("+", "Zoom in (+)", () => zoomTo(scale * 1.25)),
    button("Fit", "Fit to window (0)", fit),
    button("100%", "Actual size (1)", () => zoomTo(1)),
    button("✕", "Close (Esc)", close),
  );

  stage.addEventListener(
    "wheel",
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return; // plain scroll pans
      e.preventDefault();
      // Pinch deltas are small and smooth; a mouse-wheel notch (~100) is capped at ~1.65×.
      const delta = Math.max(-100, Math.min(100, e.deltaY));
      zoomTo(scale * Math.exp(-delta * 0.005), { x: e.clientX, y: e.clientY });
    },
    { passive: false },
  );
  let drag: { x: number; y: number; left: number; top: number; moved: boolean } | null = null;
  stage.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    drag = { x: e.clientX, y: e.clientY, left: stage.scrollLeft, top: stage.scrollTop, moved: false };
    stage.setPointerCapture(e.pointerId);
  });
  stage.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    const dy = e.clientY - drag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
    stage.scrollLeft = drag.left - dx;
    stage.scrollTop = drag.top - dy;
    stage.classList.toggle("is-panning", drag.moved);
  });
  stage.addEventListener("pointerup", (e) => {
    // A click (not a drag) on the empty backdrop closes the viewer.
    if (drag && !drag.moved && !svg.contains(e.target as globalThis.Node)) close();
    drag = null;
    stage.classList.remove("is-panning");
  });

  overlay.append(stage, bar);
  document.body.append(overlay);
  document.addEventListener("keydown", onKey, true);
  fit();
}
