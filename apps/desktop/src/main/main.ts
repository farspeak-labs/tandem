import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { BrowserWindow, Menu, Notification, Tray, app, clipboard, dialog, ipcMain, nativeImage, nativeTheme, session, shell, type MenuItemConstructorOptions } from "electron";
import { cleanCopy } from "@tandem/core";
import { marked } from "marked";
import { startService, type RunningService } from "@tandem/service";

/**
 * Tandem main process: hosts the doc service (one per user) and one window per document.
 * The service keeps running when all windows are closed so agents can keep waiting.
 */

let service: RunningService | null = null;

/** Lifecycle log (~/Library/Application Support/Tandem/main.log) for diagnosing start-up and quit. */
function log(message: string) {
  try {
    appendFileSync(join(app.getPath("userData"), "main.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // logging must never break the app
  }
}
const isMac = process.platform === "darwin";
const execFileAsync = promisify(execFile);
const windows = new Map<string, BrowserWindow>();
/** Windows/Linux: Tandem keeps running with no windows (agents may be waiting), so it lives in the tray. */
let tray: Tray | null = null;
const waiting = new Map<string, number>();
const pendingOpen: string[] = [];
let libraryWindow: BrowserWindow | null = null;
/** Set once a quit starts, so a quit interrupted by a window closing late still finishes. */
let quitting = false;

// Test and bench runs use their own profile so they can run beside the installed app.
if (process.env.TANDEM_USER_DATA) app.setPath("userData", process.env.TANDEM_USER_DATA);

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

/** `.md` paths passed on the command line (Windows/Linux file associations and "Open with"). */
function markdownArgs(argv: string[]): string[] {
  return argv.slice(1).filter((a) => !a.startsWith("-") && /\.md$/i.test(a) && existsSync(a));
}

// On Windows/Linux, opening a file while Tandem runs starts a second instance with the path in argv.
app.on("second-instance", (_event, argv) => {
  const files = markdownArgs(argv);
  if (files.length) {
    for (const f of files) openPath(f);
    return;
  }
  const first = windows.values().next().value as BrowserWindow | undefined;
  if (first) first.show();
  else showLibrary();
});
if (!isMac) pendingOpen.push(...markdownArgs(process.argv));

// Finder / Dock drops / Open Recent / `open -a Tandem file.md`.
app.on("open-file", (event, path) => {
  event.preventDefault();
  if (service) openPath(path);
  else pendingOpen.push(path);
});

app.on("window-all-closed", () => {
  log("window-all-closed");
  // Electron reports this instead of quitting when a window finished closing late during a quit.
  if (quitting) {
    app.quit();
    return;
  }
  // Stay alive: the doc service must keep answering agents. Quit from the menu.
});

app.on("activate", () => {
  log("activate");
  if (windows.size === 0 && !libraryWindow) showLibrary();
});

app.on("before-quit", async (event) => {
  log(`before-quit (service ${service ? "running" : "stopped"})`);
  if (!quitting) {
    quitting = true;
    // Last resort: never leave a half-quit app behind.
    setTimeout(() => {
      log("quit timed out; exiting");
      app.exit(0);
    }, 6000).unref();
  }
  if (!service) return;
  event.preventDefault();
  const s = service;
  service = null;
  // Never let shutdown block quitting.
  await Promise.race([
    s.close().then(
      () => log("service closed"),
      (err) => log(`service close failed: ${err instanceof Error ? err.message : String(err)}`),
    ),
    new Promise((r) => setTimeout(r, 3000)),
  ]);
  log("quitting");
  app.quit();
});

// ------------------------------------------------------------------ drag out & copy

/** Only existing Markdown files may leave the app by drag or clipboard. */
function exportablePaths(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((p): p is string => typeof p === "string" && /\.md$/i.test(p) && existsSync(p));
}

/** The Markdown as Tandem would save it (live edits included), else the file on disk. */
function markdownOf(path: string): string {
  const live = service?.docs.resolve({ path });
  return live ? live.markdown() : readFileSync(path, "utf8");
}

/**
 * Puts files on the clipboard so Finder/Explorer paste copies them and Mail/Slack attach them.
 * Electron's clipboard only does text and images, so this uses each OS's own pasteboard API.
 */
async function copyFiles(paths: string[]): Promise<boolean> {
  if (process.platform === "darwin") {
    const script = `function run(argv) {
      ObjC.import("AppKit");
      const pb = $.NSPasteboard.generalPasteboard;
      pb.clearContents;
      const urls = $.NSMutableArray.array;
      for (const p of argv) urls.addObject($.NSURL.fileURLWithPath(p));
      return pb.writeObjects(urls);
    }`;
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, ...paths]);
    return stdout.trim() === "true";
  }
  if (process.platform === "win32") {
    // Paths go in as single-quoted PowerShell literals ('' escapes a quote).
    const list = paths.map((p) => `'${p.replace(/'/g, "''")}'`).join(",");
    const encoded = Buffer.from(`Set-Clipboard -LiteralPath @(${list})`, "utf16le").toString("base64");
    await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true });
    return true;
  }
  clipboard.writeText(paths.join("\n"));
  return true;
}

