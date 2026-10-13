import { useState } from "react";
import type { LibraryApi } from "../../lib/library-api";
import type { Facets, LibraryDoc } from "../../lib/library";
import { PanelHead } from "./Floating";

/** Pick folders for docs: click toggles membership; typing a new path creates it. */
export function FolderPicker(p: {
  api: LibraryApi;
  docs: LibraryDoc[];
  facets: Facets | null;
  onBack(): void;
  onToggle(path: string): Promise<void>;
}) {
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const clean = filter
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
  const paths = (p.facets?.folders ?? []).map((f) => f.path);
  const shown = paths.filter((path) => path.toLowerCase().includes(clean.toLowerCase()));
  const exists = paths.some((path) => path.toLowerCase() === clean.toLowerCase());

  const toggle = async (path: string) => {
    setBusy(true);
    try {
      await p.onToggle(path);
    } finally {
      setBusy(false);
    }
  };

  const state = (path: string) => {
    const n = p.docs.filter((d) => d.folders.includes(path)).length;
    return n === 0 ? "" : n === p.docs.length ? "✓" : "–";
  };

  return (
    <div className="lib-folder-picker" aria-busy={busy}>
      <PanelHead title="Folders" onBack={p.onBack} />
      <form
        className="lib-folder-picker__form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!clean) return;
          // Enter picks the exact match, else the first filtered folder, else creates the typed path.
          const match = paths.find((path) => path.toLowerCase() === clean.toLowerCase()) ?? shown[0];
          void toggle(match ?? clean).then(() => setFilter(""));
        }}
      >
        <input className="field" autoFocus placeholder="Find or create (e.g. Q4/Launch)" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </form>
      <div className="menu__list lib-menu lib-folder-picker__list" role="menu">
        {shown.map((path) => (
          <button key={path} role="menuitemcheckbox" aria-checked={state(path) === "✓"} disabled={busy} onClick={() => void toggle(path)}>
            <span className="lib-menu__check" aria-hidden="true">
              {state(path)}
            </span>
            <span className="lib-folder-picker__path">
              {path.includes("/") && <span className="muted">{path.slice(0, path.lastIndexOf("/") + 1)}</span>}
              {path.slice(path.lastIndexOf("/") + 1)}
            </span>
          </button>
        ))}
        {clean && !exists && (
          <button role="menuitem" disabled={busy} onClick={() => void toggle(clean).then(() => setFilter(""))}>
            <span className="lib-menu__check" aria-hidden="true">
              +
            </span>
            New folder “{clean}”
          </button>
        )}
        {!shown.length && !clean && <div className="lib-menu__empty">No folders yet. Type a name to create one.</div>}
      </div>
    </div>
  );
}
