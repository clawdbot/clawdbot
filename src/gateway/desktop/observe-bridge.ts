import crypto from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { connectRfbAttachment, type DesktopRfbAttachment } from "./attachment.js";
import {
  preauthenticateRfb,
  RfbPreauthBuffer,
  type RfbPreauthDescriptor,
  type RfbPreauthPeer,
  RfbPreauthTimeoutError,
} from "./rfb-preauth.js";
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
  attachment: DesktopRfbAttachment;
  preauth?: RfbPreauthDescriptor;
  expiresAt: number;
};

const observerTokens = new Map<string, DesktopObserverTokenEntry>();
const observerTokenExpiryTimers = new Map<string, ReturnType<typeof setTimeout>>();
const desktopObserverWss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });

function deleteDesktopObserverToken(token: string): void {
  observerTokens.delete(token);
  const expiryTimer = observerTokenExpiryTimers.get(token);
  if (expiryTimer) {
    clearTimeout(expiryTimer);
    observerTokenExpiryTimers.delete(token);
  }
}

function pruneDesktopObserverTokens(nowMs: number): void {
  for (const [token, entry] of observerTokens) {
    if (entry.expiresAt <= nowMs) {
      deleteDesktopObserverToken(token);
    }
  }
}

export function mintDesktopObserverToken(params: {
  sourceKey: string;
  ownerEpoch: number;
  control: boolean;
  attachment: DesktopRfbAttachment;
  preauth?: RfbPreauthDescriptor;
  nowMs?: number;
}): { token: string; expiresAtMs: number } {
  const nowMs = params.nowMs ?? Date.now();
  pruneDesktopObserverTokens(nowMs);
  const token = crypto.randomBytes(24).toString("hex");
  const expiresAtMs = nowMs + TOKEN_TTL_MS;
  const entry: DesktopObserverTokenEntry = {
    sourceKey: params.sourceKey,
    ownerEpoch: params.ownerEpoch,
    control: params.control,
    attachment: params.attachment,
    ...(params.preauth ? { preauth: params.preauth } : {}),
    expiresAt: expiresAtMs,
  };
  observerTokens.set(token, entry);
  const expiryTimer = setTimeout(() => {
    observerTokens.delete(token);
    observerTokenExpiryTimers.delete(token);
  }, TOKEN_TTL_MS);
  expiryTimer.unref?.();
  observerTokenExpiryTimers.set(token, expiryTimer);
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
  deleteDesktopObserverToken(normalized);
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

class WebSocketPreauthPeer implements RfbPreauthPeer {
  private readonly reader = new RfbPreauthBuffer();
  private readonly onMessage = (data: RawData, isBinary: boolean) => {
    if (!isBinary) {
      this.reader.fail(new Error("RFB browser sent a non-binary handshake frame"));
    } else {
      this.reader.push(rawDataBuffer(data));
    }
  };
  private readonly onClose = () => {
    this.reader.fail(new Error("RFB browser closed during authentication negotiation"));
  };
  private readonly onError = () => {
    this.reader.fail(new Error("RFB browser failed during authentication negotiation"));
  };

  constructor(private readonly ws: WebSocket) {
    ws.on("message", this.onMessage);
    ws.once("close", this.onClose);
    ws.once("error", this.onError);
  }

  async readExactly(length: number, signal: AbortSignal): Promise<Buffer> {
    return await this.reader.readExactly(length, signal);
  }

  async write(buffer: Buffer, signal: AbortSignal): Promise<void> {
    if (signal.aborted) {
      throw signal.reason;
    }
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => signal.removeEventListener("abort", onAbort);
      const onAbort = () => {
        cleanup();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("RFB authentication negotiation aborted"),
        );
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.ws.send(buffer, { binary: true }, (error) => {
        cleanup();
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
  }

  detach(): Buffer {
    this.ws.off("message", this.onMessage);
    this.ws.off("close", this.onClose);
    this.ws.off("error", this.onError);
    return this.reader.takeBuffered();
  }
}

/** Upgrades one authenticated observer token into a raw bidirectional RFB stream. */
export function handleDesktopObserveUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  deps: {
    registry: Pick<DesktopSessionRegistry, "attachObserver" | "claimStream">;
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
    const claimedStream =
      entry.attachment.kind === "stream" ? deps.registry.claimStream(entry.attachment) : undefined;
    if (entry.attachment.kind === "stream" && !claimedStream) {
      ws.close(1013, "desktop stream unavailable");
      return;
    }
    // View-only is enforced here at the RFB message boundary; the UI setting is only UX.
    const observer = deps.registry.attachObserver(entry.sourceKey, {
      control: entry.control,
      ownerEpoch: entry.ownerEpoch,
      close: (code, reason) => ws.close(code, reason),
    });
    if (!observer) {
      claimedStream?.destroy();
      ws.close(1013, "desktop observer limit");
      return;
    }
    const desktopSocket =
      entry.attachment.kind === "stream" ? claimedStream : connectRfbAttachment(entry.attachment);
    if (!desktopSocket) {
      observer.release();
      ws.close(1013, "desktop stream unavailable");
      return;
    }
    let closed = false;
    let negotiating = Boolean(entry.preauth);
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

    const startSplice = (browserRemainder: Buffer = Buffer.alloc(0), preauthenticated = false) => {
      const clientMessageFilter = entry.control
        ? undefined
        : createRfbClientMessageFilter({
            startPhase: preauthenticated ? "clientInit" : "version",
          });
      const forwardClientChunk = (chunk: Buffer) => {
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
      };
      ws.on("message", (data, isBinary) => {
        if (!isBinary || closed) {
          return;
        }
        forwardClientChunk(rawDataBuffer(data));
      });
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
      if (browserRemainder.length > 0) {
        forwardClientChunk(browserRemainder);
      }
    };

    ws.once("close", () => closeBoth(1000, "desktop observer closed"));
    ws.once("error", () => closeBoth(1011, "desktop observer failed"));
    desktopSocket.once("close", () => closeBoth(1000, "desktop stream closed"));
    desktopSocket.once("error", () =>
      closeBoth(
        negotiating ? 1008 : 1011,
        negotiating ? "desktop authentication failed" : "desktop stream failed",
      ),
    );

    if (!entry.preauth) {
      startSplice();
      return;
    }

    const preauth = entry.preauth;
    const browser = new WebSocketPreauthPeer(ws);
    void (async () => {
      try {
        await preauthenticateRfb({ server: desktopSocket, browser, preauth });
        const remainder = browser.detach();
        entry.preauth = undefined;
        negotiating = false;
        if (!closed) {
          startSplice(remainder, true);
        }
      } catch (error) {
        browser.detach();
        entry.preauth = undefined;
        closeBoth(
          1008,
          error instanceof RfbPreauthTimeoutError
            ? "desktop authentication timed out"
            : `desktop ${preauth.auth === "ard-account" ? "ARD" : "VNC"} authentication failed`,
        );
      }
    })();
  });
  return true;
}
