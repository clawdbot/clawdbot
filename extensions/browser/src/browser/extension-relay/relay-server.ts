/** Loopback extension relay with connection-bound Browser Relay Authentication v2. */
import crypto from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isLoopbackHost } from "../../gateway/net.js";
import { rawDataToString } from "../../infra/ws.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  getBrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
  parseExtensionRelayResource,
  parseRelayAuthHello,
  parseRelayAuthResponse,
  parseRelayHttpChallengeRequest,
  parseRelayHttpCompleteRequest,
  parseStrictJsonObject,
  type BrowserRelayAuthV2Authority,
} from "./auth-v2.js";
import {
  boundedRawDataByteLength,
  handlePreAuthWebSocketUpgrade,
  MAX_WEBSOCKET_AUTH_MESSAGE_BYTES,
} from "./preauth-websocket-guard.js";
import { readExtensionRelayToken } from "./relay-auth.js";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { parseExtensionMessage, type PageSharePayload } from "./relay-protocol.js";
import {
  firstHeader,
  isAllowedExtensionOrigin,
  requestExtensionProtocolToken,
  requestProtocols,
} from "./relay-request.js";

const log = createSubsystemLogger("browser").child("extension-relay");
const INTERNAL_CDP_USERNAME = "openclaw-internal";
const MAX_AUTH_BODY_BYTES = 8 * 1024;

export const EXTENSION_RELAY_MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;

type HttpAuthState =
  | { stage: "busy" }
  | {
      stage: "challenged";
      flow: "cdp" | "json-list";
      authority: BrowserRelayAuthV2Authority;
      timer: NodeJS.Timeout;
    }
  | {
      stage: "authenticated";
      flow: "cdp" | "json-list";
      authority: BrowserRelayAuthV2Authority;
      timer: NodeJS.Timeout;
    }
  | {
      stage: "awaiting-upgrade";
      authority: BrowserRelayAuthV2Authority;
      timer: NodeJS.Timeout;
    };

export type ExtensionRelayHandle = {
  port: number;
  token: string;
  allowLegacyAuth: boolean;
  /** Process-only Basic credential for OpenClaw's own CDP client. Never persisted or printed. */
  internalToken: string;
  bridge: ExtensionRelayBridge;
  close: () => Promise<void>;
};