const dragIcon = () => {
  const icon = nativeImage.createFromPath(join(__dirname, "drag-doc.png"));
  return icon.isEmpty() ? nativeImage.createFromPath(join(__dirname, "tray.png")) : icon;
};

ipcMain.on("tandem:drag-files", (event, input: unknown) => {
  const paths = exportablePaths(input);
  if (!paths.length) return;
  log(`drag out ${paths.length} file(s)`);
  event.sender.startDrag({ file: paths[0], files: paths, icon: dragIcon() });
});

ipcMain.handle("tandem:copy", async (_event, kind: unknown, input: unknown) => {
  const paths = exportablePaths(input);
  if (!paths.length) return { ok: false, error: "Only existing Markdown files can be copied." };
  switch (kind) {
    case "file":
      try {
        if (!(await copyFiles(paths))) return { ok: false, error: "Couldn't put the file on the clipboard." };
      } catch (err) {
        log(`copy files failed: ${err instanceof Error ? err.message : String(err)}`);
        return { ok: false, error: "Couldn't put the file on the clipboard." };
      }
      return { ok: true, message: paths.length > 1 ? `Copied ${paths.length} files` : "Copied file" };
    case "path":
      clipboard.writeText(paths.join("\n"));
      return { ok: true, message: paths.length > 1 ? "Copied paths" : "Copied path" };
    case "markdown":
      clipboard.writeText(paths.map(markdownOf).join("\n\n"));
      return { ok: true, message: "Copied Markdown" };
    case "clean":
      clipboard.writeText(paths.map((p) => cleanCopy(markdownOf(p))).join("\n\n"));
      return { ok: true, message: "Copied clean copy" };
    default:
      return { ok: false, error: "Unknown copy kind" };
  }
});

app.on("will-quit", () => log("will-quit"));
app.on("quit", () => log("quit"));

/** Small persisted preferences in the app's userData folder. */
interface Prefs {
  spellcheck: boolean;
  /** Name shown on your comments, suggestions and reviews. Defaults to the Mac user's full name. */
  userName?: string;
}
function prefsFile() {
  return join(app.getPath("userData"), "prefs.json");
}
function loadPrefs(): Prefs {
  try {
    if (existsSync(prefsFile())) return { spellcheck: false, ...JSON.parse(readFileSync(prefsFile(), "utf8")) };
  } catch {
    // fall through to defaults
  }
  // Spell-check is off by default: Chromium re-checks the whole document as you
  // type, which measured ~26 ms/keystroke (p50) vs ~6 ms with it off on a 13 KB plan.
  return { spellcheck: false };
}
let prefs: Prefs = { spellcheck: false };
function savePrefs() {
  writeFileSync(prefsFile(), JSON.stringify(prefs, null, 2));
}

app.whenReady().then(async () => {
  prefs = loadPrefs();
  // Windows needs an app id for notifications to show (matches the installer's appId).
  if (process.platform === "win32") app.setAppUserModelId("com.farspeaklabs.tandem");
  // Follow macOS appearance changes so window backgrounds keep matching the page.
  nativeTheme.on("updated", () => {
    for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.setBackgroundColor(windowBackground());
  });
  session.defaultSession.setSpellCheckerEnabled(prefs.spellcheck);
  log("starting");
  service = await startService({ onShow: (docId, path) => showDoc(docId, path) });
  log(`service up on ${service.url}`);
  service.docs.on((e) => {
    if (e.type === "agent.waiting") onAgentWaiting(e.docId, e.count);
    if (e.type === "doc.saved") windows.get(e.docId)?.setDocumentEdited(false);
  });
  buildMenu();
  if (!isMac) createTray();
  for (const p of pendingOpen.splice(0)) openPath(p);
  // Opened by hand (not by `tandem open`): show the Library once nothing else asked for a window.
  setTimeout(() => {
    if (windows.size === 0 && !libraryWindow && process.env.TANDEM_BENCH !== "1") showLibrary();
  }, 1500);
});

