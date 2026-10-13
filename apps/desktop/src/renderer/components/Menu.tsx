import { usePopover } from "./usePopover";

type Item = { label: string; onSelect(): void; disabled?: boolean } | { separator: true };

export function Menu({ label, items }: { label: string; items: Item[] }) {
  const { open, setOpen, ref } = usePopover<HTMLDivElement>();
  return (
    <div className="menu" ref={ref}>
      <button className="icon-button" aria-label={label} title={label} aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="3.5" cy="8" r="1.4" fill="currentColor" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" />
          <circle cx="12.5" cy="8" r="1.4" fill="currentColor" />
        </svg>
      </button>
      {open && (
        <div className="popover menu__list" role="menu">
          {items.map((item, i) =>
            "separator" in item ? (
              <div key={i} className="menu__sep" />
            ) : (
              <button
                key={i}
                role="menuitem"
                disabled={item.disabled}
                onClick={() => {
                  setOpen(false);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}
