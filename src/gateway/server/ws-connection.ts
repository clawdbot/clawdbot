// Gateway WebSocket connection handler owns pre-auth limits, handshake auth, presence, and message-handler attachment.
import { randomUUID } from "node:crypto";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { RawData, WebSocket, WebSocketServer } from "ws";
import { WORKER_PROTOCOL_MAX_PAYLOAD_BYTES } from "../../../packages/gateway-protocol/src/index.js";
import { GATEWAY_STARTUP_PENDING_CLOSE_CAUSE } from "../../../packages/gateway-protocol/src/startup-unavailable.js";
import { getRuntimeConfig } from "../../config/io.js";
import { recordPairedNodeDisconnection } from "../../infra/device-pairing-node.js";
import { touchPresence, upsertPresence } from "../../infra/system-presence.js";
import { logRejectedLargePayload } from "../../logging/diagnostic-payload.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { removeRemoteNodeInfo } from "../../skills/runtime/remote.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import type { AuthRateLimiter } from "../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { resolvePreauthHandshakeTimeoutMs } from "../handshake-timeouts.js";
import { resolveHostedPluginSurfaceUrl } from "../hosted-plugin-surface-url.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
import type { GatewayMethodRegistry } from "../methods/registry.js";
import { isLoopbackAddress } from "../net.js";
import type { NodeReapprovalCoordinator } from "../node-reapproval-coordinator.js";
import { clearNodeWakeState } from "../node-wake-state.js";
import type { PluginNodeCapabilitySurface } from "../plugin-node-capability.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PREAUTH_PAYLOAD_BYTES,
} from "../server-constants.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import { formatError } from "../server-utils.js";
import {
  classifyGatewayStaleInstall,
  GATEWAY_STALE_INSTALL_CLOSE_REASON,
} from "../stale-install.js";
import { cleanupTalkConnection } from "../talk-session-registry.js";
import { formatForLog, logWs } from "../ws-log.js";
import { getHealthVersion, incrementPresenceVersion } from "./health-state.js";
import type { PreauthConnectionBudget } from "./preauth-connection-budget.js";
import { broadcastPresenceSnapshot } from "./presence-events.js";
import { takePublicWorkerIngress } from "./public-worker-ingress-context.js";
import {
  isWsPayloadLimitError,
  resolveSocketAddress,
  sanitizeWsLogValue,
  stringMetaValue,
} from "./ws-connection-diagnostics.js";
import {
  buildHandshakeAuthLogKey,
  HandshakeAuthLogLimiter,
  shouldLimitMissingCredentialAuthLog,
} from "./ws-connection/handshake-auth-log-limiter.js";
import type { WsOriginCheckMetrics } from "./ws-connection/message-handler.js";
import {
  GatewayNodeLifecycleDispatchTracker,
  NODE_LIFECYCLE_DISPATCH_DRAIN_TIMEOUT_MS,
} from "./ws-connection/node-lifecycle-dispatch.js";
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

