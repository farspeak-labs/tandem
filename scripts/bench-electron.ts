// Keystroke latency in the real Electron app, driven over CDP (real browser-process input path).
// Usage: tsx scripts/bench-electron.ts <file.md> [label]   (env passes through, e.g. TANDEM_VIBRANCY=1)
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import WebSocket from "ws";

const file = resolve(process.argv[2]);
const label = process.argv[3] ?? "default";
const home = mkdtempSync(join(tmpdir(), "tandem-bench-"));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const app = spawn(resolve("apps/desktop/node_modules/.bin/electron"), [resolve("apps/desktop"), "--remote-debugging-port=9333"], {
  env: { ...process.env, TANDEM_HOME: home, TANDEM_BENCH: "1", TANDEM_USER_DATA: join(home, "userdata") },
  stdio: "ignore",
});
try {
  for (let i = 0; !existsSync(join(home, "server.json")); i++) {
    if (i > 150) throw new Error("app did not start");
    await sleep(100);
  }
  const { port, token } = JSON.parse(readFileSync(join(home, "server.json"), "utf8"));
  await fetch(`http://127.0.0.1:${port}/api/open`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ path: file }) });
  let target: { webSocketDebuggerUrl: string } | undefined;
  for (let i = 0; i < 100 && !target; i++) {
    await sleep(150);
    const list = (await (await fetch("http://127.0.0.1:9333/json").catch(() => null))?.json().catch(() => [])) ?? [];
    target = (list as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>).find((t) => t.type === "page" && t.url.includes("index.html"));
  }
  if (!target) throw new Error("no page");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.once("open", r));
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.on("message", (d) => { const m = JSON.parse(String(d)); pending.get(m.id)?.(m.result); pending.delete(m.id); });
  const cdp = (method: string, params: object = {}) => new Promise<any>((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async (expr: string) => (await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true })).result.value;

  await sleep(2500);
  await evaluate(`(() => {
    window.__lat = [];
    document.addEventListener('keydown', e => { const ts = e.timeStamp; requestAnimationFrame(() => requestAnimationFrame(() => window.__lat.push(performance.now() - ts))); }, true);
    const ed = document.querySelector('.ProseMirror').editor; let pos = null;
    ed.state.doc.descendants((n, p) => { if (pos === null && n.isTextblock && n.textContent.startsWith('Our roadmap needs')) pos = p + n.nodeSize - 1; });
    ed.commands.setTextSelection(pos); ed.commands.focus(); return pos; })()`);
  for (let i = 0; i < 60; i++) {
    await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a", windowsVirtualKeyCode: 65 });
    await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    await sleep(70);
  }
  await sleep(500);
  const lat: number[] = (await evaluate("window.__lat")).sort((a: number, b: number) => a - b);
  const q = (p: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * p))].toFixed(1);
  console.log(`${label.padEnd(28)} n=${lat.length} p50=${q(0.5)}ms p90=${q(0.9)}ms max=${q(1)}ms`);
  ws.close();
} finally {
  app.kill();
}
