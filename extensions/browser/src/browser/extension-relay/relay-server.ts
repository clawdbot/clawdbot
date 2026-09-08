/** Loopback extension relay with connection-bound Browser Relay Authentication v2. */
import crypto from "node:crypto";
import http, { type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  rawDataToString,
  readRequestBodyWithLimit,
  resolveRequestClientIp,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { rejectWebSocketUpgrade } from "openclaw/plugin-sdk/websocket-runtime";
import { WebSocketServer, type WebSocket } from "ws";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { randomRelayId } from "./auth-v2-crypto.js";
import { authenticateExtensionWebSocket } from "./auth-v2-websocket.js";
import {
  BROWSER_RELAY_AUTH_CHALLENGE_PATH,
  BROWSER_RELAY_AUTH_COMPLETE_PATH,
  BROWSER_RELAY_CHALLENGE_TTL_MS,
  BROWSER_RELAY_EXTENSION_SUBPROTOCOL,
  getBrowserRelayAuthV2Authority,
  invalidateBrowserRelayAuthV2Authority,
  parseExtensionRelayResource,
  parseRelayHttpChallengeRequest,
  parseRelayHttpCompleteRequest,
  parseStrictJsonObject,
  type BrowserRelayAuthV2Authority,
} from "./auth-v2.js";
import { RELAY_OWNER_PATH, relayOwnerResource } from "./owner-protocol.js";
import { attachRelayOwner } from "./owner-server.js";
import { handlePreAuthWebSocketUpgrade } from "./preauth-websocket-guard.js";
import { readExtensionRelayToken } from "./relay-auth.js";
import { ExtensionRelayBridge } from "./relay-bridge.js";
import { parseExtensionMessage } from "./relay-protocol.js";
import {
  firstHeader,
  isAllowedExtensionOrigin,
  requestExtensionProtocolToken,
  requestProtocols,
} from "./relay-request.js";

export { authenticateExtensionWebSocket } from "./auth-v2-websocket.js";

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
  ownership: "owned";
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
  try {
    return await readRequestBodyWithLimit(req, {
      ...WEBHOOK_BODY_READ_DEFAULTS.preAuth,
      maxBytes: MAX_AUTH_BODY_BYTES,
      destroyOnLimit: false,
    });
  } catch {
    return null;
  }
}

