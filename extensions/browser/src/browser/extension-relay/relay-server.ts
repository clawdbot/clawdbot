/**
 * Extension relay HTTP/WebSocket server.
 *
 * Loopback-only endpoint that pairs the OpenClaw Chrome extension with the
 * browser control service:
 *   GET /json/version  -> CDP discovery for pw-session (503 until paired)
 *   WS  /cdp           -> CDP browser endpoint (Playwright connectOverCDP)
 *   WS  /extension     -> the Chrome extension's relay transport
 * Both sides authenticate with the derived relay token: CDP clients send it as
 * Basic auth (flows from the profile cdpUrl userinfo via getHeadersWithAuth),
 * the extension sends the token in its WebSocket subprotocol list.
 */
import http, { type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { WebSocketServer, type WebSocket } from "ws";
import { isLoopbackHost } from "../../gateway/net.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { ExtensionRelayBridge } from "./relay-bridge.js";

const log = createSubsystemLogger("browser").child("extension-relay");
const EXTENSION_RELAY_PROTOCOL = "openclaw-extension-relay";
const EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX = "openclaw-extension-token.";

/**
 * Cap relay frame size to bound memory from a hostile/buggy peer while leaving
 * headroom for CDP payloads (base64 screenshots, DOM snapshots, network bodies).
 */
export const EXTENSION_RELAY_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

/** Wire an accepted extension WebSocket to a bridge (shared by loopback + gateway paths). */
export function attachExtensionWebSocket(bridge: ExtensionRelayBridge, ws: WebSocket): void {
  bindSocket(ws, bridge.attachExtensionSocket(toBridgeSocket(ws)));
}

/** Running relay server handle owned by the profile runtime state. */
export type ExtensionRelayHandle = {
  port: number;
  /** Auth token this relay validates against; used to detect auth rotation. */
  token: string;
  bridge: ExtensionRelayBridge;
  close: () => Promise<void>;
};

function firstHeader(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/** Extract a relay token carried by the extension's WebSocket subprotocol list. */
export function requestExtensionProtocolToken(req: IncomingMessage): string {
  const protocols = firstHeader(req.headers["sec-websocket-protocol"])
    .split(",")
    .map((value) => value.trim());
  if (!protocols.includes(EXTENSION_RELAY_PROTOCOL)) {
    return "";
  }
  const tokenProtocol = protocols.find((value) =>
    value.startsWith(EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX),
  );
  return tokenProtocol?.slice(EXTENSION_RELAY_TOKEN_PROTOCOL_PREFIX.length) ?? "";
}

/** Extract relay auth from a CDP header, extension subprotocol, or legacy query. */
function requestToken(req: IncomingMessage): string {
  const auth = firstHeader(req.headers.authorization);
  if (auth.startsWith("Bearer ")) {
    return auth.slice("Bearer ".length).trim();
  }
  if (auth.startsWith("Basic ")) {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator >= 0 ? decoded.slice(separator + 1) : decoded;
  }
  const protocolToken = requestExtensionProtocolToken(req);
  if (protocolToken) {
    return protocolToken;
  }
  try {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    return url.searchParams.get("token") ?? "";
  } catch {
    return "";
  }
}

function isAuthorized(req: IncomingMessage, token: string): boolean {
  const candidate = requestToken(req);
  return candidate.length > 0 && safeEqualSecret(token, candidate);
}

/** Reject cross-origin websocket upgrades; the extension side must come from Chrome. */
export function isAllowedExtensionOrigin(req: IncomingMessage): boolean {
  const origin = firstHeader(req.headers.origin);
  // Chrome MV3 service workers send their chrome-extension:// origin. Absent
  // origin is allowed for non-browser clients such as tests and diagnostics.
  return origin === "" || origin.startsWith("chrome-extension://");
}

/** Reject DNS-rebinding style requests that reach loopback with a foreign Host. */
function hasLoopbackHostHeader(req: IncomingMessage): boolean {
  const host = firstHeader(req.headers.host);
  if (!host) {
    return true;
  }
  try {
    return isLoopbackHost(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

function destroySocket(socket: Duplex, response: string): void {
  socket.write(response);
  socket.destroy();
}

/** Start the relay server for one extension-driver profile. */
export async function startExtensionRelayServer(params: {
  port: number;
  token: string;
  onStateChange?: () => void;
}): Promise<ExtensionRelayHandle> {
  const bridge = new ExtensionRelayBridge({ onStateChange: params.onStateChange });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
  });

  const server: Server = http.createServer((req, res) => {
    if (!hasLoopbackHostHeader(req)) {
      res.writeHead(403).end("Forbidden");
      return;
    }
    if (!isAuthorized(req, params.token)) {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="openclaw-extension-relay"' });
      res.end("Unauthorized");
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && (path === "/json/version" || path === "/json/version/")) {
      if (!bridge.extensionConnected) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            error:
              "OpenClaw Chrome extension is not connected. Install the extension and pair it with `openclaw browser extension pair`.",
          }),
        );
        return;
      }
      const identity = bridge.identity;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: identity?.browserVersion ?? "Chrome/unknown",
          "Protocol-Version": "1.3",
          "User-Agent": identity?.userAgent ?? "unknown",
          webSocketDebuggerUrl: `ws://127.0.0.1:${resolvedPort()}/cdp`,
        }),
      );
      return;
    }
    if (req.method === "GET" && (path === "/json" || path === "/json/list")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(bridge.sharedTabs()));
      return;
    }
    res.writeHead(404).end("Not found");
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (!hasLoopbackHostHeader(req)) {
      destroySocket(socket, "HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    if (!isAuthorized(req, params.token)) {
      destroySocket(socket, "HTTP/1.1 401 Unauthorized\r\n\r\n");
      return;
    }
    if (path === "/extension") {
      if (!isAllowedExtensionOrigin(req)) {
        destroySocket(socket, "HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        attachExtensionWebSocket(bridge, ws);
        log.info("extension connected to relay");
      });
      return;
    }
    if (path === "/cdp") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        bindSocket(ws, bridge.attachCdpClientSocket(toBridgeSocket(ws)));
      });
      return;
    }
    destroySocket(socket, "HTTP/1.1 404 Not Found\r\n\r\n");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(params.port, "127.0.0.1", () => resolve());
  });

  const resolvedPort = () => {
    const address = server.address();
    return typeof address === "object" && address ? address.port : params.port;
  };

  return {
    port: resolvedPort(),
    token: params.token,
    bridge,
    close: async () => {
      bridge.dispose();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function toBridgeSocket(ws: WebSocket) {
  return {
    send: (data: string) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(data);
      }
    },
    close: (code?: number, reason?: string) => {
      try {
        ws.close(code, reason);
      } catch {
        // already closing
      }
    },
  };
}

/** Decode a ws frame (string | Buffer | Buffer[] | ArrayBuffer) to text. */
function decodeWsData(data: import("ws").RawData | string): string {
  if (typeof data === "string") {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return Buffer.from(data as ArrayBuffer).toString("utf8");
}

function bindSocket(
  ws: WebSocket,
  handlers: { onMessage: (raw: string) => void; onClose: () => void },
): void {
  ws.on("message", (data) => {
    handlers.onMessage(decodeWsData(data));
  });
  ws.on("close", handlers.onClose);
  ws.on("error", (err) => {
    log.warn(`relay socket error: ${String(err)}`);
  });
}
