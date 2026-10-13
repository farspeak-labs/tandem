import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import type { WebSocket } from "ws";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import type * as Y from "yjs";

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;

/** One live document shared over the y-websocket protocol. */
export class SyncRoom {
  readonly awareness: awarenessProtocol.Awareness;
  private conns = new Map<WebSocket, Set<number>>();

  constructor(readonly doc: Y.Doc) {
    this.awareness = new awarenessProtocol.Awareness(doc);
    this.awareness.setLocalState(null);

    doc.on("update", (update: Uint8Array) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      this.broadcast(encoding.toUint8Array(encoder));
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        const changed = [...added, ...updated, ...removed];
        const owner = origin as WebSocket | null;
        if (owner && this.conns.has(owner)) {
          const ids = this.conns.get(owner)!;
          for (const id of added) ids.add(id);
          for (const id of removed) ids.delete(id);
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.broadcast(encoding.toUint8Array(encoder));
      },
    );
  }

  get connectionCount(): number {
    return this.conns.size;
  }

  /** Awareness states of everyone connected (humans and agents). */
  presence(): Array<Record<string, unknown>> {
    return [...this.awareness.getStates().values()] as Array<Record<string, unknown>>;
  }

  connect(ws: WebSocket) {
    ws.binaryType = "arraybuffer";
    this.conns.set(ws, new Set());

    ws.on("message", (data: ArrayBuffer | Buffer) => {
      try {
        this.receive(ws, new Uint8Array(data as ArrayBuffer));
      } catch {
        ws.close();
      }
    });
    ws.on("close", () => this.disconnect(ws));

    // Start the handshake: our state vector, then current awareness.
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(encoder, this.doc);
    this.send(ws, encoding.toUint8Array(encoder));

    const states = this.awareness.getStates();
    if (states.size > 0) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]));
      this.send(ws, encoding.toUint8Array(enc));
    }
  }

  private receive(ws: WebSocket, message: Uint8Array) {
    const decoder = decoding.createDecoder(message);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
      if (encoding.length(encoder) > 1) this.send(ws, encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), ws);
    }
  }

  private disconnect(ws: WebSocket) {
    const ids = this.conns.get(ws);
    this.conns.delete(ws);
    if (ids?.size) awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], null);
  }

  private broadcast(message: Uint8Array) {
    for (const ws of this.conns.keys()) this.send(ws, message);
  }

  private send(ws: WebSocket, message: Uint8Array) {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(message, (err) => {
      if (err) this.disconnect(ws);
    });
  }

  closeAll() {
    for (const ws of this.conns.keys()) ws.close();
  }
}
