import { useMemo, useState } from "react";
import type { LibraryApi } from "../../lib/library-api";
import {
  DOC_TYPES,
  SETTABLE_STATUSES,
  applyTagEdit,
  sharedTags,
  statusLabel,
  toggleFolder,
  type DocPatch,
  type Facets,
  type LibraryDoc,
} from "../../lib/library";
import { Floating, MenuItems, PanelHead, type Anchor, type MenuItem } from "./Floating";
import { FolderPicker } from "./FolderPicker";
import { TagEditor } from "./TagEditor";

export type Panel = "menu" | "folder" | "tags" | "type" | "status";

interface Props {
  api: LibraryApi;
  docs: LibraryDoc[];
  facets: Facets | null;
  anchor: Anchor;
  /** Start in a picker instead of the menu (bulk bar buttons). */
  initialPanel?: Panel;
  onOpen(doc: LibraryDoc): void;
  onChanged(): void;
  onError(message: string): void;
  onClose(): void;
}

/** Applies one patch per doc (the API has no bulk endpoint). */
export async function patchEach(api: LibraryApi, docs: LibraryDoc[], patchFor: (d: LibraryDoc, i: number) => DocPatch | null) {
  const results = await Promise.allSettled(
    docs.map((d, i) => {
      const patch = patchFor(d, i);
      return patch ? api.patch(d.docId, patch) : Promise.resolve();
    }),
  );
  const failed = results.filter((r) => r.status === "rejected").length;
  if (failed) throw new Error(failed === docs.length ? "Couldn't update" : `Couldn't update ${failed} of ${docs.length}`);
}

/** Row / bulk actions: a menu that steps into pickers for folders, tags, type and status. */
export function DocActions(p: Props) {
  const [panel, setPanel] = useState<Panel>(p.initialPanel ?? "menu");
  const many = p.docs.length > 1;
  const allPinned = p.docs.every((d) => d.pinned);
  const allArchived = p.docs.every((d) => d.archived);
  const types = useMemo(() => new Set(p.docs.map((d) => d.type ?? "")), [p.docs]);
  const statuses = useMemo(() => new Set(p.docs.map((d) => d.status)), [p.docs]);

  const run = (patchFor: (d: LibraryDoc, i: number) => DocPatch | null, close = true) => {
    if (close) p.onClose();
    return patchEach(p.api, p.docs, patchFor)
      .catch((e: unknown) => p.onError(e instanceof Error ? e.message : "Couldn't update"))
      .finally(p.onChanged);
  };

  let body;
  if (panel === "folder") {
    body = (
      <FolderPicker
        api={p.api}
        docs={p.docs}
        facets={p.facets}
        onBack={() => setPanel("menu")}
        onToggle={(path) => {
          const next = toggleFolder(p.docs, path);
          return run((_, i) => ({ folders: next[i] }), false);
        }}
      />
    );
  } else if (panel === "tags") {
    const before = sharedTags(p.docs);
    body = (
      <TagEditor
        initial={before}
        known={p.facets?.tags ?? []}
        partial={many}
        onBack={() => setPanel("menu")}
        onSave={(after) => run((d) => ({ tags: applyTagEdit(d.tags, before, after) }))}
      />
    );
  } else if (panel === "type") {
    body = (
      <>
        <PanelHead title="Type" onBack={() => setPanel("menu")} />
        <MenuItems items={DOC_TYPES.map((t) => ({ label: t, checked: types.size === 1 && types.has(t), onSelect: () => run(() => ({ type: t })) }))} />
      </>
    );
  } else if (panel === "status") {
    body = (
      <>
        <PanelHead title="Mark as" onBack={() => setPanel("menu")} />
        <MenuItems
          items={SETTABLE_STATUSES.map((s) => ({
            label: statusLabel(s),
            checked: statuses.size === 1 && statuses.has(s),
            onSelect: () => run(() => ({ status: s })),
          }))}
        />
      </>
    );
  } else {
    const items: MenuItem[] = [];
    if (!many) items.push({ label: "Open", onSelect: () => (p.onClose(), p.onOpen(p.docs[0])) }, { separator: true });
    items.push(
      { label: allPinned ? "Unpin" : "Pin", onSelect: () => run(() => ({ pinned: !allPinned })) },
      { label: "Add to folder…", onSelect: () => setPanel("folder") },
      { label: "Edit tags…", onSelect: () => setPanel("tags") },
      { label: "Set type…", onSelect: () => setPanel("type") },
      { label: "Mark status…", onSelect: () => setPanel("status") },
      { separator: true },
      { label: allArchived ? "Unarchive" : "Archive", onSelect: () => run(() => ({ archived: !allArchived })) },
    );
    body = (
      <>
        {many && <div className="lib-menu__head">{p.docs.length} documents</div>}
        <MenuItems items={items} />
      </>
    );
  }

  return (
    <Floating anchor={p.anchor} onClose={p.onClose} className={`lib-actions lib-actions--${panel}`} label="Document actions">
      {body}
    </Floating>
  );
}
