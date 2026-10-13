import type { JSONNode } from "./parse";
import { tandemSchema } from "./schema";

/**
 * Content signature of a top-level node, ignoring `src`/`sig`.
 * Normalized through the schema so attribute defaults and mark order never
 * make an untouched node look edited (e.g. after a Yjs round trip).
 */
export function signature(node: JSONNode): string {
  const { src: _src, sig: _sig, ...attrs } = (node.attrs ?? {}) as Record<string, unknown>;
  let normalized: unknown;
  try {
    normalized = tandemSchema()
      .nodeFromJSON({ ...node, attrs })
      .toJSON();
    const n = normalized as { attrs?: Record<string, unknown> };
    if (n.attrs) {
      delete n.attrs.src;
      delete n.attrs.sig;
    }
  } catch {
    normalized = { ...node, attrs };
  }
  return fnv1a(JSON.stringify(normalized));
}

function fnv1a(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x5bd1e995);
  }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}
