import DOMPurify from "dompurify";
import { mmdToHtml } from "@tandem/core/html";
import { resolveConnection } from "../lib/connection";
import { fileUrl } from "./mmd-render";

/**
 * `{{file}}`: the included file, read-only, from the document's folder (the
 * service refuses anything outside it). Rendered as Markdown and sanitized,
 * since it is someone's file, not ours. "Open" opens it in Tandem.
 */
export function renderIncluded(target: string): HTMLElement {
  const box = document.createElement("div");
  box.className = "mmd-include";
  box.contentEditable = "false";
  const bar = document.createElement("div");
  bar.className = "mmd-include__bar";
  const name = document.createElement("span");
  name.className = "mmd-include__name";
  name.textContent = `⧉ ${target}`;
  bar.append(name);
  const body = document.createElement("div");
  body.className = "mmd-include__body tandem-prose";
  body.textContent = "Loading…";
  box.append(bar, body);

  void fetch(fileUrl(target))
    .then(async (res) => {
      if (!res.ok) {
        const reason = ((await res.json().catch(() => ({}))) as { error?: string }).error ?? res.statusText;
        throw new Error(reason);
      }
      const abs = decodeURIComponent(res.headers.get("X-Tandem-Path") ?? "");
      const text = await res.text();
      const isMarkdown = /markdown/.test(res.headers.get("Content-Type") ?? "");
      body.innerHTML = isMarkdown
        ? DOMPurify.sanitize(mmdToHtml(text, { imageSrc: (src) => fileUrl(relativeTo(target, src)) }))
        : `<pre>${text.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</pre>`;
      if (abs && isMarkdown) bar.insertBefore(openButton(abs), bar.children[1] ?? null);
    })
    .catch((err: Error) => {
      body.textContent = `Can't include this file: ${err.message}`;
      box.classList.add("is-error");
    });
  return box;
}

/** An image path inside an included file is relative to that file. */
function relativeTo(target: string, src: string): string {
  if (/^(?:[a-z][\w+.-]*:|\/)/i.test(src)) return src;
  const dir = target.includes("/") ? target.slice(0, target.lastIndexOf("/") + 1) : "";
  return dir + src;
}

function openButton(path: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "mmd-chip-btn";
  b.textContent = "Open";
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const conn = resolveConnection();
    if (!conn) return;
    void fetch(`${conn.baseUrl}/api/open`, {
      method: "POST",
      headers: { Authorization: `Bearer ${conn.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ path, show: true }),
    });
  });
  return b;
}
