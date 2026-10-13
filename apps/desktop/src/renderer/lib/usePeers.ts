import { useEffect, useState } from "react";
import type { Session, UserInfo } from "./session";

/** Other clients' awareness users (agents and people), deduplicated by name. */
export function usePeers(session: Session): UserInfo[] {
  const [peers, setPeers] = useState<UserInfo[]>([]);
  useEffect(() => {
    const { awareness } = session.provider;
    const update = () => {
      const seen = new Map<string, UserInfo>();
      awareness.getStates().forEach((state, clientId) => {
        if (clientId === awareness.clientID) return;
        const u = state.user as UserInfo | undefined;
        if (u?.name && !seen.has(u.name)) seen.set(u.name, u);
      });
      setPeers([...seen.values()]);
    };
    awareness.on("change", update);
    update();
    return () => awareness.off("change", update);
  }, [session]);
  return peers;
}
