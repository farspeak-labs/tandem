import { copyDocuments, dragDocuments, type CopyKind } from "../lib/desktop";
import { tildePath } from "../lib/connection";
import { StatusBadge } from "./library/DocRow";

const STATUS_HINTS: Record<string, string> = {
  draft: "Not handed over for review",
  "awaiting-review": "An agent handed this plan to you for review",
  "changes-requested": "You requested changes — waiting for the agent's revision",
  approved: "You approved this plan",
};
import { useState } from "react";
import type { TandemApi } from "../lib/api";
import type { UserInfo } from "../lib/session";
import type { DocStatus } from "../lib/useDocStatus";
import { relativeTime } from "../lib/threads";
import type { Mode } from "../editor/suggest-mode";
import { FinishReview } from "./FinishReview";
import { Menu } from "./Menu";
import { Segmented } from "./Segmented";
import { withKey } from "../lib/keys";
import type { ViewKind } from "./Workspace";

interface Props {
  /** False for plain notes: no plan status or "Finish review" unless an agent is waiting or it's been reviewed. */
  reviewChrome?: boolean;
  api: TandemApi;
  status: DocStatus;
  peers: UserInfo[];
  mode: Mode;
  onMode(m: Mode): void;
  view: ViewKind;
  onView(v: ViewKind): void;
  openComments: number;
  openSuggestions: number;
  onAcceptAll(): void;
  onRejectAll(): void;
  /** Current agent edit policy for this doc. */
  agentEdits: "suggest" | "direct";
  onToggleAgentEdits(): void;
  onDocComment(): void;
  historyOpen: boolean;
  onHistory(): void;
  outlineOpen: boolean;
  onOutline(): void;
  toolbarOpen: boolean;
  onToolbar(): void;
}

function SaveIndicator({ status }: { status: DocStatus }) {
  const label =
    status.saveState === "saving"
      ? "Saving…"
      : status.saveState === "error"
        ? "Save failed"
        : status.lastSavedAt
          ? `Saved ${relativeTime(status.lastSavedAt)}`
          : "Saved";
  return (
    <span className={`save-state save-${status.saveState}`} title={status.lastSavedAt ?? undefined}>
      <span className="dot" />
      {label}
    </span>
  );
}

function shortPath(path: string) {
  return tildePath(path);
}

export function Header(p: Props) {
  const showReview = p.reviewChrome !== false || p.status.agentWaiting > 0 || (!!p.status.planStatus && p.status.planStatus !== "draft");
  // Brief confirmation shown in place of the path ("Copied path", "Copied file"…).
  const [flash, setFlash] = useState<string | null>(null);
  const info = p.status.info;
  const title = info?.title ?? "Untitled";
  const path = info?.path ?? "";

  const show = (text: string) => {
    setFlash(text);
    setTimeout(() => setFlash(null), 1400);
  };
  const copyPath = async () => {
    try {
      await navigator.clipboard.writeText(path);
      show("Copied path");
    } catch {
      /* clipboard unavailable */
    }
  };
  const copyAndTell = async (kind: CopyKind) => {
    if (!path) return;
    show((await copyDocuments(kind, [path])).text);
  };

  return (
    <header className="titlebar">
      <div className="titlebar__doc">
        <div className="titlebar__title" title={title}>
          {title}
        </div>
        {path && (
          <button
            className="titlebar__path"
            onClick={copyPath}
            title="Click to copy the path · drag to move the file into another app"
            draggable
            onDragStart={(e) => dragDocuments(e, [path])}
          >
            {flash ?? shortPath(path)}
          </button>
        )}
      </div>

      <div className="titlebar__status">
        <SaveIndicator status={p.status} />
        {p.status.planStatus && showReview && (
          <span title={STATUS_HINTS[p.status.planStatus] ?? ""}>
            <StatusBadge status={p.status.planStatus} />
          </span>
        )}
        {p.status.agentWaiting > 0 && (
          <span className="badge badge--agent" title="An agent is waiting for your review">
            <span className="pulse" />
            {p.status.agentWaiting > 1 ? `${p.status.agentWaiting} agents waiting` : "Agent waiting"}
          </span>
        )}
        {p.peers.length > 0 && (
          <span className="peers">
            {p.peers.map((u) => (
              <span key={u.name} className="peer" style={{ background: u.color }} title={`${u.name}${u.kind === "agent" ? " (agent)" : ""}`}>
                {u.name.slice(0, 1).toUpperCase()}
              </span>
            ))}
          </span>
        )}
      </div>

      <div className="titlebar__controls">
        <button
          className={`icon-button ${p.outlineOpen ? "is-on" : ""}`}
          aria-pressed={p.outlineOpen}
          onClick={p.onOutline}
          title={withKey(p.outlineOpen ? "Hide outline" : "Show outline", "Mod-Shift-o")}
          aria-label="Outline"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
            <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" />
            <path d="M6 2.75v10.5" />
            <path d="M3.4 5.5h1M3.4 7.7h1M3.4 9.9h1" strokeWidth="1.2" />
          </svg>
        </button>
        <Segmented
          label="Mode"
          value={p.mode}
          onChange={p.onMode}
          options={[
            { value: "edit", label: "Edit" },
            { value: "suggest", label: "Suggest" },
            { value: "view", label: "View" },
          ]}
        />
        <Segmented
          label="View"
          value={p.view}
          onChange={p.onView}
          options={[
            { value: "rich", label: "Rich" },
            { value: "source", label: "Source" },
          ]}
        />
        <button
          className={`tool-button ${p.historyOpen ? "is-on" : ""}`}
          aria-pressed={p.historyOpen}
          onClick={p.onHistory}
          title="Plan history"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 4.5V8l2.5 1.6" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          History
        </button>
        <Menu
          label="Review actions"
          items={[
            { label: "Add document comment", onSelect: p.onDocComment },
            { separator: true },
            { label: `${p.toolbarOpen ? "✓ " : ""}Show formatting toolbar`, onSelect: p.onToolbar },
            { label: `${p.outlineOpen ? "✓ " : ""}Show outline`, onSelect: p.onOutline },
            { separator: true },
            { label: `Accept all suggestions${p.openSuggestions ? ` (${p.openSuggestions})` : ""}`, onSelect: p.onAcceptAll, disabled: !p.openSuggestions },
            { label: "Reject all suggestions", onSelect: p.onRejectAll, disabled: !p.openSuggestions },
            { separator: true },
            { label: "Copy file", onSelect: () => void copyAndTell("file") },
            { label: "Copy Markdown", onSelect: () => void copyAndTell("markdown") },
            { label: "Copy clean copy", onSelect: () => void copyAndTell("clean") },
            { separator: true },
            {
              label: `${p.agentEdits === "direct" ? "✓ " : ""}Let agents edit directly`,
              onSelect: p.onToggleAgentEdits,
            },
          ]}
        />
        {showReview && <FinishReview api={p.api} status={p.status} openComments={p.openComments} openSuggestions={p.openSuggestions} />}
      </div>
    </header>
  );
}
