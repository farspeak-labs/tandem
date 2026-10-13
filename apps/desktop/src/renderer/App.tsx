import { useEffect, useMemo, useState } from "react";
import { TandemApi } from "./lib/api";
import { resolveConnection, resolveServiceConnection, resolveView } from "./lib/connection";
import { LibraryApi } from "./lib/library-api";
import { createSession, type Session } from "./lib/session";
import { Workspace } from "./components/Workspace";
import { Library } from "./components/library/Library";

export function App() {
  return resolveView() === "library" ? <LibraryApp /> : <DocApp />;
}

function LibraryApp() {
  const api = useMemo(() => {
    const conn = resolveServiceConnection();
    return conn ? new LibraryApi(conn) : null;
  }, []);
  if (!api) {
    return (
      <div className="empty-state">
        <h1>Library unavailable</h1>
        <p>
          Couldn’t find the Tandem service. In dev, pass <code>?baseUrl=&amp;token=&amp;view=library</code>.
        </p>
      </div>
    );
  }
  return <Library api={api} />;
}

function DocApp() {
  const conn = useMemo(resolveConnection, []);
  const api = useMemo(() => (conn ? new TandemApi(conn) : null), [conn]);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!conn) return;
    const s = createSession(conn);
    setSession(s);
    return () => s.destroy();
  }, [conn]);

  if (!conn || !api) {
    return (
      <div className="empty-state">
        <h1>No document</h1>
        <p>
          Open a file with <code>tandem open plan.md</code>, or pass <code>?baseUrl=&amp;token=&amp;docId=</code> in dev.
        </p>
      </div>
    );
  }
  if (!session) return null;
  return <Workspace key={conn.docId} session={session} api={api} />;
}