/** The reviewer name: Your Name… setting, else the macOS account's full name, else the login name. */
function userName(): string {
  if (prefs.userName?.trim()) return prefs.userName.trim();
  if (isMac) {
    try {
      const full = execFileSync("/usr/bin/id", ["-F"], { encoding: "utf8" }).trim();
      if (full) return full.split(/\s+/)[0];
    } catch {
      // fall through
    }
  }
  const login = userInfo().username;
  return login.charAt(0).toUpperCase() + login.slice(1);
}

/** Window chrome: the Mac's inset title bar with traffic lights; the standard frame elsewhere. */
function chrome(): Partial<Electron.BrowserWindowConstructorOptions> {
  return isMac ? { titleBarStyle: "hiddenInset" } : { autoHideMenuBar: false };
}

function createTray() {
  const icon = nativeImage.createFromPath(join(__dirname, "tray.png"));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip("Tandem");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Library", click: () => showLibrary() },
      { label: "Open…", click: () => void showOpenDialog() },
      { type: "separator" },
      { label: "Quit Tandem", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => showLibrary());
}

/** Matches the page's --bg so opening, resizing and closing never flash white in dark mode. */
function windowBackground(): string {
  return nativeTheme.shouldUseDarkColors ? "#1c1c1e" : "#ffffff";
}

function showLibrary() {
  if (!service) return;
  if (libraryWindow && !libraryWindow.isDestroyed()) {
    libraryWindow.show();
    libraryWindow.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: "Tandem Library",
    ...chrome(),
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      additionalArguments: [`--tandem=${JSON.stringify({ baseUrl: service.url, token: service.token, view: "library", userName: userName(), home: homedir() })}`],
    },
  });
  libraryWindow = win;
  win.on("close", () => log("library close"));
  win.on("closed", () => {
    log("library closed");
    libraryWindow = null;
  });
  win.once("ready-to-show", () => win.show());
  const devUrl = process.env.TANDEM_RENDERER_URL;
  if (devUrl) void win.loadURL(`${devUrl}${devUrl.includes("?") ? "&" : "?"}view=library`);
  else void win.loadFile(join(__dirname, "../renderer/index.html"), { query: { view: "library" } });
}

function openPath(path: string) {
  if (!service) return;
  try {
    const open = service.docs.open(path);
    showDoc(open.docId, open.path);
  } catch (err) {
    dialog.showErrorBox("Couldn’t open file", err instanceof Error ? err.message : String(err));
  }
}

