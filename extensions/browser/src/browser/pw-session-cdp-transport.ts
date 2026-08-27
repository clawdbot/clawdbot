import type { lookup as dnsLookupCb } from "node:dns";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import WebSocket from "ws";
import { formatErrorMessage } from "../infra/errors.js";
import { openCdpWebSocket } from "./cdp.helpers.js";
import { getPlaywrightCore } from "./playwright-core.runtime.js";
type CdpSocketLookup = typeof dnsLookupCb;

export async function connectOverCdpPinnedTransport(
  connectionUrl: string,
  opts: {
    timeout: number;
    headers: Record<string, string>;
    lookup: CdpSocketLookup;
  },
): Promise<Browser> {
  const ws = openCdpWebSocket(connectionUrl, {
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
    let onMessage: ((message: object) => void) | undefined;
    let onClose: ((reason?: string) => void) | undefined;
    const pendingMessages: object[] = [];
    let pendingCloseReason: string | undefined;
    let transportClosed = false;
    let transportCloseScheduled = false;
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
      notifyTransportClosed(reason);
      ws.close();
      const terminateTimer = setTimeout(() => {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
      }, 100);
      terminateTimer.unref?.();
    };
    const scheduleMessage = (message: object) => {
      setImmediate(() => {
        if (transportClosed) {
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
        ws.send(JSON.stringify(message));
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
    ws.on("message", (raw) => {
      try {
        const parsed = JSON.parse(rawDataToString(raw)) as object;
        scheduleMessage(parsed);
      } catch {
        closeTransportSocket();
      }
    });
    ws.on("close", () => {
      scheduleTransportClosed("CDP socket closed");
    });
    ws.on("error", (error) => {
      scheduleTransportClosed(formatErrorMessage(error));
    });
    return await getPlaywrightCore().chromium.connectOverCDP(transport, { timeout: opts.timeout });
  } catch (error) {
    ws.close();
    throw error;
  }
}
