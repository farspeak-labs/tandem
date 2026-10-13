import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryApi } from "./library-api";
import { queryToParams, type Facets, type LibraryDoc, type LibraryQuery } from "./library";

const REFRESH_MS = 30_000;

export interface LibraryData {
  docs: LibraryDoc[] | null;
  facets: Facets | null;
  /** True while a request for a different filter is in flight (the shown list is stale). */
  loading: boolean;
  error: string | null;
  refresh(): void;
}

/** Docs for a filter + sidebar facets; refreshes on window focus, every 30 s and on demand. */
export function useLibrary(api: LibraryApi, query: LibraryQuery): LibraryData {
  const [docs, setDocs] = useState<{ key: string; list: LibraryDoc[] } | null>(null);
  const [facets, setFacets] = useState<Facets | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const key = queryToParams(query).toString();
  const queryRef = useRef(query);
  queryRef.current = query;

  const refresh = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([api.list(queryRef.current, controller.signal), api.facets(controller.signal)])
      .then(([list, f]) => {
        setDocs({ key, list });
        setFacets(f);
        setError(null);
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) setError(e instanceof Error ? e.message : "Couldn't load the library");
      });
    return () => controller.abort();
  }, [api, key, tick]);

  useEffect(() => {
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(timer);
    };
  }, [refresh]);

  return { docs: docs?.list ?? null, facets, loading: !docs || docs.key !== key, error, refresh };
}
