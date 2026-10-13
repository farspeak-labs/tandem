import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

/** Where a floating panel opens: under a trigger's rect, or at a pointer position. */
export interface Anchor {
  x: number;
  y: number;
  /** Bottom of the trigger; the panel flips above `top` when it would overflow. */
  top?: number;
  /** Right-align to x (for ⋯ buttons on the right edge). */
  alignRight?: boolean;
}

export function anchorFromElement(el: Element, alignRight = true): Anchor {
  const r = el.getBoundingClientRect();
  return { x: alignRight ? r.right : r.left, y: r.bottom + 4, top: r.top - 4, alignRight };
}

export function anchorFromEvent(e: { clientX: number; clientY: number }): Anchor {
  return { x: e.clientX, y: e.clientY };
}

/**
 * A popover at fixed viewport coordinates (so it escapes scrolling lists),
 * kept on screen; closes on outside mousedown or Escape.
 */
export function Floating(p: { anchor: Anchor; onClose(): void; className?: string; label?: string; role?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const onClose = useRef(p.onClose);
  onClose.current = p.onClose;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = p.anchor.alignRight ? p.anchor.x - w : p.anchor.x;
    let top = p.anchor.y;
    if (top + h > vh - 8) top = p.anchor.top !== undefined ? p.anchor.top - h : vh - h - 8;
    left = Math.max(8, Math.min(left, vw - w - 8));
    top = Math.max(8, top);
    setPos({ left, top });
  }, [p.anchor, p.children]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose.current();
      }
    };
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={`popover floating ${p.className ?? ""}`}
      role={p.role}
      aria-label={p.label}
      style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {p.children}
    </div>
  );
}

/** A small "name it" prompt (smart folder, new folder). */
export function PromptPanel(p: {
  anchor: Anchor;
  title: string;
  placeholder?: string;
  initial?: string;
  hint?: ReactNode;
  confirmLabel: string;
  onSubmit(value: string): Promise<void> | void;
  onClose(): void;
}) {
  const [value, setValue] = useState(p.initial ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!value.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await p.onSubmit(value.trim());
      p.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  };
  return (
    <Floating anchor={p.anchor} onClose={p.onClose} className="lib-prompt" role="dialog" label={p.title}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="lib-prompt__title">{p.title}</div>
        <input
          className="field"
          autoFocus
          value={value}
          placeholder={p.placeholder}
          onChange={(e) => setValue(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
        />
        {p.hint && <div className="lib-prompt__hint">{p.hint}</div>}
        {error && <div className="error-text">{error}</div>}
        <div className="finish__actions">
          <button type="button" className="text-button" onClick={p.onClose}>
            Cancel
          </button>
          <button type="submit" className="primary-button small" disabled={busy || !value.trim()}>
            {p.confirmLabel}
          </button>
        </div>
      </form>
    </Floating>
  );
}

/** A destructive-action confirmation. */
export function ConfirmPanel(p: { anchor: Anchor; message: ReactNode; confirmLabel: string; onConfirm(): Promise<void> | void; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      await p.onConfirm();
      p.onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setBusy(false);
    }
  };
  return (
    <Floating anchor={p.anchor} onClose={p.onClose} className="lib-prompt" role="alertdialog">
      <p className="lib-prompt__message">{p.message}</p>
      {error && <div className="error-text">{error}</div>}
      <div className="finish__actions">
        <button className="text-button" onClick={p.onClose}>
          Cancel
        </button>
        <button className="primary-button small is-danger" autoFocus disabled={busy} onClick={go}>
          {p.confirmLabel}
        </button>
      </div>
    </Floating>
  );
}

/** Menu items in a floating panel (same look as the header ⋯ menu). */
export type MenuItem = { label: string; onSelect(): void; disabled?: boolean; checked?: boolean; danger?: boolean } | { separator: true };

export function MenuItems({ items, onDone }: { items: MenuItem[]; onDone?(): void }) {
  return (
    <div className="menu__list lib-menu" role="menu">
      {items.map((item, i) =>
        "separator" in item ? (
          <div key={i} className="menu__sep" />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={item.danger ? "is-danger" : undefined}
            disabled={item.disabled}
            onClick={() => {
              onDone?.();
              item.onSelect();
            }}
          >
            <span className="lib-menu__check" aria-hidden="true">
              {item.checked ? "✓" : ""}
            </span>
            {item.label}
          </button>
        ),
      )}
    </div>
  );
}

export function PanelHead({ title, onBack }: { title: string; onBack(): void }) {
  return (
    <div className="lib-panel-head">
      <button className="icon-button" aria-label="Back" title="Back" onClick={onBack}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M7.5 2.5L4 6l3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      <span>{title}</span>
    </div>
  );
}