function showDoc(docId: string, path: string) {
  if (!service) return;
  app.addRecentDocument(path);
  const existing = windows.get(docId);
  log(`show doc ${docId} (${existing && !existing.isDestroyed() ? "reusing window" : "new window"}) ${path}`);
  if (existing && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 1180,
    height: 900,
    minWidth: 640,
    minHeight: 480,
    title: service.docs.get(docId)?.title() ?? "Tandem",
    ...chrome(),
    backgroundColor: windowBackground(),
    // Debug switches for the latency bench (scripts/bench-electron.ts).
    ...(process.env.TANDEM_VIBRANCY === "1" ? { backgroundColor: "#00000000", vibrancy: "under-window" as const } : {}),
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      spellcheck: process.env.TANDEM_SPELLCHECK ? process.env.TANDEM_SPELLCHECK === "1" : true,
      backgroundThrottling: process.env.TANDEM_BENCH !== "1",
      additionalArguments: [`--tandem=${JSON.stringify({ baseUrl: service.url, token: service.token, docId, userName: userName(), home: homedir() })}`],
    },
  });
  if (isMac) win.setRepresentedFilename(path);
  windows.set(docId, win);
  win.on("close", () => log(`window close ${docId}`));
  win.on("closed", () => windows.delete(docId));
  win.once("ready-to-show", () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("page-title-updated", () => undefined);

  const devUrl = process.env.TANDEM_RENDERER_URL;
  if (devUrl) void win.loadURL(devUrl);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

function onAgentWaiting(docId: string, count: number) {
  const before = waiting.get(docId) ?? 0;
  waiting.set(docId, count);
  const total = [...waiting.values()].filter((c) => c > 0).length;
  if (isMac) app.dock?.setBadge(total ? String(total) : "");
  else tray?.setToolTip(total ? `Tandem — ${total} waiting for your review` : "Tandem");
  // Windows/Linux have no Dock badge: flash the document's taskbar button instead.
  if (!isMac && count > 0) windows.get(docId)?.flashFrame(true);
  if (before === 0 && count > 0 && service) {
    const open = service.docs.get(docId);
    const win = windows.get(docId);
    if (open && (!win || !win.isFocused())) {
      const n = new Notification({ title: "Waiting for your review", body: `${open.title()} — an agent is waiting.` });
      n.on("click", () => showDoc(docId, open.path));
      n.show();
    }
  }
}

/** Lets the reviewer change the name shown on their comments and reviews (applies to newly opened windows). */
async function askUserName() {
  const win = BrowserWindow.getFocusedWindow() ?? undefined;
  const current = userName();
  const prompt = new BrowserWindow({
    parent: win,
    modal: Boolean(win),
    width: 360,
    height: 150,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: "Your Name",
    backgroundColor: windowBackground(),
    webPreferences: { sandbox: true, contextIsolation: true },
  });
  const esc = (t: string) => t.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const html = `<!doctype html><meta charset="utf-8"><style>
    :root{color-scheme:light dark} body{font:13px -apple-system,"Segoe UI",sans-serif;margin:16px}
    input{width:100%;box-sizing:border-box;font:inherit;padding:6px 8px;margin:6px 0 10px}
    .row{display:flex;justify-content:flex-end;gap:8px}</style>
    <label>Name shown on your comments and reviews</label>
    <form onsubmit="document.title='set:'+encodeURIComponent(document.getElementById('n').value);return false">
    <input id="n" value="${esc(current)}" autofocus><div class="row"><button type="button" onclick="window.close()">Cancel</button><button>Save</button></div></form>`;
  prompt.on("page-title-updated", (event, title) => {
    event.preventDefault();
    if (!title.startsWith("set:")) return;
    prefs.userName = decodeURIComponent(title.slice(4)).trim() || undefined;
    savePrefs();
    prompt.close();
  });
  await prompt.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** Exports the focused document with every suggestion accepted and review markup removed. */
async function exportFocused(format: "md" | "pdf") {
  if (!service) return;
  const focused = BrowserWindow.getFocusedWindow();
  const entry = [...windows.entries()].find(([, w]) => w === focused);
  const open = entry ? service.docs.get(entry[0]) : undefined;
  if (!open) {
    dialog.showErrorBox("Nothing to export", "Open a document window first.");
    return;
  }
  const clean = cleanCopy(open.markdown());
  const base = open.path.replace(/\.md$/i, "");
  const { canceled, filePath } = await dialog.showSaveDialog(focused!, {
    defaultPath: `${base}.clean.${format}`,
    filters: [format === "md" ? { name: "Markdown", extensions: ["md"] } : { name: "PDF", extensions: ["pdf"] }],
  });
  if (canceled || !filePath) return;
  if (format === "md") {
    writeFileSync(filePath, clean);
    return;
  }
  const html = `<!doctype html><meta charset="utf-8"><title>${open.title().replace(/</g, "&lt;")}</title>
<style>
  body { font: 11pt/1.55 -apple-system, "Segoe UI", "Helvetica Neue", sans-serif; color: #111; max-width: 46em; margin: 0 auto; }
  h1, h2, h3 { line-height: 1.25; margin: 1.4em 0 .5em; } h1 { font-size: 22pt; } h2 { font-size: 16pt; } h3 { font-size: 13pt; }
  code { font: 9.5pt ui-monospace, Menlo, monospace; background: #f3f3f3; padding: 0 .2em; border-radius: 3px; }
  pre { background: #f6f6f6; padding: .8em 1em; border-radius: 6px; overflow: hidden; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 10pt; }
  th, td { border: 1px solid #ccc; padding: .35em .6em; text-align: left; vertical-align: top; }
  blockquote { margin: 1em 0; padding-left: 1em; border-left: 3px solid #ddd; color: #444; }
  tr, pre, blockquote { break-inside: avoid; }
</style>${marked.parse(clean.replace(/^---\n[\s\S]*?\n---\n/, ""))}`;
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: false } });
  await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  const pdf = await printer.webContents.printToPDF({ pageSize: "Letter", printBackground: true, margins: { marginType: "default" } });
  printer.destroy();
  writeFileSync(filePath, pdf);
}

