import { contextBridge, ipcRenderer } from "electron";

/** Exposes `window.tandem = { baseUrl, token, docId }` to the renderer (see docs/spec/service-api.md). */
const arg = process.argv.find((a) => a.startsWith("--tandem="));
const config = arg ? (JSON.parse(arg.slice("--tandem=".length)) as Record<string, string>) : {};

contextBridge.exposeInMainWorld("tandem", {
  baseUrl: config.baseUrl,
  token: config.token,
  docId: config.docId,
  view: config.view,
  userName: config.userName,
  home: config.home,
  platform: process.platform,
  /** Starts a native file drag (Finder, Mail, Slack…) for these Markdown files. */
  startDrag: (paths: string[]) => ipcRenderer.send("tandem:drag-files", paths),
  /** Copies files, paths, Markdown or a clean copy to the clipboard. */
  copy: (kind: "file" | "path" | "markdown" | "clean", paths: string[]) => ipcRenderer.invoke("tandem:copy", kind, paths),
  /** Native folder picker (adding a notebook); null if cancelled. */
  chooseFolder: (): Promise<string | null> => ipcRenderer.invoke("tandem:choose-folder"),
});

// Native menu commands → the page (Workspace / Library listen for "tandem:command").
ipcRenderer.on("tandem:command", (_event, command: string) => {
  window.dispatchEvent(new CustomEvent("tandem:command", { detail: command }));
});
