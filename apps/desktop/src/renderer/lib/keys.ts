export const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

const MAC: Record<string, string> = { Mod: "⌘", Alt: "⌥", Shift: "⇧", Up: "↑", Down: "↓", Enter: "↩" };
const PC: Record<string, string> = { Mod: "Ctrl", Alt: "Alt", Shift: "Shift", Up: "Up", Down: "Down", Enter: "Enter" };

/** Human label for a TipTap-style key spec, e.g. `Mod-Shift-x` → `⌘⇧X` (Mac) or `Ctrl+Shift+X`. */
export function kbd(spec: string): string {
  const parts = spec.split("-").map((p) => (isMac ? MAC : PC)[p] ?? p.toUpperCase());
  return isMac ? parts.join("") : parts.join("+");
}

/** `title` text with its shortcut, e.g. `Bold (⌘B)`. */
export function withKey(title: string, spec?: string): string {
  return spec ? `${title} (${kbd(spec)})` : title;
}