const MAX_QUEUED_MESSAGE_HANDLER_FRAMES = 16;
const unauthorizedCloseBeforeConnectLogLimiter = new HandshakeAuthLogLimiter();
type GatewayWsSharedHandlerParams = {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  port: number;
  gatewayHost?: string;
  pluginSurfaceScheme?: "http" | "https";
  getPluginNodeCapabilities?: () => PluginNodeCapabilitySurface[];
  /**
   * Auth is read per connection, not per process: a reload can rotate it while
   * this handler stays attached. One getter keeps that the only source, so no
   * caller can hand over a snapshot that silently outlives the config it came from.
   */
  getResolvedAuth: () => ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  nodeReapprovalCoordinator?: NodeReapprovalCoordinator;
  preauthHandshakeTimeoutMs?: number;
  isStartupPending?: () => boolean;
  isPendingWorkerNodeSetup?: (setupId: string, deviceId: string) => boolean;
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
      const formattedError = formatError(error);
      const staleInstall = classifyGatewayStaleInstall(error);
      if (staleInstall) {
        params.setCloseCause("message-handler-load-failed", {
          error: formattedError,
          staleInstall: true,
          restartCommand: staleInstall.restartCommand,
        });
        params.logWsControl.error(
          `failed to load ws message handler because the OpenClaw installation changed while the Gateway was running conn=${params.connId}; run: ${staleInstall.restartCommand}; error: ${formattedError}`,
        );
        params.close(1011, GATEWAY_STALE_INSTALL_CLOSE_REASON);
        return;
      }
      params.setCloseCause("message-handler-load-failed", {
        error: formattedError,
      });
      params.logWsControl.error(
        `failed to load ws message handler conn=${params.connId}: ${formattedError}`,
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
    getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration = () =>
      resolveSharedGatewaySessionGeneration(
        getResolvedAuth(),
        getRuntimeConfig().gateway?.trustedProxies,
      ),
    rateLimiter,
    browserRateLimiter,
    nodeReapprovalCoordinator,
    isStartupPending,
    isPendingWorkerNodeSetup,
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
    const ingressSocket = socket as GatewayIngressWebSocket;
    const connectionKind = ingressSocket[GATEWAY_WS_CONNECTION_KIND_PROPERTY] ?? "gateway";
    const publicWorkerIngress =
      connectionKind === "worker" ? takePublicWorkerIngress(socket) : undefined;
    const connectionPreauthBudget =
      ingressSocket[GATEWAY_WS_PREAUTH_BUDGET_PROPERTY] ?? preauthConnectionBudget;
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
    const nodeLifecycleDispatch = new GatewayNodeLifecycleDispatchTracker();

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
    let retainClientUntilNodeDrain = false;
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

    const retireTransport = (code = 1000, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(handshakeTimer);
      clearInterval(pingTimer);
      cleanupWorkerConnection?.();
      releasePreauthBudget();
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    const close = (code = 1000, reason?: string) => {
      retireTransport(code, reason);
      if (client && !retainClientUntilNodeDrain) {
        clients.delete(client);
      }
    };

    const send = (obj: unknown) => {
      if (closed) {
        return { kind: "unavailable" } as const;
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
        return { kind: "unavailable" } as const;
      }
      let encoded: string;
      try {
        encoded = JSON.stringify(obj);
      } catch (error) {
        return { kind: "serialization", error } as const;
      }
      try {
        socket.send(encoded);
        return { kind: "sent" } as const;
      } catch {
        return { kind: "unavailable" } as const;
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
      if (client?.presenceKey) {
        touchPresence(client.presenceKey);
      }
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

    const handleSocketClose = async (code: number, reason: Buffer) => {
      const durationMs = Date.now() - openedAt;
      const logForwardedFor = sanitizeWsLogValue(forwardedFor);
      const logOrigin = sanitizeWsLogValue(requestOrigin);
      const logHost = sanitizeWsLogValue(requestHost);
      const logUserAgent = sanitizeWsLogValue(requestUserAgent);
      const logReason = sanitizeWsLogValue(reason?.toString());
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
      if (client?.authenticatedUserId) {
        logWsControl.info(
          `authenticated user disconnected code=${code} reason=${logReason || "n/a"} conn=${connId} user=${formatForLog(client.authenticatedUserId)}`,
        );
      }
      if (connectionKind === "gateway") {
        const context = buildRequestContext();
        cleanupTalkConnection(connId, logGateway);
        context.unsubscribeAllSessionEvents(connId);
        // Detach (or, with a zero grace period, kill) any PTY shells this
        // connection owned; detached sessions stay reattachable via
        // terminal.attach until their reaper fires.
        context.terminalSessions?.handleDisconnect(connId);
        let currentDisconnectedNodeId: string | null = null;
        let disconnectedNodeHistory:
          | {
              nodeId: string;
              connectedAtMs: number;
              disconnectedAtMs: number;
              pairingGeneration: string;
            }
          | undefined;
        if (client?.connect?.role === "node") {
          const nodeId = client.connect.device?.id ?? client.connect.client.id;
          const nodeSession = context.nodeRegistry.get(nodeId);
          if (nodeSession?.connId === connId && nodeSession.pairingGeneration) {
            disconnectedNodeHistory = {
              nodeId: nodeSession.nodeId,
              connectedAtMs: nodeSession.connectedAtMs,
              disconnectedAtMs: Date.now(),
              pairingGeneration: nodeSession.pairingGeneration,
            };
          }
          // Retire I/O immediately, but keep the client revocable until admitted
          // lifecycle work drains; pairing/token removal must still fence it.
          retainClientUntilNodeDrain = true;
          retireTransport();
          try {
            if (nodeLifecycleDispatch.hasActive()) {
              const drained = await nodeLifecycleDispatch.drain();
              if (!drained) {
                logGateway.warn(
                  `node lifecycle dispatch drain timed out after ${NODE_LIFECYCLE_DISPATCH_DRAIN_TIMEOUT_MS}ms conn=${connId}`,
                );
              }
            }
            currentDisconnectedNodeId = context.nodeRegistry.unregister(connId);
            if (
              disconnectedNodeHistory &&
              currentDisconnectedNodeId === disconnectedNodeHistory.nodeId
            ) {
              try {
                await recordPairedNodeDisconnection({
                  nodeId: disconnectedNodeHistory.nodeId,
                  connectedAtMs: disconnectedNodeHistory.connectedAtMs,
                  disconnectedAtMs: disconnectedNodeHistory.disconnectedAtMs,
                  expectedPairingGeneration: {
                    nodeId: disconnectedNodeHistory.nodeId,
                    key: disconnectedNodeHistory.pairingGeneration,
                  },
                });
              } catch (error) {
                logGateway.warn(
                  `failed to record node disconnect for ${disconnectedNodeHistory.nodeId}: ${formatForLog(error)}`,
                );
              }
            }
          } finally {
            retainClientUntilNodeDrain = false;
          }
        }
        if (
          client?.presenceKey &&
          (client.connect.role !== "node" || currentDisconnectedNodeId !== null)
        ) {
          upsertPresence(client.presenceKey, {
            reason: "disconnect",
            watchedSessions: undefined,
          });
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
    };
    socket.once("close", (code, reason) => {
      void handleSocketClose(code, reason).catch((error: unknown) => {
        logGateway.error(`websocket close cleanup failed conn=${connId}: ${formatError(error)}`);
        close();
      });
    });

    const setClient = (next: GatewayWsClient) => {
      // Concurrent connect frames can finish authentication out of order. Keep
      // one socket owner so a raced finalizer cannot leak a client or ping loop.
      if (closed || client) {
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
        publicAdmission: publicWorkerIngress,
      });
      return;
    }

    const ingressAttribution = readPreparedGatewayIngressAttribution(upgradeReq);
    if (!ingressAttribution || ingressAttribution.kind === "unattributable-proxy") {
      setCloseCause("missing-ingress-attribution");
      logWsControl.warn(`gateway websocket missing prepared ingress attribution conn=${connId}`);
      close(1008, "gateway ingress attribution required");
      return;
    }

    attachGatewayWsMessageHandlerOnDemand({
      socket,
      upgradeReq,
      ingressAttribution,
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
      isPendingWorkerNodeSetup,
      gatewayMethods,
      events,
      extraHandlers,
      getMethodRegistry,
      buildRequestContext,
      nodeLifecycleDispatch,
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
