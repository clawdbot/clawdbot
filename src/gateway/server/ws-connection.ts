import { randomUUID } from "node:crypto";
import type { WebSocket, WebSocketServer } from "ws";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { removeRemoteNodeInfo } from "../../infra/skills-remote.js";
import { upsertPresence } from "../../infra/system-presence.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { truncateUtf16Safe } from "../../utils.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { isLoopbackAddress } from "../net.js";
import { getHandshakeTimeoutMs } from "../server-constants.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import { formatError } from "../server-utils.js";
import { logWs } from "../ws-log.js";
import { getHealthVersion, incrementPresenceVersion } from "./health-state.js";
import { broadcastPresenceSnapshot } from "./presence-events.js";
import {
  attachGatewayWsMessageHandler,
  type WsOriginCheckMetrics,
} from "./ws-connection/message-handler.js";
import type { GatewayWsClient } from "./ws-types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const LOG_HEADER_MAX_LEN = 300;
const LOG_HEADER_FORMAT_REGEX = /\p{Cf}/gu;

function replaceControlChars(value: string): string {
  let cleaned = "";
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (
      codePoint !== undefined &&
      (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f))
    ) {
      cleaned += " ";
      continue;
    }
    cleaned += char;
  }
  return cleaned;
}
const sanitizeLogValue = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  const cleaned = replaceControlChars(value)
    .replace(LOG_HEADER_FORMAT_REGEX, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) {
    return undefined;
  }
  if (cleaned.length <= LOG_HEADER_MAX_LEN) {
    return cleaned;
  }
  return truncateUtf16Safe(cleaned, LOG_HEADER_MAX_LEN);
};

export type GatewayWsSharedHandlerParams = {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  port: number;
  gatewayHost?: string;
  canvasHostEnabled: boolean;
  canvasHostServerPort?: number;
  resolvedAuth: ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  gatewayMethods: string[];
  events: string[];
};

export type AttachGatewayWsConnectionHandlerParams = GatewayWsSharedHandlerParams & {
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  buildRequestContext: () => GatewayRequestContext;
};

