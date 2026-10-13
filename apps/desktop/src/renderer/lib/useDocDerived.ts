import { useEffect, useState } from "react";
import type { Editor } from "@tiptap/react";
import type { Node as PMNode } from "@tiptap/pm/model";

const sameJson = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * A value derived from the whole document, recomputed once edits pause
 * (`delay` ms after the last change) rather than on every keystroke. The
 * component only re-renders when the value actually changes.
 */
export function useDocDerived<T>(editor: Editor | null, compute: (doc: PMNode) => T, initial: T, delay = 250): T {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    if (!editor) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const run = () => {
      timer = null;
      if (editor.isDestroyed) return;
      const next = compute(editor.state.doc);
      setValue((prev) => (sameJson(prev, next) ? prev : next));
    };
    run();
    // Any document change counts — including the initial sync from the service,
    // which doesn't reliably emit "update".
    const onTransaction = ({ transaction }: { transaction: { docChanged: boolean } }) => {
      if (!transaction.docChanged) return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(run, delay);
    };
    editor.on("transaction", onTransaction);
    return () => {
      editor.off("transaction", onTransaction);
      if (timer) clearTimeout(timer);
    };
    // `compute` is expected to be a module-level function.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, delay]);
  return value;
}

/** A boolean UI preference persisted in localStorage (falls back to memory if storage is unavailable). */
export function useStoredFlag(key: string, initial: boolean): [boolean, (v: boolean | ((prev: boolean) => boolean)) => void] {
  const [value, setValue] = useState<boolean>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : raw === "1";
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, value ? "1" : "0");
    } catch {
      /* storage unavailable */
    }
  }, [key, value]);
  return [value, setValue];
}

/** Tracks a CSS media query. */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    mq.addEventListener("change", on);
    window.addEventListener("resize", on);
    on();
    return () => {
      mq.removeEventListener("change", on);
      window.removeEventListener("resize", on);
    };
  }, [query]);
  return match;
}
