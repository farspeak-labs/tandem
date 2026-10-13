import { useState } from "react";
import { normalizeTag, suggestTags, type Count } from "../../lib/library";
import { PanelHead } from "./Floating";

/** Chip editor for tags with autocomplete from existing tags. */
export function TagEditor(p: { initial: string[]; known: Count[]; partial: boolean; onBack(): void; onSave(tags: string[]): void }) {
  const [tags, setTags] = useState<string[]>(p.initial);
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(-1);
  const suggestions = suggestTags(input, p.known, tags, 6);

  const add = (raw: string) => {
    const t = normalizeTag(raw);
    if (t && !tags.includes(t)) setTags([...tags, t]);
    setInput("");
    setCursor(-1);
  };
  const remove = (t: string) => setTags(tags.filter((x) => x !== t));
  const dirty = tags.join("\n") !== p.initial.join("\n") || !!normalizeTag(input);

  const save = () => {
    const pending = normalizeTag(input);
    p.onSave(pending && !tags.includes(pending) ? [...tags, pending] : tags);
  };

  const onKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" && suggestions.length) {
      e.preventDefault();
      setCursor((c) => Math.min(suggestions.length - 1, c + 1));
    } else if (e.key === "ArrowUp" && suggestions.length) {
      e.preventDefault();
      setCursor((c) => Math.max(-1, c - 1));
    } else if (e.key === "Enter" || e.key === "," || e.key === "Tab") {
      const pick = cursor >= 0 ? suggestions[cursor] : input;
      if (!normalizeTag(pick)) {
        if (e.key === "Enter" && (e.metaKey || !input)) {
          e.preventDefault();
          save();
        }
        return;
      }
      e.preventDefault();
      add(pick);
    } else if (e.key === "Backspace" && !input && tags.length) {
      remove(tags[tags.length - 1]);
    }
  };

  return (
    <div className="lib-tags">
      <PanelHead title="Tags" onBack={p.onBack} />
      <div className="lib-tags__box field" onClick={(e) => e.currentTarget.querySelector("input")?.focus()}>
        {tags.map((t) => (
          <span key={t} className="tag-chip">
            {t}
            <button aria-label={`Remove ${t}`} onClick={() => remove(t)}>
              ×
            </button>
          </span>
        ))}
        <input
          autoFocus
          value={input}
          placeholder={tags.length ? "" : "Add tags…"}
          aria-label="Add tag"
          aria-autocomplete="list"
          onChange={(e) => {
            setInput(e.target.value.replace(/,/g, ""));
            setCursor(-1);
          }}
          onKeyDown={onKey}
        />
      </div>
      {suggestions.length > 0 && (
        <div className="lib-tags__suggest" role="listbox" aria-label="Existing tags">
          {suggestions.map((t, i) => (
            <button key={t} role="option" aria-selected={i === cursor} className={i === cursor ? "is-active" : ""} onMouseDown={(e) => e.preventDefault()} onClick={() => add(t)}>
              {t}
              <span className="muted">{p.known.find((k) => k.value === t)?.n}</span>
            </button>
          ))}
        </div>
      )}
      {p.partial && <div className="lib-prompt__hint">Tags shared by every selected document. Tags only some have are kept.</div>}
      <div className="finish__actions">
        <button className="text-button" onClick={p.onBack}>
          Cancel
        </button>
        <button className="primary-button small" disabled={!dirty} onClick={save}>
          Save tags
        </button>
      </div>
    </div>
  );
}
