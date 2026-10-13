interface Option<T extends string> {
  value: T;
  label: string;
}

/** macOS-style segmented control. */
export function Segmented<T extends string>(p: { label: string; value: T; options: Option<T>[]; onChange(v: T): void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={p.label}>
      {p.options.map((o) => (
        <button
          key={o.value}
          role="radio"
          aria-checked={p.value === o.value}
          className={p.value === o.value ? "is-on" : ""}
          onClick={() => p.onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
