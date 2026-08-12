import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { connectRfbAttachment, type RfbAttachment } from "./attachment.js";
import { createRfbClientMessageFilter } from "./rfb-view-only-filter.js";
import type { DesktopSessionRegistry } from "./session-registry.js";

export const DESKTOP_OBSERVE_PATH = "/desktop/observe";
const TOKEN_TTL_MS = 60_000;
const TOKEN_PATTERN = /^[a-f0-9]{48}$/u;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_CHECK_MS = 25;

type DesktopObserverTokenEntry = {
  sourceKey: string;
  ownerEpoch: number;
  control: boolean;
  attachment: RfbAttachment;
  expiresAt: number;
};

const observerTokens = new Map<string, DesktopObserverTokenEntry>();
const desktopObserverWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

function pruneDesktopObserverTokens(nowMs: number): void {
  for (const [token, entry] of observerTokens) {
    if (entry.expiresAt <= nowMs) {
      observerTokens.delete(token);
    }
  }
}

export function mintDesktopObserverToken(params: {
  sourceKey: string;
  ownerEpoch: number;
  control: boolean;
  attachment: RfbAttachment;
  nowMs?: number;
}): { token: string; expiresAtMs: number } {
  const nowMs = params.nowMs ?? Date.now();
  pruneDesktopObserverTokens(nowMs);
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAtMs = nowMs + TOKEN_TTL_MS;
  observerTokens.set(token, {
    sourceKey: params.sourceKey,
    ownerEpoch: params.ownerEpoch,
    control: params.control,
    attachment: params.attachment,
    expiresAt: expiresAtMs,
  });
  return { token, expiresAtMs };
}

function consumeDesktopObserverToken(
  token: string,
  nowMs = Date.now(),
): DesktopObserverTokenEntry | undefined {
  pruneDesktopObserverTokens(nowMs);
  const normalized = token.trim();
  if (!TOKEN_PATTERN.test(normalized)) {
    return undefined;
  }
  const entry = observerTokens.get(normalized);
  if (!entry) {
    return undefined;
  }
  observerTokens.delete(normalized);
  return entry.expiresAt > nowMs ? entry : undefined;
}

function writeUnauthorized(socket: Duplex): void {
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

function rawDataBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return Buffer.from(data);
}

/** Upgrades one authenticated observer token into a raw bidirectional RFB stream. */
export function handleDesktopObserveUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: {
    registry: Pick<DesktopSessionRegistry, "attachObserver">;
    getBufferedAmount?: (ws: WebSocket) => number;
  },
): boolean {
  const resource = new URL(req.url ?? "/", "http://127.0.0.1");
  if (resource.pathname !== DESKTOP_OBSERVE_PATH) {
    return false;
  }
  const token = resource.searchParams.get("token") ?? "";
  const entry = consumeDesktopObserverToken(token);
  if (!entry) {
    writeUnauthorized(socket);
    return true;
  }
  desktopObserverWss.handleUpgrade(req, socket, head, (ws) => {
    // View-only is enforced here at the RFB message boundary; the UI setting is only UX.
    const observer = deps.registry.attachObserver(entry.sourceKey, {
      control: entry.control,
      ownerEpoch: entry.ownerEpoch,
      close: (code, reason) => ws.close(code, reason),
    });
    if (!observer) {
      ws.close(1013, "desktop observer limit");
      return;
    }
    const desktopSocket = connectRfbAttachment(entry.attachment);
    const clientMessageFilter = entry.control ? undefined : createRfbClientMessageFilter();
    let closed = false;
    let resumeTimer: ReturnType<typeof setInterval> | undefined;

    const closeBoth = (code: number, reason: string) => {
      if (closed) {
        return;
      }
      closed = true;
      clearInterval(resumeTimer);
      resumeTimer = undefined;
      observer.release();
      desktopSocket.destroy();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(code, reason);
      }
    };

    ws.on("message", (data, isBinary) => {
      if (!isBinary || closed) {
        return;
      }
      const chunk = rawDataBuffer(data);
      if (!clientMessageFilter) {
        desktopSocket.write(chunk);
        return;
      }
      const result = clientMessageFilter.filter(chunk);
      if ("error" in result) {
        closeBoth(1008, "invalid view-only RFB stream");
        return;
      }
      if (result.forward.length > 0) {
        desktopSocket.write(result.forward);
      }
    });
    ws.once("close", () => closeBoth(1000, "desktop observer closed"));
    ws.once("error", () => closeBoth(1011, "desktop observer failed"));
    desktopSocket.on("data", (chunk) => {
      if (closed || ws.readyState !== WebSocket.OPEN) {
        return;
      }
      ws.send(chunk, { binary: true });
      const bufferedAmount = () => deps.getBufferedAmount?.(ws) ?? ws.bufferedAmount;
      if (bufferedAmount() <= PAUSE_BUFFERED_BYTES || resumeTimer) {
        return;
      }
      desktopSocket.pause();
      resumeTimer = setInterval(() => {
        if (bufferedAmount() <= PAUSE_BUFFERED_BYTES) {
          clearInterval(resumeTimer);
          resumeTimer = undefined;
          desktopSocket.resume();
        }
      }, RESUME_CHECK_MS);
      resumeTimer.unref?.();
    });
    desktopSocket.once("close", () => closeBoth(1000, "desktop stream closed"));
    desktopSocket.once("error", () => closeBoth(1011, "desktop stream failed"));
  });
  return true;
}
