// WebSocket message handler validates frames, dispatches gateway RPCs, manages pairing, and reports responses.
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import type { RawData } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  type ConnectParams,
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateConnectParams,
  validateRequestFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  GATEWAY_RESTART_UNAVAILABLE_REASON,
  GATEWAY_SUSPEND_UNAVAILABLE_REASON,
} from "../../../../packages/gateway-protocol/src/restart-unavailable.js";
import { getRuntimeConfig } from "../../../config/io.js";
import {
  releaseNodePairingCleanupClaim,
  type NodePairingCleanupClaim,
  type RequestNodePairingResult,
} from "../../../infra/device-pairing-node.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { rawDataByteLength } from "../../../infra/ws.js";
import { logRejectedLargePayload } from "../../../logging/diagnostic-payload.js";
import {
  getGatewaySuspendAdmissionPhase,
  isGatewayRestartDraining,
  runWithGatewayIndependentRootWorkAdmission,
  tryBeginGatewayRestartStartupRootWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../../../process/gateway-work-admission.js";
import { isWebchatClient } from "../../../utils/message-channel.js";
import { isLocalishHost, isLoopbackAddress } from "../../net.js";
import { resolveNodePairingClientIpSource } from "../../node-pairing-auto-approve.js";
import { MAX_PREAUTH_PAYLOAD_BYTES } from "../../server-constants.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import { createGatewayAuthenticatedRequestDispatcher } from "./authenticated-request-dispatch.js";
import { isStartupNodeConnect } from "./connect-admission.js";
import { authenticateGatewayConnect } from "./connect-auth.js";
import { authorizeGatewayConnectDevice } from "./connect-device-pairing.js";
import { attachAuthenticatedGatewayConnect } from "./connect-session.js";
import { resolveHandshakeBrowserSecurityContext } from "./handshake-auth-helpers.js";
import type {
  GatewayConnectPhaseContext,
  GatewayWsMessageHandlerParams,
} from "./message-handler-types.js";
export type {
  GatewayWsMessageHandlerParams,
  WsOriginCheckMetrics,
} from "./message-handler-types.js";

const GATEWAY_WORK_ADMISSION_RETRY_AFTER_MS = 1_000;
const GATEWAY_WORK_ADMISSION_CLOSE_CODE = 1013;
function claimsWorkerConnectionIdentity(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  const connect = value as { role?: unknown; client?: unknown };
  if (connect.role === "worker") {
    return true;
  }
  if (!connect.client || typeof connect.client !== "object") {
    return false;
  }
  const client = connect.client as { id?: unknown; mode?: unknown };
  return client.id === GATEWAY_CLIENT_IDS.WORKER || client.mode === GATEWAY_CLIENT_MODES.WORKER;
}

export function attachGatewayWsMessageHandler(params: GatewayWsMessageHandlerParams) {
  const {
    socket,
    ingressAttribution,
    connId,
    remoteAddr,
    endpoint,
    forwardedFor,
    requestHost,
    requestOrigin,
    requestUserAgent,
    rateLimiter,
    browserRateLimiter,
    buildRequestContext,
    send,
    close,
    isClosed,
    getClient,
    setHandshakeState,
    setCloseCause,
    setLastFrameMeta,
    logGateway,
    logWsControl,
  } = params;

  const sendFrame = async (obj: unknown): Promise<void> =>
    await new Promise<void>((resolve, reject) => {
      socket.send(JSON.stringify(obj), (err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

  const configSnapshot = getRuntimeConfig();
  const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
  const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
  const clientIp = ingressAttribution.clientIp;
  const peerLabel = endpoint ?? remoteAddr ?? "n/a";

  const hasProxyHeaders =
    ingressAttribution.kind === "trusted-proxy" ||
    ingressAttribution.kind === "tailscale-serve" ||
    ingressAttribution.kind === "tailscale-funnel";
  const remoteIsTrustedProxy =
    ingressAttribution.kind === "trusted-proxy" ||
    ingressAttribution.kind === "tailscale-serve" ||
    ingressAttribution.kind === "tailscale-funnel";
  const hostIsLocalish = isLocalishHost(requestHost);
  const isLocalClient = ingressAttribution.kind === "direct-local";
  const reportedClientIp = isLocalClient
    ? undefined
    : clientIp && !isLoopbackAddress(clientIp)
      ? clientIp
      : undefined;
  const reportedClientIpSource = resolveNodePairingClientIpSource({
    reportedClientIp,
    hasProxyHeaders,
    remoteIsTrustedProxy,
    remoteIsLoopback: isLoopbackAddress(remoteAddr),
  });

  if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) {
    logWsControl.warn(
      "Loopback connection with non-local Host header. " +
        "Treating it as remote. If you're behind a reverse proxy, " +
        "set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.",
    );
  }

  const isWebchatConnect = (p: ConnectParams | null | undefined) => isWebchatClient(p?.client);
  const authenticatedRequestDispatcher = createGatewayAuthenticatedRequestDispatcher({
    handler: params,
    isWebchatConnect,
  });
  const browserSecurity = resolveHandshakeBrowserSecurityContext({
    requestOrigin,
    clientIp: ingressAttribution.rateLimit.subject.key,
    rateLimiter,
    browserRateLimiter,
  });
  const {
    hasBrowserOriginHeader,
    enforceOriginCheckForAnyClient,
    rateLimitClientIp: browserRateLimitClientIp,
    authRateLimiter,
  } = browserSecurity;
  const runDetachedConnectWork = (run: () => Promise<void>, onError: (error: unknown) => void) => {
    // Connect-triggered mutations outlive hello-ok. Give each tail its own
    // root lease so suspension cannot report ready while one is still active.
    void runWithGatewayIndependentRootWorkAdmission(run, "ws:preauth").catch(onError);
  };

  const handleMessage = async (data: RawData) => {
    if (isClosed()) {
      return;
    }

    const preauthPayloadBytes = !getClient() ? rawDataByteLength(data) : undefined;
    if (preauthPayloadBytes !== undefined && preauthPayloadBytes > MAX_PREAUTH_PAYLOAD_BYTES) {
      logRejectedLargePayload({
        surface: "gateway.ws.preauth",
        bytes: preauthPayloadBytes,
        limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
        reason: "preauth_frame_limit",
      });
      setHandshakeState("failed");
      setCloseCause("preauth-payload-too-large", {
        payloadBytes: preauthPayloadBytes,
        limitBytes: MAX_PREAUTH_PAYLOAD_BYTES,
      });
      close(1009, "preauth payload too large");
      return;
    }

    const text = rawDataToString(data);
    // Connect phases share cleanup ownership; the outer catch must release
    // any claim installed before a later phase fails.
    const pendingNodePairingCleanup: { value?: NodePairingCleanupClaim } = {};
    const broadcastNodePairingResult = (result: RequestNodePairingResult) => {
      const context = buildRequestContext();
      const resolvedAt = Date.now();
      for (const superseded of result.created ? (result.superseded ?? []) : []) {
        context.broadcast(
          "node.pair.resolved",
          {
            requestId: superseded.requestId,
            nodeId: superseded.nodeId,
            decision: "rejected",
            ts: resolvedAt,
          },
          { dropIfSlow: true },
        );
      }
      if (result.created) {
        context.broadcast("node.pair.requested", result.request, {
          dropIfSlow: true,
        });
      }
    };
    const releasePendingNodePairingCleanup = async () => {
      const claim = pendingNodePairingCleanup.value;
      pendingNodePairingCleanup.value = undefined;
      if (!claim) {
        return;
      }
      try {
        await releaseNodePairingCleanupClaim(claim);
      } catch (error) {
        logGateway.warn(
          `failed to release pending pairing cleanup for ${claim.nodeId}: ${formatForLog(error)}`,
        );
      }
    };
    try {
      const parsed = JSON.parse(text);
      const client = getClient();
      if (
        !client &&
        parsed !== null &&
        typeof parsed === "object" &&
        "params" in parsed &&
        claimsWorkerConnectionIdentity(parsed.params)
      ) {
        setHandshakeState("failed");
        setCloseCause("invalid-handshake", { handshakeError: "invalid worker handshake" });
        logWsControl.warn("worker admission rejected reason=invalid-handshake");
        close(1008, "invalid-handshake");
        return;
      }
      const frameType =
        parsed && typeof parsed === "object" && "type" in parsed
          ? typeof (parsed as { type?: unknown }).type === "string"
            ? String((parsed as { type?: unknown }).type)
            : undefined
          : undefined;
      const frameMethod =
        parsed && typeof parsed === "object" && "method" in parsed
          ? typeof (parsed as { method?: unknown }).method === "string"
            ? String((parsed as { method?: unknown }).method)
            : undefined
          : undefined;
      const frameId =
        parsed && typeof parsed === "object" && "id" in parsed
          ? typeof (parsed as { id?: unknown }).id === "string"
            ? String((parsed as { id?: unknown }).id)
            : undefined
          : undefined;
      if (frameType || frameMethod || frameId) {
        setLastFrameMeta({ type: frameType, method: frameMethod, id: frameId });
      }

      if (!client) {
        // Handshake must be a normal request:
        // { type:"req", method:"connect", params: ConnectParams }.
        const isRequestFrame = validateRequestFrame(parsed);
        if (
          !isRequestFrame ||
          parsed.method !== "connect" ||
          !validateConnectParams(parsed.params)
        ) {
          const handshakeError = isRequestFrame
            ? parsed.method === "connect"
              ? `invalid connect params: ${formatValidationErrors(validateConnectParams.errors)}`
              : "invalid handshake: first request must be connect"
            : "invalid request frame";
          setHandshakeState("failed");
          setCloseCause("invalid-handshake", {
            frameType,
            frameMethod,
            frameId,
            handshakeError,
          });
          if (isRequestFrame) {
            const req = parsed;
            send({
              type: "res",
              id: req.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, handshakeError),
            });
          } else {
            logWsControl.warn(
              `invalid handshake conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} fwd=${formatForLog(forwardedFor ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")}`,
            );
          }
          const closeReason = truncateCloseReason(handshakeError || "invalid handshake");
          if (isRequestFrame) {
            queueMicrotask(() => close(1008, closeReason));
          } else {
            close(1008, closeReason);
          }
          return;
        }

        const frame = parsed;
        const connectParams = frame.params as ConnectParams;
        const clientLabel = connectParams.client.displayName ?? connectParams.client.id;
        const clientMeta = {
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          mode: connectParams.client.mode,
          version: connectParams.client.version,
          buildId: connectParams.client.buildId,
          platform: connectParams.client.platform,
          deviceFamily: connectParams.client.deviceFamily,
          modelIdentifier: connectParams.client.modelIdentifier,
          instanceId: connectParams.client.instanceId,
        };
        const markHandshakeFailure = (cause: string, meta?: Record<string, unknown>) => {
          setHandshakeState("failed");
          setCloseCause(cause, { ...meta, ...clientMeta });
        };
        const sendHandshakeErrorResponse = (
          code: Parameters<typeof errorShape>[0],
          message: string,
          options?: Parameters<typeof errorShape>[2],
        ) => {
          send({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(code, message, options),
          });
        };

        const phaseContext = {
          handler: params,
          frame,
          connectParams,
          configSnapshot,
          trustedProxies,
          allowRealIpFallback,
          peerLabel,
          hasProxyHeaders,
          isLocalClient,
          reportedClientIp,
          reportedClientIpSource,
          hasBrowserOriginHeader,
          enforceOriginCheckForAnyClient,
          browserRateLimitClientIp,
          authRateLimiter,
          clientLabel,
          clientMeta,
          markHandshakeFailure,
          sendHandshakeErrorResponse,
          sendFrame,
          isWebchatConnect,
          runDetachedConnectWork,
          pendingNodePairingCleanup,
          broadcastNodePairingResult,
          releasePendingNodePairingCleanup,
        } satisfies GatewayConnectPhaseContext;
        const authenticated = await authenticateGatewayConnect(phaseContext);
        if (!authenticated) {
          return;
        }
        const deviceAuthorized = await authorizeGatewayConnectDevice(phaseContext, authenticated);
        if (!deviceAuthorized) {
          return;
        }
        await attachAuthenticatedGatewayConnect(phaseContext, deviceAuthorized);
        return;
      }
      await authenticatedRequestDispatcher.dispatch(parsed, client, rawDataByteLength(data));
    } catch (err) {
      await releasePendingNodePairingCleanup();
      logGateway.error(`parse/handle error: ${String(err)}`);
      logWs("out", "parse-error", { connId, error: formatForLog(err) });
      if (!getClient()) {
        close();
      }
    }
  };

  const parsePreauthConnectFrame = (
    data: RawData,
  ): { id: string; params: ConnectParams } | null => {
    if (isClosed() || rawDataByteLength(data) > MAX_PREAUTH_PAYLOAD_BYTES) {
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawDataToString(data));
    } catch {
      return null;
    }
    if (
      !validateRequestFrame(parsed) ||
      parsed.method !== "connect" ||
      !validateConnectParams(parsed.params)
    ) {
      return null;
    }
    return { id: parsed.id, params: parsed.params };
  };

  const isPreparedControlConnect = (data: RawData): boolean => {
    const parsed = parsePreauthConnectFrame(data);
    if (!parsed) {
      return false;
    }
    const connectParams = parsed.params as { role?: unknown };
    return connectParams.role !== "node" && !claimsWorkerConnectionIdentity(parsed.params);
  };

  const isStartupNodePreauth = (data: RawData): boolean => {
    const parsed = parsePreauthConnectFrame(data);
    return parsed ? isStartupNodeConnect(parsed.params) : false;
  };

  const rejectConnectForClosedAdmission = async (data: RawData): Promise<boolean> => {
    const parsed = parsePreauthConnectFrame(data);
    if (!parsed) {
      return false;
    }

    const restartDraining = isGatewayRestartDraining();
    const reason = restartDraining
      ? GATEWAY_RESTART_UNAVAILABLE_REASON
      : GATEWAY_SUSPEND_UNAVAILABLE_REASON;
    const operation = restartDraining ? "restart" : "suspension";
    const phase = getGatewaySuspendAdmissionPhase();
    setLastFrameMeta({ type: "req", method: "connect", id: parsed.id });
    setHandshakeState("failed");
    setCloseCause(reason, {
      method: "connect",
      phase,
    });
    await sendFrame({
      type: "res",
      id: parsed.id,
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, `connect unavailable during gateway ${operation}`, {
        retryable: true,
        retryAfterMs: GATEWAY_WORK_ADMISSION_RETRY_AFTER_MS,
        details: {
          method: "connect",
          reason,
          phase,
        },
      }),
    }).catch(() => {});
    queueMicrotask(() =>
      close(GATEWAY_WORK_ADMISSION_CLOSE_CODE, `gateway ${operation} in progress`),
    );
    return true;
  };

  const handleIncomingMessage = async (data: RawData) => {
    if (getClient()) {
      await handleMessage(data);
      return;
    }
    const admission = tryBeginGatewayRootWorkAdmission("ws:connect");
    if (!admission) {
      if (
        isGatewayRestartDraining() &&
        getGatewaySuspendAdmissionPhase() === "accepting" &&
        params.isStartupPending?.() === true &&
        isStartupNodePreauth(data)
      ) {
        const startupAdmission = tryBeginGatewayRestartStartupRootWorkAdmission();
        if (startupAdmission) {
          try {
            await startupAdmission.run(() => handleMessage(data));
          } finally {
            startupAdmission.release();
          }
          return;
        }
      }
      if (
        !isGatewayRestartDraining() &&
        (getGatewaySuspendAdmissionPhase() === "draining" ||
          getGatewaySuspendAdmissionPhase() === "prepared") &&
        isPreparedControlConnect(data)
      ) {
        // Suspension fences work, not authenticated owner recovery. Operators
        // can reconnect throughout the held lease; node and worker connects
        // would attach presence/registry state, so they stay refused.
        await handleMessage(data);
        return;
      }
      if (await rejectConnectForClosedAdmission(data)) {
        return;
      }
      // Malformed pre-auth frames still use the established validation and
      // close path; only a validated connect can cross into mutable work.
      await handleMessage(data);
      return;
    }
    try {
      await admission.run(() => handleMessage(data));
    } finally {
      admission.release();
    }
  };

  socket.on("message", (data) => {
    void runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () =>
      handleIncomingMessage(data),
    );
  });
}
