// Gateway WebSocket connection handler owns pre-auth limits, handshake auth, presence, and message-handler attachment.
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_STARTUP_PENDING_CLOSE_CAUSE } from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { getRuntimeConfig } from "../../config/io.js";
import { upsertPresence } from "../../infra/system-presence.js";
import { logRejectedLargePayload } from "../../logging/diagnostic-payload.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { removeRemoteNodeInfo } from "../../skills/runtime/remote.js";
import { truncateUtf16Safe } from "../../utils.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { resolvePreauthHandshakeTimeoutMs } from "../handshake-timeouts.js";
import { resolveHostedPluginSurfaceUrl } from "../hosted-plugin-surface-url.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import { isLoopbackAddress } from "../net.js";
import type { NodeReapprovalCoordinator } from "../node-reapproval-coordinator.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PREAUTH_PAYLOAD_BYTES,
} from "../server-constants.js";
import { clearNodeWakeState } from "../server-methods/nodes-wake-state.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import { formatError } from "../server-utils.js";
import { logWs } from "../ws-log.js";
import { getHealthVersion, incrementPresenceVersion } from "./health-state.js";
import type { PreauthConnectionBudget } from "./preauth-connection-budget.js";
import { broadcastPresenceSnapshot } from "./presence-events.js";
import {
  buildHandshakeAuthLogKey,
  HandshakeAuthLogLimiter,
  shouldLimitMissingCredentialAuthLog,
} from "./ws-connection/handshake-auth-log-limiter.js";
import type { WsOriginCheckMetrics } from "./ws-connection/message-handler.js";
import {
  attachWorkerWsMessageHandler,
  type WorkerConnectionService,
} from "./ws-connection/worker-connection.js";
import { resolveSharedGatewaySessionGeneration } from "./ws-shared-generation.js";
import {
  GATEWAY_WS_CONNECTION_KIND_PROPERTY,
  GATEWAY_WS_PREAUTH_BUDGET_PROPERTY,
  WS_HANDSHAKE_PHASES,
  type GatewayIngressWebSocket,
  type GatewayWsClient,
  type WsHandshakePhase,
} from "./ws-types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const LOG_HEADER_MAX_LEN = 300;
const LOG_HEADER_FORMAT_REGEX = /\p{Cf}/gu;
const MAX_QUEUED_MESSAGE_HANDLER_FRAMES = 16;
const unauthorizedCloseBeforeConnectLogLimiter = new HandshakeAuthLogLimiter();

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

