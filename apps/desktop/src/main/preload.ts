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
  platform: process.platform,
});

// Native menu commands → the page (Workspace / Library listen for "tandem:command").
ipcRenderer.on("tandem:command", (_event, command: string) => {
  window.dispatchEvent(new CustomEvent("tandem:command", { detail: command }));
});
