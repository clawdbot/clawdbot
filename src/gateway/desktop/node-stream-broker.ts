import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { createWebSocketStream, WebSocket, WebSocketServer, type RawData } from "ws";
import { registerSecretValueForRedaction } from "../../logging/secret-redaction-registry.js";
import { NODE_DESKTOP_ATTACH_PATH } from "../../shared/node-desktop-stream.js";
import type { NodeRegistry } from "../node-registry.js";

const DEFAULT_TICKET_TTL_MS = 60_000;
const TICKET_PATTERN = /^[a-f0-9]{48}$/u;
const MAX_ATTACH_FRAME_BYTES = 64 * 1024;

type NodeDesktopStreamMetadata = {
  auth: "vnc-password" | "ard-account";
  vncPassword?: string;
};

type AttachedNodeDesktopStream = NodeDesktopStreamMetadata & { stream: Duplex };

type NodeDesktopStreamBinding = {
  nodeId: string;
  connId: string;
  pairingGeneration: string;
};

type TicketEntry = {
  binding: NodeDesktopStreamBinding;
  expiresAtMs: number;
  resolve: (attached: AttachedNodeDesktopStream) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  redeemed: boolean;
  settled: boolean;
  socket?: Duplex;
  ws?: WebSocket;
};

type TicketNodeRegistry = Pick<
  NodeRegistry,
  "getForPairingGeneration" | "isConnectionCurrentPairingState"
>;

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

function parseStreamMetadata(data: RawData, isBinary: boolean): NodeDesktopStreamMetadata {
  const buffer = rawDataBuffer(data);
  if (!isBinary || buffer.length === 0 || buffer.length > MAX_ATTACH_FRAME_BYTES) {
    throw new Error("invalid node desktop attach metadata");
  }
  let value: unknown;
  try {
    value = JSON.parse(buffer.toString("utf8"));
  } catch {
    throw new Error("invalid node desktop attach metadata");
  }
  if (!isRecord(value) || (value.auth !== "vnc-password" && value.auth !== "ard-account")) {
    throw new Error("invalid node desktop attach metadata");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => key !== "auth" && key !== "vncPassword")) {
    throw new Error("invalid node desktop attach metadata");
  }
  if (value.vncPassword !== undefined && typeof value.vncPassword !== "string") {
    throw new Error("invalid node desktop attach metadata");
  }
  if (value.auth === "ard-account" && value.vncPassword !== undefined) {
    throw new Error("invalid node desktop attach metadata");
  }
  const vncPassword = typeof value.vncPassword === "string" ? value.vncPassword : undefined;
  if (vncPassword) {
    registerSecretValueForRedaction(vncPassword);
  }
  return { auth: value.auth, ...(vncPassword ? { vncPassword } : {}) };
}

function writeUnauthorized(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function readAttachedStream(
  ws: WebSocket,
  onStreamError: (error: Error) => void,
): Promise<{ metadata: NodeDesktopStreamMetadata; stream: Duplex }> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      ws.off("message", onMessage);
      ws.off("close", onClose);
    };
    const onMessage = (data: RawData, isBinary: boolean) => {
      cleanup();
      try {
        const metadata = parseStreamMetadata(data, isBinary);
        // Install the stream listener in the same message turn. The pairing
        // recheck may yield, but early RFB banner bytes must already be buffered.
        const stream = createWebSocketStream(ws, { allowHalfOpen: false });
        // Retain a safety listener through the asynchronous registry handoff;
        // the observer bridge adds its own lifecycle handler after claiming it.
        stream.on("error", onStreamError);
        resolve({
          metadata,
          stream,
        });
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    };
    const onClose = () => {
      cleanup();
      reject(new Error("node desktop stream closed before attach"));
    };
    const onError = (error: Error) => {
      cleanup();
      onStreamError(error);
      reject(error);
    };
    ws.once("message", onMessage);
    ws.once("close", onClose);
    // Keep this listener for the WebSocket lifetime. Invalid metadata never
    // creates a Duplex, so it remains the terminal protocol-error guard.
    ws.on("error", onError);
  });
}

