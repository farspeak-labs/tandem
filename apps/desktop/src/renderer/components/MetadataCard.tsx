import { useMemo } from "react";
import { metadataEntries } from "@tandem/core/mmd";
import type { Session } from "../lib/session";
import { useYMap } from "../lib/useYMap";

/**
 * The document's metadata (YAML frontmatter or an MMD `Key: value` block) as a
 * compact card above the text. It is edited as text: clicking opens Source view.
 */
export function MetadataCard({ session, onEdit }: { session: Session; onEdit: () => void }) {
  const meta = useYMap(session.ydoc.getMap<string>("meta"));
  const entries = useMemo(() => metadataEntries(meta.frontmatter ?? ""), [meta.frontmatter]);
  if (!entries.length) return null;
  return (
    <button type="button" className="metadata-card" onClick={onEdit} title="Edit metadata in Source view">
      {entries.map(({ key, value }) => (
        <span className="metadata-card__row" key={key}>
          <span className="metadata-card__key">{key}</span>
          <span className="metadata-card__value">{value || "—"}</span>
        </span>
      ))}
    </button>
  );
}
