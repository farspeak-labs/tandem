import { useSyncExternalStore } from "react";

/** How Write mode looks and behaves. Kept per viewer in localStorage. */
export interface WriteSettings {
  font: "serif" | "sans" | "mono";
  theme: "paper" | "sepia" | "night" | "app";
  /** Text size in px. */
  size: number;
  width: "narrow" | "medium" | "wide";
  /** Keep the line being typed in the middle of the window. */
  typewriter: boolean;
  /** Dim everything but the paragraph being written. */
  focus: boolean;
  /** Curly quotes, dashes and ellipses as you type. */
  smart: boolean;
  /** Word goal for the document, or null. */
  goal: number | null;
}

const KEY = "tandem.write.settings";
export const WRITE_DEFAULTS: WriteSettings = {
  font: "serif",
  theme: "app",
  size: 20,
  width: "medium",
  typewriter: false,
  focus: false,
  smart: true,
  goal: null,
};

let current: WriteSettings = load();
const listeners = new Set<() => void>();

function load(): WriteSettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...WRITE_DEFAULTS, ...(JSON.parse(raw) as Partial<WriteSettings>) } : WRITE_DEFAULTS;
  } catch {
    return WRITE_DEFAULTS;
  }
}

export function writeSettings(): WriteSettings {
  return current;
}

export function updateWriteSettings(patch: Partial<WriteSettings>) {
  current = { ...current, ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // Private window or blocked storage: settings last for this session only.
  }
  for (const l of listeners) l();
}

export function useWriteSettings(): WriteSettings {
  return useSyncExternalStore(
    (notify) => {
      listeners.add(notify);
      return () => listeners.delete(notify);
    },
    () => current,
  );
}

export function onWriteSettings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