function decodeBasic(req: IncomingMessage): { username: string; password: string } | null {
  const auth = firstHeader(req.headers.authorization);
  if (!auth.startsWith("Basic ")) {
    return null;
  }
  try {
    const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    return separator < 0
      ? { username: "", password: decoded }
      : { username: decoded.slice(0, separator), password: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

function isAuthorizedInternal(req: IncomingMessage, internalToken: string): boolean {
  const basic = decodeBasic(req);
  return (
    basic?.username === INTERNAL_CDP_USERNAME && safeEqualSecret(internalToken, basic.password)
  );
}

function isAuthorizedLegacy(
  req: IncomingMessage,
  token: string,
  allowLegacyAuth: boolean,
): boolean {
  if (!allowLegacyAuth) {
    return false;
  }
  const auth = firstHeader(req.headers.authorization);
  if (auth.startsWith("Bearer ") && safeEqualSecret(token, auth.slice("Bearer ".length).trim())) {
    return true;
  }
  const basic = decodeBasic(req);
  if (basic && safeEqualSecret(token, basic.password)) {
    return true;
  }
  const protocolToken = requestExtensionProtocolToken(req);
  return protocolToken.length > 0 && safeEqualSecret(token, protocolToken);
}

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
  try {
    socket.write(response);
  } finally {
    socket.destroy();
  }
}

function writeJson(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

function rejectHttp(res: ServerResponse, status: number, message: string): void {
  res.once("finish", () => res.socket?.destroy());
  writeJson(res, status, { error: message }, { Connection: "close" });
}

async function readAuthBody(req: IncomingMessage): Promise<string | null> {
  let body = "";
  for await (const chunk of req) {
    body += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    if (Buffer.byteLength(body) > MAX_AUTH_BODY_BYTES) {
      return null;
    }
  }
  return body;
}

function bindSocket(
  ws: WebSocket,
  handlers: { onMessage: (raw: string) => void; onClose: () => void },
): void {
  ws.on("message", (data) => handlers.onMessage(rawDataToString(data)));
  ws.on("close", handlers.onClose);
  ws.on("error", (err) => log.warn(`relay socket error: ${String(err)}`));
}

function trackAuthenticatedSocket(authority: BrowserRelayAuthV2Authority, ws: WebSocket): boolean {
  if (
    !authority.registerAuthenticatedConnection(ws, () =>
      ws.close(4003, "browser relay key rotated"),
    )
  ) {
    ws.terminate();
    return false;
  }
  ws.once("close", () => authority.releaseConnection(ws));
  return true;
}

/** Wire an already-v2-authenticated extension socket to the bridge. */
export function attachExtensionWebSocket(bridge: ExtensionRelayBridge, ws: WebSocket): void {
  const handlers = bridge.attachExtensionSocket(ws);
  let helloSeen = false;
  const helloTimer = setTimeout(() => {
    ws.close(4008, "extension hello timeout");
    ws.terminate();
  }, BROWSER_RELAY_CHALLENGE_TTL_MS);
  helloTimer.unref?.();
  bindSocket(ws, {
    onMessage: (raw) => {
      if (!helloSeen && parseExtensionMessage(raw)?.type === "hello") {
        helloSeen = true;
        clearTimeout(helloTimer);
      }
      handlers.onMessage(raw);
    },
    onClose: () => {
      clearTimeout(helloTimer);
      handlers.onClose();
    },
  });
}

export function authenticateExtensionWebSocket(params: {
  ws: WebSocket;
  authority: BrowserRelayAuthV2Authority;
  resource: string;
  prepareAuthenticated: () => Promise<() => void>;
  removePreAuthGuard?: () => void;
}): void {
  const { ws, authority } = params;
  let stage: "hello" | "response" | "authenticated" | "failed" = "hello";
  let preAuthGuardActive = true;
  const removePreAuthGuard = () => {
    if (!preAuthGuardActive) {
      return;
    }
    preAuthGuardActive = false;
    params.removePreAuthGuard?.();
  };
  const timer = setTimeout(() => {
    stage = "failed";
    ws.off("message", onMessage);
    ws.close(4008, "browser relay auth timeout");
    ws.terminate();
  }, BROWSER_RELAY_CHALLENGE_TTL_MS);
  timer.unref?.();
  const release = () => {
    clearTimeout(timer);
    removePreAuthGuard();
    authority.releaseConnection(ws);
  };
  if (
    !authority.registerPendingConnection(ws, () => {
      ws.close(4003, "browser relay key rotated");
    })
  ) {
    clearTimeout(timer);
    ws.close(4013, "browser relay auth capacity reached");
    return;
  }
  ws.once("close", release);
  const fail = (code: number, reason: string) => {
    if (stage === "failed") {
      return;
    }
    stage = "failed";
    clearTimeout(timer);
    ws.off("message", onMessage);
    ws.close(code, reason);
    const terminateTimer = setTimeout(() => ws.terminate(), 100);
    terminateTimer.unref?.();
  };
  const onMessage = (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      fail(4003, "binary browser relay auth frames are not allowed");
      return;
    }
    if (
      boundedRawDataByteLength(data, MAX_WEBSOCKET_AUTH_MESSAGE_BYTES) >
      MAX_WEBSOCKET_AUTH_MESSAGE_BYTES
    ) {
      fail(4003, "browser relay auth frame is too large");
      return;
    }
    const raw = rawDataToString(data);
    const parsed = parseStrictJsonObject(raw);
    if (stage === "hello") {
      const hello = parseRelayAuthHello(parsed);
      if (!hello) {
        fail(4003, "invalid browser relay auth hello");
        return;
      }
      const challenge = authority.issueChallenge(ws, hello, {
        role: "extension",
        transport: "websocket",
        method: "GET",
        resource: params.resource,
        flow: "extension",
      });
      if (!challenge) {
        fail(4003, "browser relay auth rejected");
        return;
      }
      stage = "response";
      ws.send(JSON.stringify(challenge));
      return;
    }
    if (stage === "response") {
      const response = parseRelayAuthResponse(parsed);
      if (!response) {
        fail(4003, "invalid browser relay auth response");
        return;
      }
      const completed = authority.completeChallenge(ws, response);
      if (!completed) {
        fail(4003, "browser relay auth proof failed");
        return;
      }
      stage = "authenticated";
      // The proof deadline owns only challenge completion. Promotion is now
      // authoritative, so cold Browser/Gateway preparation must not race it.
      clearTimeout(timer);
      removePreAuthGuard();
      void params
        .prepareAuthenticated()
        .then((attach) => {
          if (ws.readyState !== 1) {
            return;
          }
          ws.off("message", onMessage);
          attach();
          ws.send(JSON.stringify(completed.ok), (err) => {
            if (err) {
              ws.close(1011, "browser relay auth acknowledgement failed");
            }
          });
        })
        .catch((err: unknown) => {
          log.warn(`browser relay post-auth preparation failed: ${String(err)}`);
          fail(1011, "browser relay unavailable after authentication");
        });
      return;
    }
    fail(4003, "unexpected browser relay auth frame");
  };
  ws.on("message", onMessage);
}

export async function startExtensionRelayServer(params: {
  port: number;
  token: string;
  allowLegacyAuth?: boolean;
  onStateChange?: () => void;
  onPageShare?: (payload: PageSharePayload) => Promise<void>;
}): Promise<ExtensionRelayHandle> {
  const allowLegacyAuth = params.allowLegacyAuth ?? true;
  const internalToken = crypto.randomBytes(32).toString("base64url");
  if (readExtensionRelayToken() === params.token) {
    getBrowserRelayAuthV2Authority(params.token);
  }
  const bridge = new ExtensionRelayBridge({
    onStateChange: params.onStateChange,
    onPageShare: params.onPageShare,
  });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
  });
  const httpStates = new WeakMap<Duplex, HttpAuthState>();
  const socketAuthorities = new WeakMap<Duplex, BrowserRelayAuthV2Authority>();
  const authSockets = new Set<Duplex>();

  const currentAuthority = (): BrowserRelayAuthV2Authority | null => {
    const liveToken = readExtensionRelayToken();
    if (!liveToken) {
      invalidateBrowserRelayAuthV2Authority();
      return null;
    }
    return getBrowserRelayAuthV2Authority(liveToken);
  };

  const clearSocketState = (socket: Duplex) => {
    const state = httpStates.get(socket);
    if (state && "timer" in state) {
      clearTimeout(state.timer);
    }
    httpStates.delete(socket);
    authSockets.delete(socket);
    const authority = socketAuthorities.get(socket);
    socketAuthorities.delete(socket);
    authority?.releaseConnection(socket);
  };
  const armSocketTimer = (socket: Duplex): NodeJS.Timeout => {
    const timer = setTimeout(() => socket.destroy(), BROWSER_RELAY_CHALLENGE_TTL_MS);
    timer.unref?.();
    return timer;
  };
  const registerHttpSocket = (socket: Duplex, authority: BrowserRelayAuthV2Authority): boolean => {
    if (authSockets.has(socket)) {
      return true;
    }
    if (!authority.registerPendingConnection(socket, () => socket.destroy())) {
      return false;
    }
    authSockets.add(socket);
    socketAuthorities.set(socket, authority);
    socket.once("close", () => clearSocketState(socket));
    return true;
  };

  const versionPayload = () => ({
    Browser: bridge.identity?.browserVersion ?? "Chrome/unknown",
    "Protocol-Version": "1.3",
    "User-Agent": bridge.identity?.userAgent ?? "unknown",
    webSocketDebuggerUrl: `ws://127.0.0.1:${resolvedPort()}/cdp`,
  });

  const server: Server = http.createServer((req, res) => {
    void (async () => {
      if (!hasLoopbackHostHeader(req)) {
        rejectHttp(res, 403, "Forbidden");
        return;
      }
      const path = (req.url ?? "/").split("?")[0];
      const socket = req.socket;
      const existingState = httpStates.get(socket);
      const authority = currentAuthority();

      if (path === BROWSER_RELAY_AUTH_CHALLENGE_PATH) {
        if (
          req.url !== BROWSER_RELAY_AUTH_CHALLENGE_PATH ||
          req.method !== "POST" ||
          existingState ||
          !authority ||
          !registerHttpSocket(socket, authority)
        ) {
          rejectHttp(res, existingState ? 409 : 400, "Invalid relay auth sequence");
          return;
        }
        const pending: HttpAuthState = { stage: "busy" };
        httpStates.set(socket, pending);
        const raw = await readAuthBody(req);
        const request =
          raw === null ? null : parseRelayHttpChallengeRequest(parseStrictJsonObject(raw));
        if (!request || request.keyId !== authority.keyId) {
          clearSocketState(socket);
          rejectHttp(res, 400, "Invalid relay auth challenge request");
          return;
        }
        const challenge = authority.issueChallenge(
          socket,
          { type: "auth.hello", v: 2, keyId: request.keyId, clientNonce: request.clientNonce },
          {
            role: request.role,
            transport: request.transport,
            method: request.method,
            resource: request.resource,
            flow: request.flow,
          },
        );
        if (!challenge) {
          clearSocketState(socket);
          rejectHttp(res, 401, "Relay auth challenge rejected");
          return;
        }
        res.once("finish", () => {
          if (!socket.destroyed && httpStates.get(socket) === pending) {
            httpStates.set(socket, {
              stage: "challenged",
              flow: request.flow,
              authority,
              timer: armSocketTimer(socket),
            });
          }
        });
        writeJson(res, 200, challenge);
        return;
      }

      if (path === BROWSER_RELAY_AUTH_COMPLETE_PATH) {
        if (
          req.url !== BROWSER_RELAY_AUTH_COMPLETE_PATH ||
          req.method !== "POST" ||
          existingState?.stage !== "challenged"
        ) {
          rejectHttp(res, 409, "Invalid relay auth sequence");
          return;
        }
        clearTimeout(existingState.timer);
        const pending: HttpAuthState = { stage: "busy" };
        httpStates.set(socket, pending);
        const raw = await readAuthBody(req);
        const request =
          raw === null ? null : parseRelayHttpCompleteRequest(parseStrictJsonObject(raw));
        const completed = request
          ? existingState.authority.completeChallenge(socket, {
              type: "auth.response",
              ...request,
            })
          : null;
        if (!completed) {
          clearSocketState(socket);
          rejectHttp(res, 401, "Relay auth proof failed");
          return;
        }
        res.once("finish", () => {
          if (!socket.destroyed && httpStates.get(socket) === pending) {
            httpStates.set(socket, {
              stage: "authenticated",
              flow: existingState.flow,
              authority: existingState.authority,
              timer: armSocketTimer(socket),
            });
          }
        });
        writeJson(res, 200, completed.ok);
        return;
      }

      if (existingState?.stage === "authenticated") {
        clearTimeout(existingState.timer);
        const pending: HttpAuthState = { stage: "busy" };
        httpStates.set(socket, pending);
        if (existingState.flow === "cdp" && req.method === "GET" && req.url === "/json/version") {
          if (!bridge.extensionConnected) {
            clearSocketState(socket);
            rejectHttp(res, 503, "OpenClaw Chrome extension is not connected");
            return;
          }
          res.once("finish", () => {
            if (!socket.destroyed && httpStates.get(socket) === pending) {
              httpStates.set(socket, {
                stage: "awaiting-upgrade",
                authority: existingState.authority,
                timer: armSocketTimer(socket),
              });
            }
          });
          writeJson(res, 200, versionPayload());
          return;
        }
        if (
          existingState.flow === "json-list" &&
          req.method === "GET" &&
          req.url === "/json/list"
        ) {
          clearSocketState(socket);
          res.once("finish", () => socket.destroy());
          writeJson(res, 200, bridge.devtoolsTargetDescriptors(), { Connection: "close" });
          return;
        }
        clearSocketState(socket);
        rejectHttp(res, 409, "Invalid relay auth sequence");
        return;
      }

      if (existingState) {
        clearSocketState(socket);
        rejectHttp(res, 409, "Invalid relay auth sequence");
        return;
      }

      const legacyOrInternal =
        isAuthorizedInternal(req, internalToken) ||
        (authority !== null &&
          isAuthorizedLegacy(req, readExtensionRelayToken() ?? "", allowLegacyAuth));
      if (!legacyOrInternal) {
        rejectHttp(res, 401, "Unauthorized");
        return;
      }
      if (req.method === "GET" && (path === "/json/version" || path === "/json/version/")) {
        if (!bridge.extensionConnected) {
          writeJson(res, 503, {
            error:
              "OpenClaw Chrome extension is not connected. Install the extension and pair it with `openclaw browser extension pair`.",
          });
          return;
        }
        writeJson(res, 200, versionPayload());
        return;
      }
      if (req.method === "GET" && (path === "/json" || path === "/json/list")) {
        writeJson(res, 200, bridge.devtoolsTargetDescriptors());
        return;
      }
      rejectHttp(res, 404, "Not found");
    })().catch((err: unknown) => {
      log.warn(`relay HTTP request failed: ${String(err)}`);
      if (!res.headersSent) {
        rejectHttp(res, 500, "Relay request failed");
      } else {
        res.destroy();
      }
    });
  });

  server.on("upgrade", (req, socket, head) => {
    const path = (req.url ?? "/").split("?")[0];
    if (!hasLoopbackHostHeader(req)) {
      destroySocket(socket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    if (path === "/extension") {
      if (!isAllowedExtensionOrigin(req)) {
        destroySocket(socket, "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        return;
      }
      const protocols = requestProtocols(req);
      const resource = parseExtensionRelayResource(req.url ?? "/", "/extension");
      if (
        protocols.length === 1 &&
        protocols[0] === BROWSER_RELAY_EXTENSION_SUBPROTOCOL &&
        resource
      ) {
        const authority = currentAuthority();
        if (!authority) {
          destroySocket(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
          return;
        }
        if (
          !handlePreAuthWebSocketUpgrade({
            wss,
            req,
            socket,
            head,
            onUpgrade: (ws, removePreAuthGuard) => {
              authenticateExtensionWebSocket({
                ws,
                authority,
                resource,
                removePreAuthGuard,
                prepareAuthenticated: async () => () => {
                  attachExtensionWebSocket(bridge, ws);
                  log.info("extension authenticated and connected to relay");
                },
              });
            },
          })
        ) {
          destroySocket(socket, "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        }
        return;
      }
      if (protocols.includes(BROWSER_RELAY_EXTENSION_SUBPROTOCOL)) {
        destroySocket(socket, "HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
        return;
      }
      const liveToken = readExtensionRelayToken();
      if (!liveToken || !isAuthorizedLegacy(req, liveToken, allowLegacyAuth)) {
        destroySocket(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const authority = getBrowserRelayAuthV2Authority(liveToken);
      wss.handleUpgrade(req, socket, head, (ws) => {
        if (!trackAuthenticatedSocket(authority, ws)) {
          return;
        }
        attachExtensionWebSocket(bridge, ws);
        log.warn("legacy extension relay authentication accepted");
      });
      return;
    }
    if (path === "/cdp") {
      const state = httpStates.get(socket);
      if (req.url === "/cdp" && state?.stage === "awaiting-upgrade") {
        clearTimeout(state.timer);
        httpStates.delete(socket);
        wss.handleUpgrade(req, socket, head, (ws) =>
          bindSocket(ws, bridge.attachCdpClientSocket(ws)),
        );
        return;
      }
      if (
        !isAuthorizedInternal(req, internalToken) &&
        !isAuthorizedLegacy(req, readExtensionRelayToken() ?? "", allowLegacyAuth)
      ) {
        destroySocket(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      const authority = currentAuthority();
      if (!authority) {
        destroySocket(socket, "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        trackAuthenticatedSocket(authority, ws)
          ? bindSocket(ws, bridge.attachCdpClientSocket(ws))
          : undefined,
      );
      return;
    }
    destroySocket(socket, "HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
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
    allowLegacyAuth,
    internalToken,
    bridge,
    close: async () => {
      for (const socket of authSockets) {
        clearSocketState(socket);
        socket.destroy();
      }
      for (const client of wss.clients) {
        client.terminate();
      }
      bridge.dispose();
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
