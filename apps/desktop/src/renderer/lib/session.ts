import { reviewerName } from "./connection";
import * as Y from "yjs";
import { WebsocketProvider } from "y-websocket";
import { wsUrl, type Connection } from "./connection";

export type ReviewEntry = Record<string, unknown>;

export interface UserInfo {
  name: string;
  color: string;
  kind: "human" | "agent";
}

export const ME: UserInfo = { name: reviewerName(), color: "#2f7de1", kind: "human" };

/** One live connection to a document: the Y.Doc, its provider and the shared review maps. */
export interface Session {
  ydoc: Y.Doc;
  provider: WebsocketProvider;
  comments: Y.Map<ReviewEntry>;
  suggestions: Y.Map<ReviewEntry>;
  destroy(): void;
}

export function createSession(conn: Connection): Session {
  const ydoc = new Y.Doc();
  const provider = new WebsocketProvider(wsUrl(conn), conn.docId, ydoc, {
    params: { token: conn.token },
  });
  provider.awareness.setLocalStateField("user", ME);
  return {
    ydoc,
    provider,
    comments: ydoc.getMap<ReviewEntry>("comments"),
    suggestions: ydoc.getMap<ReviewEntry>("suggestions"),
    destroy() {
      provider.destroy();
      ydoc.destroy();
    },
  };
}
