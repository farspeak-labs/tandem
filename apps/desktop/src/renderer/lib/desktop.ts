/** Bridges to the desktop app for dragging and copying documents out of Tandem. */

export type CopyKind = "file" | "path" | "markdown" | "clean";

interface DesktopBridge {
  startDrag?: (paths: string[]) => void;
  copy?: (kind: CopyKind, paths: string[]) => Promise<{ ok: boolean; message?: string; error?: string }>;
}

function bridge(): DesktopBridge {
  return ((window as unknown as { tandem?: DesktopBridge }).tandem ?? {}) as DesktopBridge;
}

const fileUrl = (p: string) => `file://${p.startsWith("/") ? "" : "/"}${encodeURI(p.replace(/\\/g, "/"))}`;

/**
 * Starts dragging documents out of Tandem. In the app this is a real file drag
 * (Finder, Mail, Slack get the .md files); in a browser it carries file URLs.
 */
export function dragDocuments(e: React.DragEvent, paths: string[]) {
  const b = bridge();
  if (b.startDrag) {
    e.preventDefault();
    b.startDrag(paths);
    return;
  }
  e.dataTransfer.effectAllowed = "copy";
  e.dataTransfer.setData("text/uri-list", paths.map(fileUrl).join("\r\n"));
  e.dataTransfer.setData("text/plain", paths.join("\n"));
}

/** Copies documents to the clipboard; returns the message to show. */
export async function copyDocuments(kind: CopyKind, paths: string[]): Promise<{ ok: boolean; text: string }> {
  const b = bridge();
  if (b.copy) {
    const r = await b.copy(kind, paths);
    return { ok: r.ok, text: r.ok ? (r.message ?? "Copied") : (r.error ?? "Couldn't copy") };
  }
  // Browser fallback: only paths can be copied without the app.
  await navigator.clipboard.writeText(paths.join("\n"));
  return { ok: true, text: kind === "path" ? "Copied path" : "Copied path (open in the app to copy files)" };
}