function stringMetaValue(meta: Record<string, unknown>, key: string): string | undefined {
  const value = meta[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
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

function formatSocketEndpoint(
  address: string | undefined,
  port: number | undefined,
): string | undefined {
  if (!address) {
    return undefined;
  }
  if (port === undefined) {
    return address;
  }
  return address.includes(":") ? `[${address}]:${port}` : `${address}:${port}`;
}

function resolveSocketAddress(socket: WebSocket): {
  remoteAddr?: string;
  remotePort?: number;
  localAddr?: string;
  localPort?: number;
  endpoint?: string;
} {
  const rawSocket = (socket as WebSocket & { _socket?: Socket })["_socket"];
  const remoteAddr = rawSocket?.remoteAddress;
  const remotePort = rawSocket?.remotePort;
  const localAddr = rawSocket?.localAddress;
  const localPort = rawSocket?.localPort;
  const remoteEndpoint = formatSocketEndpoint(remoteAddr, remotePort);
  const localEndpoint = formatSocketEndpoint(localAddr, localPort);
  return {
    remoteAddr,
    remotePort,
    localAddr,
    localPort,
    endpoint:
      remoteEndpoint && localEndpoint
        ? `${remoteEndpoint}->${localEndpoint}`
        : (remoteEndpoint ?? localEndpoint),
  };
}

function isWsPayloadLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const code = (err as { code?: unknown }).code;
  if (code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && /max payload size exceeded/i.test(message);
}

export type GatewayWsSharedHandlerParams = {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  port: number;
  gatewayHost?: string;
  pluginSurfaceScheme?: "http" | "https";
  getPluginNodeCapabilities?: () => PluginNodeCapabilitySurface[];
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  nodeReapprovalCoordinator?: NodeReapprovalCoordinator;
  preauthHandshakeTimeoutMs?: number;
  isStartupPending?: () => boolean;
  gatewayMethods: string[];
  events: string[];
  refreshHealthSnapshot: GatewayRequestContext["refreshHealthSnapshot"];
};

export type AttachGatewayWsConnectionHandlerParams = GatewayWsSharedHandlerParams & {
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
  extraHandlers: GatewayRequestHandlers;
  getMethodRegistry?: () => GatewayMethodRegistry;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  buildRequestContext: () => GatewayRequestContext;
  workerConnectionService?: WorkerConnectionService;
};

function attachGatewayWsMessageHandlerOnDemand(
  params: import("./ws-connection/message-handler.js").GatewayWsMessageHandlerParams,
): void {
  const queued: RawData[] = [];
  const queueMessage = (data: RawData) => {
    if (queued.length >= MAX_QUEUED_MESSAGE_HANDLER_FRAMES) {
      params.setCloseCause("message-handler-loading-overflow", {
        queuedFrames: queued.length,
      });
      params.close(1008, "gateway message handler loading");
      return;
    }
    queued.push(data);
  };
  params.socket.on("message", queueMessage);
  void import("./ws-connection/message-handler.js")
    .then(({ attachGatewayWsMessageHandler }) => {
      params.socket.off("message", queueMessage);
      if (params.isClosed()) {
        return;
      }
      attachGatewayWsMessageHandler(params);
      for (const data of queued) {
        params.socket.emit("message", data);
      }
    })
    .catch((error: unknown) => {
      params.socket.off("message", queueMessage);
      params.setCloseCause("message-handler-load-failed", {
        error: formatError(error),
      });
      params.logWsControl.warn(
        `failed to load ws message handler conn=${params.connId}: ${formatError(error)}`,
      );
      params.close(1011, "gateway message handler unavailable");
    });
}

export function attachGatewayWsConnectionHandler(params: AttachGatewayWsConnectionHandlerParams) {
  const {
    wss,
    clients,
    preauthConnectionBudget,
    port,
    pluginSurfaceScheme,
    getPluginNodeCapabilities,
    resolvedAuth,
    getResolvedAuth = () => resolvedAuth,
    getRequiredSharedGatewaySessionGeneration = () =>
      resolveSharedGatewaySessionGeneration(
        getResolvedAuth(),
        getRuntimeConfig().gateway?.trustedProxies,
      ),
    rateLimiter,
    browserRateLimiter,
    nodeReapprovalCoordinator,
    isStartupPending,
    gatewayMethods,
    events,
    refreshHealthSnapshot,
    logGateway,
    logHealth,
    logWsControl,
    extraHandlers,
    getMethodRegistry,
    broadcast,
    buildRequestContext,
    workerConnectionService,
  } = params;
  const originCheckMetrics: WsOriginCheckMetrics = { hostHeaderFallbackAccepted: 0 };

  wss.on("connection", (socket, upgradeReq) => {
    let client: GatewayWsClient | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();
    const connectionKind =
      (socket as GatewayIngressWebSocket)[GATEWAY_WS_CONNECTION_KIND_PROPERTY] ?? "gateway";
    const connectionPreauthBudget =
      (socket as GatewayIngressWebSocket)[GATEWAY_WS_PREAUTH_BUDGET_PROPERTY] ??
      preauthConnectionBudget;
    const { remoteAddr, remotePort, localAddr, localPort, endpoint } = resolveSocketAddress(socket);
    const preauthBudgetKey = (
      socket as WebSocket & {
        __openclawPreauthBudgetClaimed?: boolean;
        __openclawPreauthBudgetKey?: string;
      }
    )["__openclawPreauthBudgetKey"];
    (
      socket as WebSocket & {
        __openclawPreauthBudgetClaimed?: boolean;
      }
    )["__openclawPreauthBudgetClaimed"] = true;
    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    const requestHost = headerValue(upgradeReq.headers.host);
    const requestOrigin = headerValue(upgradeReq.headers.origin);
    const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
    const forwardedFor = headerValue(upgradeReq.headers["x-forwarded-for"]);
    const realIp = headerValue(upgradeReq.headers["x-real-ip"]);
    const openedDuringStartup = isStartupPending?.() === true;

    const pluginNodeCapabilities =
      connectionKind === "gateway" ? (getPluginNodeCapabilities?.() ?? []) : [];
    const pluginSurfaceBaseUrl =
      pluginNodeCapabilities.length > 0
        ? resolveHostedPluginSurfaceUrl({
            port,
            forwardedHost: upgradeReq.headers["x-forwarded-host"],
            requestHost: upgradeReq.headers.host,
            forwardedProto: upgradeReq.headers["x-forwarded-proto"],
            localAddress: upgradeReq.socket?.localAddress,
            scheme: pluginSurfaceScheme,
          })
        : undefined;

    logWs("in", "open", { connId, remoteAddr, remotePort, localAddr, localPort, endpoint });
    let handshakeState: "pending" | "connected" | "failed" = "pending";
    let lastHandshakePhase: WsHandshakePhase = "tcp_accepted";
    let holdsPreauthBudget = true;
    let closeCause: string | undefined;
    let closeMeta: Record<string, unknown> = {};
    let lastFrameType: string | undefined;
    let lastFrameMethod: string | undefined;
    let lastFrameId: string | undefined;
    let hasReceivedPreauthFrame = false;

    socket.once("message", () => {
      hasReceivedPreauthFrame = true;
    });

    const advanceHandshakePhase = (next: WsHandshakePhase) => {
      if (WS_HANDSHAKE_PHASES.indexOf(next) > WS_HANDSHAKE_PHASES.indexOf(lastHandshakePhase)) {
        lastHandshakePhase = next;
      }
    };

    const setCloseCause = (cause: string, meta?: Record<string, unknown>) => {
      if (!closeCause) {
        closeCause = cause;
      }
      if (meta && Object.keys(meta).length > 0) {
        closeMeta = { ...closeMeta, ...meta };
      }
    };

    const releasePreauthBudget = () => {
      if (!holdsPreauthBudget) {
        return;
      }
      holdsPreauthBudget = false;
      connectionPreauthBudget.release(preauthBudgetKey);
    };

    const setLastFrameMeta = (meta: { type?: string; method?: string; id?: string }) => {
      if (meta.type || meta.method || meta.id) {
        lastFrameType = meta.type ?? lastFrameType;
        lastFrameMethod = meta.method ?? lastFrameMethod;
        lastFrameId = meta.id ?? lastFrameId;
      }
    };

    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let cleanupWorkerConnection: (() => void) | undefined;
    let awaitingPong = false;
    const handshakeTimeoutMs = resolvePreauthHandshakeTimeoutMs({
      configuredTimeoutMs: params.preauthHandshakeTimeoutMs,
    });
    const handshakeTimer = setTimeout(() => {
      if (!client) {
        handshakeState = "failed";
        setCloseCause("handshake-timeout", {
          handshakeMs: Date.now() - openedAt,
          endpoint,
          phase: lastHandshakePhase,
        });
        logWsControl.warn(
          `handshake timeout conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"} phase=${lastHandshakePhase}`,
        );
        if (connectionKind === "worker") {
          close(1008, "invalid-handshake");
        } else {
          close();
        }
      }
    }, handshakeTimeoutMs);

    const close = (code = 1000, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(handshakeTimer);
      if (pingTimer !== undefined) {
        clearInterval(pingTimer);
      }
      cleanupWorkerConnection?.();
      releasePreauthBudget();
      if (client) {
        clients.delete(client);
      }
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    const send = (obj: unknown) => {
      if (closed) {
        return;
      }
      if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
        logRejectedLargePayload({
          surface: "gateway.ws.outbound_buffer",
          bytes: socket.bufferedAmount,
          limitBytes: MAX_BUFFERED_BYTES,
          reason: "ws_send_buffer_close",
        });
        setCloseCause("outbound-buffer-exceeded", {
          bytes: socket.bufferedAmount,
          limitBytes: MAX_BUFFERED_BYTES,
        });
        close(1008, connectionKind === "worker" ? "slow-consumer" : "slow consumer");
        return;
      }
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const connectNonce = randomUUID();
    if (connectionKind === "gateway") {
      send({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: connectNonce, ts: Date.now() },
      });
    }
    advanceHandshakePhase("ws_upgrade_started");

    socket.once("error", (err) => {
      if (isWsPayloadLimitError(err)) {
        const workerPayload = connectionKind === "worker";
        logRejectedLargePayload({
          surface: client ? "gateway.ws.frame" : "gateway.ws.preauth",
          limitBytes: workerPayload
            ? WORKER_PROTOCOL_MAX_PAYLOAD_BYTES
            : client
              ? MAX_PAYLOAD_BYTES
              : MAX_PREAUTH_PAYLOAD_BYTES,
          reason: client ? "ws_frame_limit" : "preauth_frame_limit",
        });
      }
      logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
      if (connectionKind === "worker") {
        close(1008, client ? "invalid-frame" : "invalid-handshake");
      } else {
        close();
      }
    });

    socket.on("pong", () => {
      awaitingPong = false;
    });

    const isNoisySwiftPmHelperClose = (userAgent: string | undefined, remote: string | undefined) =>
      normalizeLowercaseStringOrEmpty(userAgent).includes("swiftpm-testing-helper") &&
      isLoopbackAddress(remote);

    const isExpectedLocalAppStartupAbort = (code: number) =>
      openedDuringStartup &&
      (code === 1001 || code === 1006) &&
      lastHandshakePhase === "ws_upgrade_started" &&
      !hasReceivedPreauthFrame &&
      lastFrameType === undefined &&
      normalizeLowercaseStringOrEmpty(requestUserAgent).startsWith("openclaw/") &&
      isLoopbackAddress(remoteAddr);

    socket.once("close", (code, reason) => {
      const durationMs = Date.now() - openedAt;
      const logForwardedFor = sanitizeLogValue(forwardedFor);
      const logOrigin = sanitizeLogValue(requestOrigin);
      const logHost = sanitizeLogValue(requestHost);
      const logUserAgent = sanitizeLogValue(requestUserAgent);
      const logReason = sanitizeLogValue(reason?.toString());
      const handshakeIncomplete = lastHandshakePhase !== "ready";
      const closeContext = {
        cause: closeCause,
        handshake: handshakeState,
        ...(handshakeIncomplete ? { phase: lastHandshakePhase } : {}),
        durationMs,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        host: logHost,
        origin: logOrigin,
        userAgent: logUserAgent,
        forwardedFor: logForwardedFor,
        remoteAddr,
        remotePort,
        localAddr,
        localPort,
        endpoint,
        ...closeMeta,
      };
      if (!client) {
        const isExpectedStartupRetryClose = closeCause === GATEWAY_STARTUP_PENDING_CLOSE_CAUSE;
        const logFn =
          isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr) ||
          isExpectedStartupRetryClose ||
          isExpectedLocalAppStartupAbort(code)
            ? logWsControl.debug
            : logWsControl.warn;
        const authReason = stringMetaValue(closeMeta, "authReason");
        // This pre-connect close path has no client object yet; treat only
        // missing shared credentials as suppressible startup retry noise.
        const shouldLimitMissingAuthClose =
          closeCause === "unauthorized" &&
          shouldLimitMissingCredentialAuthLog({
            reason: authReason,
            authProvided: "none",
          });
        const closeLogDecision = shouldLimitMissingAuthClose
          ? unauthorizedCloseBeforeConnectLogLimiter.register(
              buildHandshakeAuthLogKey({
                reason: authReason,
                remoteAddr,
                client:
                  stringMetaValue(closeMeta, "clientDisplayName") ??
                  stringMetaValue(closeMeta, "client"),
                mode: stringMetaValue(closeMeta, "mode"),
                authProvided: "none",
              }),
            )
          : { shouldLog: true, suppressedSinceLastLog: 0 };
        if (closeLogDecision.shouldLog) {
          const suppressedText =
            closeLogDecision.suppressedSinceLastLog > 0
              ? ` suppressed=${closeLogDecision.suppressedSinceLastLog}`
              : "";
          logFn(
            `closed before connect conn=${connId} peer=${endpoint ?? "n/a"} remote=${remoteAddr ?? "?"} fwd=${logForwardedFor || "n/a"} origin=${logOrigin || "n/a"} host=${logHost || "n/a"} ua=${logUserAgent || "n/a"} code=${code ?? "n/a"} reason=${logReason || "n/a"} phase=${lastHandshakePhase}${suppressedText}`,
            closeContext,
          );
        }
      }
      if (client && isWebchatClient(client.connect.client)) {
        logWsControl.info(
          `webchat disconnected code=${code} reason=${logReason || "n/a"} conn=${connId}`,
        );
      }
      if (connectionKind === "gateway") {
        const context = buildRequestContext();
        context.unsubscribeAllSessionEvents(connId);
        // Detach (or, with a zero grace period, kill) any PTY shells this
        // connection owned; detached sessions stay reattachable via
        // terminal.attach until their reaper fires.
        context.terminalSessions?.handleDisconnect(connId);
        let currentDisconnectedNodeId: string | null = null;
        if (client?.connect?.role === "node") {
          currentDisconnectedNodeId = context.nodeRegistry.unregister(connId);
        }
        if (
          client?.presenceKey &&
          (client.connect.role !== "node" || currentDisconnectedNodeId !== null)
        ) {
          upsertPresence(client.presenceKey, { reason: "disconnect" });
          broadcastPresenceSnapshot({ broadcast, incrementPresenceVersion, getHealthVersion });
        }
        if (currentDisconnectedNodeId) {
          removeRemoteNodeInfo(currentDisconnectedNodeId);
          context.nodeUnsubscribeAll(currentDisconnectedNodeId);
          clearNodeWakeState(currentDisconnectedNodeId);
        }
      }
      logWs("out", "close", {
        connId,
        code,
        reason: logReason,
        durationMs,
        cause: closeCause,
        handshake: handshakeState,
        ...(handshakeIncomplete ? { phase: lastHandshakePhase } : {}),
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        endpoint,
      });
      close();
    });

    const setClient = (next: GatewayWsClient) => {
      if (closed) {
        return false;
      }
      if (next.worker) {
        for (const existing of clients) {
          if (existing.worker?.environmentId === next.worker.environmentId) {
            // Fence queued frames before transport teardown releases the old handler and timers.
            existing.invalidated = true;
            clients.delete(existing);
            try {
              existing.socket.terminate();
            } catch {
              existing.socket.close(1008, "credential-replaced");
            }
          }
        }
      }
      releasePreauthBudget();
      client = next;
      clients.add(next);
      pingTimer = setInterval(() => {
        // A half-open TCP connection can remain OPEN indefinitely. Terminate
        // after one missed pong so the normal close handler releases node state.
        if (awaitingPong) {
          setCloseCause("heartbeat-timeout");
          try {
            socket.terminate();
          } catch {
            close();
          }
          return;
        }
        awaitingPong = true;
        try {
          socket.ping();
        } catch {
          // close() clears the timer; ping can race with a socket already entering CLOSING.
        }
      }, 25_000);
      return true;
    };

    if (connectionKind === "worker") {
      cleanupWorkerConnection = attachWorkerWsMessageHandler({
        socket,
        connId,
        service: workerConnectionService,
        isStartupPending,
        send,
        close,
        isClosed: () => closed,
        clearHandshakeTimer: () => clearTimeout(handshakeTimer),
        getClient: () => client,
        setClient,
        setHandshakeState: (next) => {
          handshakeState = next;
        },
        advanceHandshakePhase,
        setCloseCause,
        setLastFrameMeta,
        logGateway,
        logWsControl,
      });
      return;
    }

    attachGatewayWsMessageHandlerOnDemand({
      socket,
      upgradeReq,
      connId,
      remoteAddr,
      remotePort,
      localAddr,
      localPort,
      endpoint,
      forwardedFor,
      realIp,
      requestHost,
      requestOrigin,
      requestUserAgent,
      pluginSurfaceBaseUrl,
      pluginNodeCapabilities,
      connectNonce,
      getResolvedAuth,
      getRequiredSharedGatewaySessionGeneration,
      rateLimiter,
      browserRateLimiter,
      nodeReapprovalCoordinator,
      isStartupPending,
      gatewayMethods,
      events,
      extraHandlers,
      getMethodRegistry,
      buildRequestContext,
      refreshHealthSnapshot,
      send,
      close,
      isClosed: () => closed,
      clearHandshakeTimer: () => clearTimeout(handshakeTimer),
      getClient: () => client,
      setClient,
      setHandshakeState: (next) => {
        handshakeState = next;
      },
      advanceHandshakePhase,
      setCloseCause,
      setLastFrameMeta,
      originCheckMetrics,
      logGateway,
      logHealth,
      logWsControl,
    });
  });
}