async function showOpenDialog() {
  const result = await dialog.showOpenDialog({
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  for (const p of result.filePaths) openPath(p);
}

/** Sends a command to the focused Tandem window's page. */
function command(name: string) {
  BrowserWindow.getFocusedWindow()?.webContents.send("tandem:command", name);
}

function buildMenu() {
  const appMenu: MenuItemConstructorOptions[] = isMac
    ? [
        {
          role: "appMenu",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "Your Name…", click: () => void askUserName() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
        },
      ]
    : [];
  const template: MenuItemConstructorOptions[] = [
    ...appMenu,
    {
      label: "File",
      submenu: [
        { label: "Open…", accelerator: "CmdOrCtrl+O", click: () => void showOpenDialog() },
        ...(isMac ? [{ role: "recentDocuments", submenu: [{ role: "clearRecentDocuments" }] } as MenuItemConstructorOptions] : []),
        { type: "separator" },
        {
          label: "Export Clean Copy",
          submenu: [
            { label: "Markdown…", accelerator: "CmdOrCtrl+Shift+E", click: () => void exportFocused("md") },
            { label: "PDF…", click: () => void exportFocused("pdf") },
          ],
        },
        { type: "separator" },
        ...(isMac
          ? [{ role: "close" } as MenuItemConstructorOptions]
          : ([
              { label: "Your Name…", click: () => void askUserName() },
              { type: "separator" },
              { role: "close" },
              { label: "Quit Tandem", accelerator: "Ctrl+Q", click: () => app.quit() },
            ] as MenuItemConstructorOptions[])),
      ],
    },
    {
      label: "Edit",
      submenu: [
        // The document uses collaborative undo (only your own changes), not the browser's.
        { label: "Undo", accelerator: "CmdOrCtrl+Z", click: () => command("undo") },
        { label: "Redo", accelerator: "CmdOrCtrl+Shift+Z", click: () => command("redo") },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
        { type: "separator" },
        { label: "Find…", accelerator: "CmdOrCtrl+F", click: () => command("find") },
        { label: "Find and Replace…", accelerator: "CmdOrCtrl+Alt+F", click: () => command("replace") },
        { type: "separator" },
        {
          label: "Spelling",
          submenu: [
            {
              label: "Check Spelling While Typing",
              type: "checkbox",
              checked: prefs.spellcheck,
              click: (item) => {
                prefs.spellcheck = item.checked;
                session.defaultSession.setSpellCheckerEnabled(item.checked);
                savePrefs();
              },
            },
          ],
        },
      ],
    },
    {
      label: "View",
      submenu: [
        { label: "Formatting Toolbar", accelerator: "CmdOrCtrl+Alt+T", click: () => command("toggleToolbar") },
        { label: "Outline", accelerator: "CmdOrCtrl+Shift+O", click: () => command("toggleOutline") },
        { type: "separator" },
        { label: "Next Comment or Suggestion", accelerator: "CmdOrCtrl+Alt+Down", click: () => command("nextReview") },
        { label: "Previous Comment or Suggestion", accelerator: "CmdOrCtrl+Alt+Up", click: () => command("prevReview") },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
        { role: "toggleDevTools" },
      ],
    },
    {
      role: "windowMenu",
      submenu: [
        { label: "Library", accelerator: "CmdOrCtrl+Shift+L", click: () => showLibrary() },
        { type: "separator" },
        { role: "minimize" },
        ...(isMac ? ([{ role: "zoom" }, { type: "separator" }, { role: "front" }] as MenuItemConstructorOptions[]) : []),
      ],
    },
    ...(isMac ? [] : [{ role: "help", submenu: [{ role: "about" }] } as MenuItemConstructorOptions]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}
