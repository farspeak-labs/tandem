import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import { docWords } from "../editor/doc-stats";
import { useDocDerived } from "../lib/useDocDerived";
import { updateWriteSettings, useWriteSettings, type WriteSettings } from "../lib/write-settings";
import { usePopover } from "./usePopover";

const fmt = (n: number) => n.toLocaleString("en-US");

/**
 * Write mode's only chrome: a few controls top-right and a word count
 * bottom-right, both faded out until the pointer moves. A strip along the top
 * keeps the window draggable now that the title bar is hidden.
 */
export function WriteChrome({ editor, scroller, onExit }: { editor: Editor; scroller: React.RefObject<HTMLElement | null>; onExit(): void }) {
  const s = useWriteSettings();
  const words = useDocDerived(editor, docWords, 0, 400);
  const [awake, setAwake] = useState(true);
  const timer = useRef<number | null>(null);
  const settings = usePopover<HTMLDivElement>();

  // Wake on pointer movement; sleep after a moment of typing or stillness.
  useEffect(() => {
    const wake = () => {
      setAwake(true);
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAwake(false), 1800);
    };
    const sleep = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey) return;
      setAwake(false);
    };
    wake();
    window.addEventListener("mousemove", wake);
    window.addEventListener("keydown", sleep);
    return () => {
      window.removeEventListener("mousemove", wake);
      window.removeEventListener("keydown", sleep);
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, []);

  // Typewriter scrolling: keep the caret's line a little above the middle.
  useEffect(() => {
    if (!s.typewriter) return;
    const center = () => {
      const el = scroller.current;
      if (!el || !editor.isFocused) return;
      let top: number;
      try {
        top = editor.view.coordsAtPos(editor.state.selection.head).top;
      } catch {
        return;
      }
      const box = el.getBoundingClientRect();
      el.scrollTop += top - (box.top + el.clientHeight * 0.45);
    };
    editor.on("selectionUpdate", center);
    editor.on("update", center);
    return () => {
      editor.off("selectionUpdate", center);
      editor.off("update", center);
    };
  }, [editor, s.typewriter, scroller]);

  const set = (patch: Partial<WriteSettings>) => updateWriteSettings(patch);
  const goalText = s.goal ? ` of ${fmt(s.goal)}` : "";

  return (
    <>
      <div className="write-drag" />
      <div className={`write-chrome ${awake || settings.open ? "is-awake" : ""}`}>
        <div className="write-chrome__menu" ref={settings.ref}>
          <button type="button" title="Text and typing settings" onClick={() => settings.setOpen(!settings.open)}>
            Aa
          </button>
          {settings.open && (
            <div className="write-settings" role="dialog" aria-label="Write mode settings">
              <Choice label="Font" value={s.font} options={[["serif", "Serif"], ["sans", "Sans"], ["mono", "Mono"]]} onPick={(font) => set({ font })} />
              <Choice label="Theme" value={s.theme} options={[["app", "App"], ["paper", "Paper"], ["sepia", "Sepia"], ["night", "Night"]]} onPick={(theme) => set({ theme })} />
              <Choice label="Width" value={s.width} options={[["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]} onPick={(width) => set({ width })} />
              <div className="write-settings__row">
                <span>Size</span>
                <div className="write-settings__seg">
                  <button type="button" onClick={() => set({ size: Math.max(14, s.size - 1) })} aria-label="Smaller text">A−</button>
                  <span className="write-settings__val">{s.size}</span>
                  <button type="button" onClick={() => set({ size: Math.min(30, s.size + 1) })} aria-label="Larger text">A+</button>
                </div>
              </div>
              <Toggle label="Typewriter scrolling" on={s.typewriter} onToggle={(typewriter) => set({ typewriter })} />
              <Toggle label="Focus on the paragraph" on={s.focus} onToggle={(focus) => set({ focus })} />
              <Toggle label="Smart punctuation" on={s.smart} onToggle={(smart) => set({ smart })} />
              <div className="write-settings__row">
                <span>Word goal</span>
                <input
                  type="number"
                  min={0}
                  step={100}
                  placeholder="None"
                  value={s.goal ?? ""}
                  onChange={(e) => set({ goal: e.target.value ? Math.max(0, Number(e.target.value)) || null : null })}
                />
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          title="Full screen"
          onClick={() => (document.fullscreenElement ? void document.exitFullscreen() : void document.documentElement.requestFullscreen())}
        >
          ⤢
        </button>
        <button type="button" className="write-chrome__done" title="Leave Write mode (Esc or ⌘⇧W)" onClick={onExit}>
          Done
        </button>
      </div>
      <div className={`write-count ${awake ? "is-awake" : ""}`}>
        {fmt(words)}
        {goalText} words
        {s.goal ? <span className="write-count__bar" style={{ width: `${Math.min(100, (words / s.goal) * 100)}%` }} /> : null}
      </div>
    </>
  );
}

function Choice<T extends string>({ label, value, options, onPick }: { label: string; value: T; options: Array<[T, string]>; onPick(v: T): void }) {
  return (
    <div className="write-settings__row">
      <span>{label}</span>
      <div className="write-settings__seg">
        {options.map(([v, text]) => (
          <button key={v} type="button" className={v === value ? "is-on" : ""} onClick={() => onPick(v)}>
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}

function Toggle({ label, on, onToggle }: { label: string; on: boolean; onToggle(v: boolean): void }) {
  return (
    <label className="write-settings__row write-settings__toggle">
      <span>{label}</span>
      <input type="checkbox" checked={on} onChange={(e) => onToggle(e.target.checked)} />
    </label>
  );
}
