import { useSyncExternalStore } from "react";
import type * as Y from "yjs";

/** Subscribes a component to a Y.Map, returning a plain-object snapshot that changes identity on update. */
export function useYMap<T>(map: Y.Map<T>): Record<string, T> {
  return useSyncExternalStore(
    (notify) => {
      map.observe(notify);
      return () => map.unobserve(notify);
    },
    () => snapshot(map),
  );
}

const cache = new WeakMap<object, { version: number; value: Record<string, unknown> }>();
const versions = new WeakMap<object, number>();

function snapshot<T>(map: Y.Map<T>): Record<string, T> {
  // useSyncExternalStore needs a stable value between updates; key the cache on a version bumped by observe.
  let v = versions.get(map);
  if (v === undefined) {
    v = 0;
    versions.set(map, 0);
    map.observe(() => versions.set(map, (versions.get(map) ?? 0) + 1));
  }
  const hit = cache.get(map);
  if (hit && hit.version === v) return hit.value as Record<string, T>;
  const value = map.toJSON() as Record<string, T>;
  cache.set(map, { version: v, value });
  return value;
}