export function attachGatewayWsConnectionHandler(params: AttachGatewayWsConnectionHandlerParams) {
  const {
    wss,
    clients,
    port,
    gatewayHost,
    canvasHostEnabled,
    canvasHostServerPort,
    resolvedAuth,
    rateLimiter,
    browserRateLimiter,
    gatewayMethods,
    events,
    logGateway,
    logHealth,
    logWsControl,
    extraHandlers,
    broadcast,
    buildRequestContext,
  } = params;
  const originCheckMetrics: WsOriginCheckMetrics = { hostHeaderFallbackAccepted: 0 };

  wss.on("connection", (socket, upgradeReq) => {
    let client: GatewayWsClient | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();
    const remoteAddr = (socket as WebSocket & { _socket?: { remoteAddress?: string } })._socket
      ?.remoteAddress;
    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    const requestHost = headerValue(upgradeReq.headers.host);
    const requestOrigin = headerValue(upgradeReq.headers.origin);
    const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
    const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
    const realIp = headerValue(upgradeReq.headers["x-real-ip"]);

    const canvasHostPortForWs = canvasHostServerPort ?? (canvasHostEnabled ? port : undefined);
    const canvasHostOverride =
      gatewayHost && gatewayHost !== "0.0.0.0" && gatewayHost !== "::" ? gatewayHost : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServerPort ? canvasHostOverride : undefined,
      requestHost: upgradeReq.headers.host,
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });

    logWs("in", "open", { connId, remoteAddr });
    let handshakeState: "pending" | "connected" | "failed" = "pending";
    let closeCause: string | undefined;
    let closeMeta: Record<string, unknown> = {};
    let lastFrameType: string | undefined;
    let lastFrameMethod: string | undefined;
    let lastFrameId: string | undefined;

    const setCloseCause = (cause: string, meta?: Record<string, unknown>) => {
      if (!closeCause) {
        closeCause = cause;
      }
      if (meta && Object.keys(meta).length > 0) {
        closeMeta = { ...closeMeta, ...meta };
      }
    };

    const setLastFrameMeta = (meta: { type?: string; method?: string; id?: string }) => {
      if (meta.type || meta.method || meta.id) {
        lastFrameType = meta.type ?? lastFrameType;
        lastFrameMethod = meta.method ?? lastFrameMethod;
        lastFrameId = meta.id ?? lastFrameId;
      }
    };

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const connectNonce = randomUUID();
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: connectNonce, ts: Date.now() },
    });

    const close = (code = 1000, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) {
        clients.delete(client);
      }
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
      close();
    });

    const isNoisySwiftPmHelperClose = (userAgent: string | undefined, remote: string | undefined) =>
      Boolean(
        userAgent?.toLowerCase().includes("swiftpm-testing-helper") && isLoopbackAddress(remote),
      );

    socket.once("close", (code, reason) => {
      const durationMs = Date.now() - openedAt;
      const logForwardedFor = sanitizeLogValue(forwardedFor);
      const logOrigin = sanitizeLogValue(requestOrigin);
      const logHost = sanitizeLogValue(requestHost);
      const logUserAgent = sanitizeLogValue(requestUserAgent);
      const logReason = sanitizeLogValue(reason?.toString());
      const closeContext = {
        cause: closeCause,
        handshake: handshakeState,
        durationMs,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        host: logHost,
        origin: logOrigin,
        userAgent: logUserAgent,
        forwardedFor: logForwardedFor,
        ...closeMeta,
      };
      if (!client) {
        const logFn = isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr)
          ? logWsControl.debug
          : logWsControl.warn;
        logFn(
          `closed before connect conn=${connId} remote=${remoteAddr ?? "?"} fwd=${logForwardedFor || "n/a"} origin=${logOrigin || "n/a"} host=${logHost || "n/a"} ua=${logUserAgent || "n/a"} code=${code ?? "n/a"} reason=${logReason || "n/a"}`,
          closeContext,
        );
      }
      if (client && isWebchatClient(client.connect.client)) {
        logWsControl.info(
          `webchat disconnected code=${code} reason=${logReason || "n/a"} conn=${connId}`,
        );
      }
      if (client?.presenceKey) {
        upsertPresence(client.presenceKey, { reason: "disconnect" });
        broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
      }
      if (client?.connect?.role === "node") {
        const context = buildRequestContext();
        const nodeId = context.nodeRegistry.unregister(connId);
        if (nodeId) {
          removeRemoteNodeInfo(nodeId);
          context.nodeUnsubscribeAll(nodeId);
        }
      }
      // Clean up any chat session subscriptions for this connection.
      // Runs for all client types since any client could have called
      // chat.watch or triggered auto-subscribe via chat.send.
      {
        const context = buildRequestContext();
        context.unsubscribeAllChatSessions(connId);
      }
      logWs("out", "close", {
        connId,
        code,
        reason: logReason,
        durationMs,
        cause: closeCause,
        handshake: handshakeState,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
      });
      close();
    });

    const handshakeTimeoutMs = getHandshakeTimeoutMs();
    const handshakeTimer = setTimeout(() => {
      if (!client) {
        handshakeState = "failed";
        setCloseCause("handshake-timeout", {
          handshakeMs: Date.now() - openedAt,
        });
        logWsControl.warn(`handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`);
        close();
      }
    }, handshakeTimeoutMs);

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq,
      connId,
      remoteAddr,
      forwardedFor,
      realIp,
      requestHost,
      requestOrigin,
      requestUserAgent,
      canvasHostUrl,
      connectNonce,
      resolvedAuth,
      rateLimiter,
      browserRateLimiter,
      gatewayMethods,
      events,
      extraHandlers,
      buildRequestContext,
      send,
      close,
      isClosed: () => closed,
      clearHandshakeTimer: () => clearTimeout(handshakeTimer),
      getClient: () => client,
      setClient: (next) => {
        client = next;
        clients.add(next);
      },
      setHandshakeState: (next) => {
        handshakeState = next;
      },
      setCloseCause,
      setLastFrameMeta,
      originCheckMetrics,
      logGateway,
      logHealth,
      logWsControl,
    });
  });
}