/** Owns one-time node stream tickets and turns redeemed WebSockets into RFB duplexes. */
export function createNodeDesktopStreamBroker(deps: { ttlMs?: number; now?: () => number } = {}) {
  const ttlMs = deps.ttlMs ?? DEFAULT_TICKET_TTL_MS;
  const now = deps.now ?? Date.now;
  const tickets = new Map<string, TicketEntry>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_ATTACH_FRAME_BYTES });

  const remove = (ticket: string): TicketEntry | undefined => {
    const entry = tickets.get(ticket);
    if (!entry) {
      return undefined;
    }
    tickets.delete(ticket);
    clearTimeout(entry.timer);
    return entry;
  };

  const rejectTicket = (ticket: string, error: Error): void => {
    const entry = remove(ticket);
    if (!entry || entry.settled) {
      return;
    }
    entry.settled = true;
    entry.reject(error);
    entry.ws?.close(1008, "node desktop attach rejected");
    entry.socket?.destroy();
  };

  const resolveTicket = (ticket: string, attached: AttachedNodeDesktopStream): void => {
    const entry = remove(ticket);
    if (!entry || entry.settled) {
      attached.stream.destroy();
      return;
    }
    entry.settled = true;
    entry.resolve(attached);
  };

  function mint(binding: NodeDesktopStreamBinding) {
    const ticket = crypto.randomBytes(24).toString("hex");
    const expiresAtMs = now() + ttlMs;
    let resolve!: (attached: AttachedNodeDesktopStream) => void;
    let reject!: (error: Error) => void;
    const attached = new Promise<AttachedNodeDesktopStream>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void attached.catch(() => undefined);
    const timer = setTimeout(() => {
      rejectTicket(ticket, new Error("node desktop stream ticket expired"));
    }, ttlMs);
    timer.unref?.();
    tickets.set(ticket, {
      binding,
      expiresAtMs,
      resolve,
      reject,
      timer,
      redeemed: false,
      settled: false,
    });
    return {
      ticket,
      attachPath: `${NODE_DESKTOP_ATTACH_PATH}?ticket=${ticket}`,
      expiresAtMs,
      attached,
      cancel() {
        rejectTicket(ticket, new Error("node desktop stream ticket cancelled"));
      },
    };
  }

  const bindingIsCurrent = async (
    registry: TicketNodeRegistry,
    binding: NodeDesktopStreamBinding,
  ): Promise<boolean> => {
    const current = registry.getForPairingGeneration(binding.nodeId, binding.pairingGeneration);
    if (!current || current.connId !== binding.connId) {
      return false;
    }
    if (!(await registry.isConnectionCurrentPairingState(binding.connId))) {
      return false;
    }
    const rechecked = registry.getForPairingGeneration(binding.nodeId, binding.pairingGeneration);
    return rechecked?.connId === binding.connId;
  };

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    registry: TicketNodeRegistry,
  ): Promise<boolean> {
    const resource = new URL(req.url ?? "/", "http://127.0.0.1");
    if (resource.pathname !== NODE_DESKTOP_ATTACH_PATH) {
      return false;
    }
    const ticket = (resource.searchParams.get("ticket") ?? "").trim();
    if (!TICKET_PATTERN.test(ticket)) {
      writeUnauthorized(socket);
      return true;
    }
    const entry = tickets.get(ticket);
    if (!entry || entry.redeemed || entry.expiresAtMs <= now()) {
      writeUnauthorized(socket);
      if (entry && !entry.redeemed) {
        rejectTicket(ticket, new Error("node desktop stream ticket expired"));
      }
      return true;
    }
    entry.redeemed = true;
    entry.socket = socket;
    const onSocketError = (error: Error) => rejectTicket(ticket, error);
    const onSocketClose = () =>
      rejectTicket(ticket, new Error("node desktop attach closed during authorization"));
    socket.once("error", onSocketError);
    socket.once("end", onSocketClose);
    socket.once("close", onSocketClose);
    let current: boolean;
    try {
      current = await bindingIsCurrent(registry, entry.binding);
    } catch {
      current = false;
    }
    if (entry.settled) {
      return true;
    }
    if (!current) {
      socket.off("error", onSocketError);
      socket.off("end", onSocketClose);
      socket.off("close", onSocketClose);
      writeUnauthorized(socket);
      rejectTicket(ticket, new Error("node desktop stream ticket binding is stale"));
      return true;
    }
    socket.off("error", onSocketError);
    socket.off("end", onSocketClose);
    socket.off("close", onSocketClose);
    try {
      wss.handleUpgrade(req, socket, head, (ws) => {
        entry.socket = undefined;
        entry.ws = ws;
        const attached = readAttachedStream(ws, (error) => rejectTicket(ticket, error));
        void (async () => {
          try {
            const resolved = await attached;
            if (!(await bindingIsCurrent(registry, entry.binding))) {
              throw new Error("node desktop stream ticket binding is stale");
            }
            resolveTicket(ticket, {
              ...resolved.metadata,
              stream: resolved.stream,
            });
          } catch (error) {
            rejectTicket(ticket, error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });
    } catch (error) {
      rejectTicket(ticket, error instanceof Error ? error : new Error(String(error)));
    }
    return true;
  }

  return { mint, handleUpgrade };
}

export type NodeDesktopStreamBroker = ReturnType<typeof createNodeDesktopStreamBroker>;
