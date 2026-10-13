import { splitEndmatter } from "./segments";
import { resolveAll } from "./suggest";

/**
 * The plan as it would read with every suggestion accepted and all review
 * markup (comments, highlights, ids, endmatter) removed.
 */
export function cleanCopy(markdown: string): string {
  const { body } = splitEndmatter(markdown);
  return resolveAll(body, true)
    .replace(/\{==([\s\S]*?)==\}((?:\{>>[\s\S]*?<<\})*)(\{#[\w-]+\}|\{(?:[a-zA-Z_][\w-]*="[^"]*"\s*)+\})?/g, "$1")
    .replace(/\{>>[\s\S]*?<<\}(\{#[\w-]+\}|\{(?:[a-zA-Z_][\w-]*="[^"]*"\s*)+\})?/g, "")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n");
}
