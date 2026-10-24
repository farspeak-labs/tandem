import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BrowserWindow } from "electron";
import { marked } from "marked";

/**
 * Prints a clean copy (Markdown, markup already removed) to a Letter PDF.
 * ```mermaid blocks are drawn as diagrams with the bundled Mermaid script.
 */
export async function renderPdf(title: string, clean: string, paths: { mermaidJs: string; tempDir: string }): Promise<Buffer> {
  const diagrams = /^\s*(`{3,}|~{3,})\s*mermaid\s*$/im.test(clean);
  let head = "";
  if (diagrams) {
    // Only the bundled Mermaid script may run (pinned by hash); scripts a document embeds stay inert.
    const script = readFileSync(paths.mermaidJs, "utf8").replace(/<\/script/gi, "<\\/script");
    const hash = createHash("sha256").update(script).digest("base64");
    head = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${hash}'; style-src 'unsafe-inline'; img-src data:; font-src data:"><script>${script}</script>`;
  }
  const html = `<!doctype html><meta charset="utf-8">${head}<title>${title.replace(/</g, "&lt;")}</title>
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
  .diagram { margin: 1em 0; text-align: center; break-inside: avoid; }
  .diagram svg { max-width: 100%; height: auto; }
</style>${marked.parse(clean.replace(/^---\n[\s\S]*?\n---\n/, ""))}`;
  const printer = new BrowserWindow({ show: false, webPreferences: { sandbox: true, javascript: diagrams } });
  try {
    if (diagrams) {
      // Too big for a data: URL, so the page goes through a temp file.
      const page = join(paths.tempDir, `tandem-export-${process.pid}.html`);
      writeFileSync(page, html);
      try {
        await printer.loadFile(page);
        // A diagram that fails to parse prints as its code.
        await printer.webContents.executeJavaScript(`(async () => {
          mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: "default" });
          let n = 0;
          for (const code of document.querySelectorAll("pre > code.language-mermaid")) {
            try {
              const { svg } = await mermaid.render("diagram-" + ++n, code.textContent);
              code.parentElement.outerHTML = '<div class="diagram">' + svg + "</div>";
            } catch {
              document.getElementById("ddiagram-" + n)?.remove();
            }
          }
        })()`);
      } finally {
        rmSync(page, { force: true });
      }
    } else {
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    }
    return await printer.webContents.printToPDF({ pageSize: "Letter", printBackground: true, margins: { marginType: "default" } });
  } finally {
    printer.destroy();
  }
}