function bindSocket(
  ws: WebSocket,
  handlers: { onMessage: (raw: string) => void; onClose: () => void | Promise<void> },
): void {
  ws.on("message", (data) => handlers.onMessage(rawDataToString(data)));
  ws.on("close", () => {
    void Promise.resolve(handlers.onClose()).catch((error: unknown) =>
      log.warn(`Client cleanup incomplete: ${String(error)}`),
    );
  });
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

export async function startExtensionRelayServer(params: {
  port: number;
  profileName?: string;
  token: string;
  allowLegacyAuth?: boolean;
  onStateChange?: () => void;
}): Promise<ExtensionRelayHandle> {
  const allowLegacyAuth = params.allowLegacyAuth ?? true;
  const internalToken = crypto.randomBytes(32).toString("base64url");
  const owner = randomRelayId();
  let retired = false;
  if (readExtensionRelayToken() === params.token) {
    getBrowserRelayAuthV2Authority(params.token);
  }
  const bridge = new ExtensionRelayBridge({ onStateChange: params.onStateChange });
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: EXTENSION_RELAY_MAX_PAYLOAD_BYTES,
  });
  const httpStates = new WeakMap<Duplex, HttpAuthState>();
  const socketAuthorities = new WeakMap<Duplex, BrowserRelayAuthV2Authority>();
  const authSockets = new Set<Duplex>();
  const ownerConnections = new Map<WebSocket, () => Promise<void>>();

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
  const registerHttpSocket = (
    socket: Duplex,
    authority: BrowserRelayAuthV2Authority,
    source: string,
  ): boolean => {
    if (authSockets.has(socket)) {
      return true;
    }
    if (!authority.registerPendingConnection(socket, () => socket.destroy(), source)) {
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
      const source = resolveRequestClientIp(req) ?? "unknown";
      const existingState = httpStates.get(socket);
      const authority = currentAuthority();

      if (path === BROWSER_RELAY_AUTH_CHALLENGE_PATH) {
        if (
          req.url !== BROWSER_RELAY_AUTH_CHALLENGE_PATH ||
          req.method !== "POST" ||
          existingState ||
          !authority ||
          !registerHttpSocket(socket, authority, source)
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
    // HTTP no longer owns socket errors after handing off an upgrade.
    socket.once("error", () => socket.destroy());
    const path = (req.url ?? "/").split("?")[0];
    const source = resolveRequestClientIp(req) ?? "unknown";
    if (retired) {
      rejectWebSocketUpgrade(socket, { status: 503 });
      return;
    }
    if (!hasLoopbackHostHeader(req)) {
      rejectWebSocketUpgrade(socket, { status: 403 });
      return;
    }
    if (path === RELAY_OWNER_PATH) {
      const resource = params.profileName
        ? relayOwnerResource(resolvedPort(), params.profileName)
        : null;
      const authority = currentAuthority();
      const protocols = requestProtocols(req);
      if (
        !resource ||
        req.url !== resource ||
        !authority ||
        readExtensionRelayToken() !== params.token ||
        retired ||
        protocols.length !== 1 ||
        protocols[0] !== BROWSER_RELAY_EXTENSION_SUBPROTOCOL
      ) {
        rejectWebSocketUpgrade(socket, { status: 403 });
        return;
      }
      handlePreAuthWebSocketUpgrade({
        wss,
        req,
        socket,
        head,
        onUpgrade: (ws, removePreAuthGuard) =>
          authenticateExtensionWebSocket({
            ws,
            authority,
            source,
            resource: `${resource}&owner=${owner}`,
            binding: { role: "cdp", flow: "owner" },
            removePreAuthGuard,
            prepareAuthenticated: async () => () => {
              if (retired || readExtensionRelayToken() !== params.token) {
                throw new Error("Relay owner retired");
              }
              const closeOwner = attachRelayOwner({
                ws,
                bridge,
                allowLegacyAuth,
                isCurrent: () => !retired && readExtensionRelayToken() === params.token,
              });
              ownerConnections.set(ws, closeOwner);
              ws.once("close", () => {
                void closeOwner().then(
                  () => ownerConnections.delete(ws),
                  () => {},
                );
              });
            },
          }),
      });
      return;
    }
    if (path === "/extension") {
      if (!isAllowedExtensionOrigin(req)) {
        rejectWebSocketUpgrade(socket, { status: 403 });
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
          rejectWebSocketUpgrade(socket, { status: 401 });
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
                source,
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
          rejectWebSocketUpgrade(socket, { status: 400 });
        }
        return;
      }
      if (protocols.includes(BROWSER_RELAY_EXTENSION_SUBPROTOCOL)) {
        rejectWebSocketUpgrade(socket, { status: 400 });
        return;
      }
      const liveToken = readExtensionRelayToken();
      if (!liveToken || !isAuthorizedLegacy(req, liveToken, allowLegacyAuth)) {
        rejectWebSocketUpgrade(socket, { status: 401 });
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
        rejectWebSocketUpgrade(socket, { status: 401 });
        return;
      }
      const authority = currentAuthority();
      if (!authority) {
        rejectWebSocketUpgrade(socket, { status: 401 });
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) =>
        trackAuthenticatedSocket(authority, ws)
          ? bindSocket(ws, bridge.attachCdpClientSocket(ws))
          : undefined,
      );
      return;
    }
    rejectWebSocketUpgrade(socket, { status: 404 });
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
    ownership: "owned",
    port: resolvedPort(),
    token: params.token,
    allowLegacyAuth,
    internalToken,
    bridge,
    close: async () => {
      retired = true;
      try {
        await Promise.all([...ownerConnections.values()].map((closeOwner) => closeOwner()));
      } finally {
        // This process owns physical retirement even when native cleanup fails.
        // Failed leases get no acknowledgement; the cleanup error still reaches the owner.
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
      }
    },
  };
}
