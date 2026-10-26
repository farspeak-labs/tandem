/** File extensions Tandem opens: Markdown and MultiMarkdown. */
export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mmd", "multimarkdown"];

const EXT = new RegExp(`\\.(?:${MARKDOWN_EXTENSIONS.join("|")})$`, "i");

export const isMarkdownPath = (path: string) => EXT.test(path);

/** `plan.md` → `plan`, `notes.mmd` → `notes`. */
export const stripMarkdownExt = (path: string) => path.replace(EXT, "");
