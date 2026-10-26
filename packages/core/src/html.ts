import { Marked, type Token, type Tokens } from "marked";
import {
  mmdExtensions,
  mmdSlug,
  type MmdDefListToken,
  type MmdDirectiveToken,
  type MmdMathBlockToken,
  type MmdMathToken,
  type MmdNoteDefToken,
  type MmdRefToken,
  type MmdScriptToken,
  type MmdTableToken,
} from "./mmd";

export interface MmdHtmlOptions {
  /** TeX → HTML (KaTeX in the app and PDF export). Without it, math is shown as code. */
  math?: (tex: string, display: boolean) => string;
  /** `{{file}}` → HTML of the included file, or null to show a placeholder. */
  transclude?: (target: string) => string | null;
  /** Rewrites relative image sources (e.g. to the service's file endpoint). */
  imageSrc?: (src: string) => string;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Markdown + MultiMarkdown → HTML: footnotes (numbered, listed at the end),
 * math, definition lists, MMD tables with spans and captions, sub/superscript,
 * cross-references to headings, citations, abbreviations, `{{TOC}}` and
 * `{{file}}`. Used for PDF export and for showing included files.
 */
export function mmdToHtml(markdown: string, opts: MmdHtmlOptions = {}): string {
  const md = new Marked({ gfm: true });
  md.use({ extensions: mmdExtensions });
  const tokens = md.lexer(markdown);

  const headings: Array<{ depth: number; text: string; id: string }> = [];
  const notes = new Map<string, Token[]>();
  const abbrs = new Map<string, string>();
  const order: string[] = [];
  const linkDefs = new Map<string, string>();
  for (const m of markdown.matchAll(/^ {0,3}\[([^\]^]+)\]:\s*<?(\S+?)>?(?:\s|$)/gm)) linkDefs.set(m[1].trim().toLowerCase(), m[2]);
  md.walkTokens(tokens, (t) => {
    if (t.type === "heading") {
      const h = t as Tokens.Heading;
      const label = (h.tokens ?? []).find((x) => x.type === "mmdRef" && (x as unknown as MmdRefToken).kind === "ref" && /^\[[^\]]+\]$/.test(x.raw));
      const text = (h.tokens ?? []).filter((x) => x !== label).map((x) => x.raw).join("").trim();
      headings.push({ depth: h.depth, text, id: label ? mmdSlug((label as unknown as MmdRefToken).label) : mmdSlug(text) });
    } else if (t.type === "mmdNoteDef") {
      const n = t as unknown as MmdNoteDefToken;
      if (n.kind === "footnote") notes.set(n.label, n.tokens);
      if (n.kind === "abbr") abbrs.set(n.label, n.text);
    } else if (t.type === "mmdRef") {
      const r = t as unknown as MmdRefToken;
      if (r.kind === "footnote" && !order.includes(r.label)) order.push(r.label);
    }
  });
  let headingAt = 0;

  md.use({
    renderer: {
      heading({ tokens: inner, depth }) {
        const h = headings[headingAt++];
        // A trailing `[label]` names the heading; it isn't shown.
        const last = inner.at(-1);
        const shown = last?.type === "mmdRef" && /^\[[^\]]+\]$/.test(last.raw) ? inner.slice(0, -1) : inner;
        return `<h${depth} id="${esc(h?.id ?? "")}">${this.parser.parseInline(shown).trimEnd()}</h${depth}>\n`;
      },
    },
    extensions: [
      {
        name: "mmdRef",
        renderer(t) {
          const r = t as unknown as MmdRefToken;
          switch (r.kind) {
            case "footnote": {
              const n = order.indexOf(r.label) + 1;
              return `<sup class="fn-ref" id="fnref-${esc(r.label)}"><a href="#fn-${esc(r.label)}">${n || "?"}</a></sup>`;
            }
            case "citation":
              return `<span class="cite">[${esc(r.label)}${r.text ? `, ${esc(r.text)}` : ""}]</span>`;
            case "abbr":
            case "glossary":
              return `<abbr title="${esc(abbrs.get(r.label) ?? "")}">${esc(r.label)}</abbr>`;
            case "label":
              return "";
            case "image": {
              const m = /^!\[([^\]]*)\]\(\s*<?([^\s)>]+)>?(?:\s+"([^"]*)")?([^)]*)\)/.exec(r.raw);
              if (!m) return esc(r.raw);
              const dims = [...(m[4] ?? "").matchAll(/(width|height)=(?:"([^"]*)"|(\S+))/g)]
                .map((a) => `${a[1]}:${/^\d+$/.test(a[2] ?? a[3]) ? `${a[2] ?? a[3]}px` : (a[2] ?? a[3])}`)
                .join(";");
              const src = opts.imageSrc ? opts.imageSrc(m[2]) : m[2];
              return `<img src="${esc(src)}" alt="${esc(m[1])}"${m[3] ? ` title="${esc(m[3])}"` : ""}${dims ? ` style="${esc(dims)}"` : ""}>`;
            }
            case "transclude":
              return `<span class="transclude">${esc(r.label)}</span>`;
            default: {
              // Heading heading label, then link definition, else plain text as written.
              const id = mmdSlug(r.label);
              const text = /^\[((?:[^\[\]]|\[[^\]]*\])+)\]/.exec(r.raw)?.[1] ?? r.raw;
              if (headings.some((h) => h.id === id)) return `<a href="#${esc(id)}">${esc(text)}</a>`;
              const href = linkDefs.get(r.label.trim().toLowerCase());
              return href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(r.raw);
            }
          }
        },
      },
      {
        name: "mmdSub",
        renderer(t) {
          return `<sub>${this.parser.parseInline((t as unknown as MmdScriptToken).tokens)}</sub>`;
        },
      },
      {
        name: "mmdSup",
        renderer(t) {
          return `<sup>${this.parser.parseInline((t as unknown as MmdScriptToken).tokens)}</sup>`;
        },
      },
      {
        name: "mmdMath",
        renderer(t) {
          const m = t as unknown as MmdMathToken;
          return opts.math ? opts.math(m.tex, false) : `<code class="math">${esc(m.tex)}</code>`;
        },
      },
      {
        name: "mmdMathBlock",
        renderer(t) {
          const m = t as unknown as MmdMathBlockToken;
          return `<div class="math-display">${opts.math ? opts.math(m.tex, true) : `<pre><code>${esc(m.tex)}</code></pre>`}</div>\n`;
        },
      },
      {
        name: "mmdNoteDef",
        renderer(t) {
          const n = t as unknown as MmdNoteDefToken;
          // Footnotes are listed at the end; abbreviations only supply titles.
          if (n.kind !== "glossary") return "";
          return `<dl class="glossary"><dt>${esc(n.label)}</dt><dd>${this.parser.parseInline(n.tokens)}</dd></dl>\n`;
        },
      },
      {
        name: "mmdDefList",
        renderer(t) {
          const d = t as unknown as MmdDefListToken;
          const items = d.items.map((i) => (i.kind === "term" ? `<dt>${this.parser.parseInline(i.tokens)}</dt>` : `<dd>${this.parser.parseInline(i.tokens)}</dd>`));
          return `<dl>${items.join("")}</dl>\n`;
        },
      },
      {
        name: "mmdTable",
        renderer(t) {
          const tb = t as unknown as MmdTableToken;
          const row = (cells: MmdTableToken["rows"][number], tag: "th" | "td") => {
            let col = 0;
            const out = cells.map((c) => {
              const align = tb.aligns[col];
              col += c.colspan;
              const attrs = `${c.colspan > 1 ? ` colspan="${c.colspan}"` : ""}${align ? ` style="text-align:${align}"` : ""}`;
              return `<${tag}${attrs}>${this.parser.parseInline(c.tokens)}</${tag}>`;
            });
            return `<tr>${out.join("")}</tr>`;
          };
          const caption = tb.caption ? `<caption>${esc(tb.caption)}</caption>` : "";
          return `<table>${caption}<thead>${tb.header.map((r) => row(r, "th")).join("")}</thead><tbody>${tb.rows.map((r) => row(r, "td")).join("")}</tbody></table>\n`;
        },
      },
      {
        name: "mmdToc",
        renderer() {
          const top = Math.min(6, ...headings.map((h) => h.depth));
          const items = headings.map((h) => `<li style="margin-left:${(h.depth - top) * 1.2}em"><a href="#${esc(h.id)}">${esc(h.text)}</a></li>`);
          return `<nav class="toc"><ul>${items.join("")}</ul></nav>\n`;
        },
      },
      {
        name: "mmdTransclusion",
        renderer(t) {
          const d = t as unknown as MmdDirectiveToken;
          const html = opts.transclude?.(d.target);
          return html ?? `<p class="transclude">[${esc(d.target)}]</p>\n`;
        },
      },
    ],
  });

  let html = md.parser(tokens);
  if (order.length) {
    const items = order.map((label) => {
      const body = notes.has(label) ? md.parseInline(notes.get(label)!.map((x) => x.raw).join("")) : "";
      return `<li id="fn-${esc(label)}">${body} <a href="#fnref-${esc(label)}" class="fn-back">↩</a></li>`;
    });
    html += `<section class="footnotes"><hr><ol>${items.join("")}</ol></section>\n`;
  }
  return html;
}
