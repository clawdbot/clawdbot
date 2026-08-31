import type { lookup as dnsLookupCb } from "node:dns";
import { asOptionalRecord, readStringField } from "openclaw/plugin-sdk/string-coerce-runtime";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import WebSocket from "ws";
import { formatErrorMessage } from "../infra/errors.js";
import { isWebSocketUrl, openCdpWebSocket } from "./cdp.helpers.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
type CdpSocketLookup = typeof dnsLookupCb;
// Playwright allocates positive command IDs and reserves -9999 for Browser.close.
// Keep transport-owned replies below that range so Playwright never consumes them.
const FIRST_INTERNAL_COMMAND_ID = -10_000;

// Playwright's browser-root handler requires browserContextId for non-browser targets.
// Release only those root targets; nested sessions belong to Playwright's frame handler.
function contextlessTargetSession(message: Record<string, unknown>): string | undefined {
  if (readStringField(message, "method") !== "Target.attachedToTarget") {
    return undefined;
  }
  const params = asOptionalRecord(message.params);
  const targetInfo = asOptionalRecord(params?.targetInfo);
  if (
    readStringField(message, "sessionId") ||
    readStringField(targetInfo, "type") === "browser" ||
    readStringField(targetInfo, "browserContextId")
  ) {
    return undefined;
  }
  return readStringField(params, "sessionId");
}

type CdpTransportOptions = {
  timeout: number;
  headers: Record<string, string>;
  lookup?: CdpSocketLookup;
  resolveWebSocketUrl?: () => Promise<string | undefined>;
  preparedTransport?: ConnectOverCDPTransport;
};

async function openCdpTransportSocket(
  connectionUrl: string,
  opts: CdpTransportOptions,
): Promise<ConnectOverCDPTransport> {
  const resolvedConnectionUrl = isWebSocketUrl(connectionUrl)
    ? connectionUrl
    : await opts.resolveWebSocketUrl?.();
  if (!resolvedConnectionUrl) {
    throw new Error("CDP endpoint did not expose a usable WebSocket URL.");
  }
  const ws = openCdpWebSocket(resolvedConnectionUrl, {
    headers: opts.headers,
    handshakeTimeoutMs: opts.timeout,
    lookup: opts.lookup,
    playwrightTransportDefaults: true,
  });
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", reject);
      ws.once("close", () => reject(new Error("CDP socket closed")));
    });
  } catch (error) {
    ws.close();
    throw error;
  }
  const wire: ConnectOverCDPTransport = {
    send: (message) => ws.send(JSON.stringify(message)),
    close: () => {
      ws.close();
      const timer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }, 100);
      timer.unref?.();
    },
  };
  ws.on("message", (raw) => {
    try {
      const parsed = asOptionalRecord(JSON.parse(rawDataToString(raw)));
      if (!parsed) {
        wire.close();
        return;
      }
      wire.onmessage?.(parsed);
    } catch {
      wire.close();
    }
  });
  ws.on("close", () => wire.onclose?.("CDP socket closed"));
  ws.on("error", (error) => wire.onclose?.(formatErrorMessage(error)));
  return wire;
}

export async function connectOverCdpTransport(
  connectionUrl: string,
  opts: CdpTransportOptions,
): Promise<Browser> {
  const wire = opts.preparedTransport ?? (await openCdpTransportSocket(connectionUrl, opts));
  try {
    let onMessage: ((message: object) => void) | undefined;
    let onClose: ((reason?: string) => void) | undefined;
    const pendingMessages: object[] = [];
    let pendingCloseReason: string | undefined;
    let transportClosed = false;
    let closingReason: string | undefined;
    let transportCloseScheduled = false;
    let nextInternalCommandId = FIRST_INTERNAL_COMMAND_ID;
    const pendingContextlessTargetResumes = new Map<number, string>();
    const notifyTransportClosed = (reason: string) => {
      if (transportClosed) {
        return;
      }
      transportClosed = true;
      if (onClose) {
        onClose(reason);
        return;
      }
      pendingCloseReason = reason;
    };
    const scheduleTransportClosed = (reason: string) => {
      if (transportClosed || transportCloseScheduled) {
        return;
      }
      transportCloseScheduled = true;
      setImmediate(() => {
        transportCloseScheduled = false;
        notifyTransportClosed(reason);
      });
    };
    const closeTransportSocket = (reason = "CDP socket closed") => {
      closingReason = reason;
      // Borrowed streams close only after the real owner acknowledges native cleanup.
      wire.close();
    };
    const sendInternalCommand = (
      method: string,
      params: Record<string, unknown> | undefined,
      sessionId?: string,
    ): number => {
      const id = nextInternalCommandId--;
      wire.send({ id, method, ...(params ? { params } : {}), sessionId });
      return id;
    };
    const releaseContextlessTarget = (sessionId: string) => {
      // Chrome dispatches session and root commands independently. Wait for the
      // resume response before detach so the hidden target cannot stay paused.
      const resumeId = sendInternalCommand("Runtime.runIfWaitingForDebugger", undefined, sessionId);
      pendingContextlessTargetResumes.set(resumeId, sessionId);
    };
    const scheduleMessage = (message: object) => {
      setImmediate(() => {
        if (transportClosed || closingReason) {
          return;
        }
        if (!onMessage) {
          pendingMessages.push(message);
          return;
        }
        try {
          onMessage(message);
        } catch (error) {
          closeTransportSocket(formatErrorMessage(error));
        }
      });
    };
    const transport: ConnectOverCDPTransport = {
      send: (message) => {
        if (closingReason || transportClosed) {
          throw new Error("CDP transport closed");
        }
        wire.send(message);
      },
      close: () => {
        closeTransportSocket();
      },
      get onmessage() {
        return onMessage;
      },
      set onmessage(handler) {
        onMessage = handler;
        if (!handler) {
          return;
        }
        while (pendingMessages.length > 0) {
          const pending = pendingMessages.shift();
          if (pending) {
            scheduleMessage(pending);
          }
        }
      },
      get onclose() {
        return onClose;
      },
      set onclose(handler) {
        onClose = handler;
        if (handler && pendingCloseReason !== undefined) {
          const reason = pendingCloseReason;
          pendingCloseReason = undefined;
          handler(reason);
        }
      },
    };
    Object.assign(wire, {
      onmessage: (message: object) => {
        try {
          const parsed = asOptionalRecord(message);
          if (!parsed) {
            closeTransportSocket();
            return;
          }
          const id = parsed.id;
          if (typeof id === "number" && id <= FIRST_INTERNAL_COMMAND_ID) {
            const targetSessionId = pendingContextlessTargetResumes.get(id);
            if (targetSessionId) {
              pendingContextlessTargetResumes.delete(id);
              sendInternalCommand("Target.detachFromTarget", { sessionId: targetSessionId });
            }
            return;
          }
          const contextlessSessionId = contextlessTargetSession(parsed);
          if (contextlessSessionId) {
            releaseContextlessTarget(contextlessSessionId);
            return;
          }
          scheduleMessage(parsed);
        } catch {
          closeTransportSocket();
        }
      },
      onclose: (reason?: string) =>
        scheduleTransportClosed(closingReason ?? reason ?? "CDP socket closed"),
    });
    return await getPlaywrightCore().chromium.connectOverCDP(transport, { timeout: opts.timeout });
  } catch (error) {
    wire.close();
    throw error;
  }
}
