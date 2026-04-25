import type { IncomingMessage } from "node:http";
import os from "node:os";
import type { WebSocket } from "ws";
import { loadConfig } from "../../../config/config.js";
import {
  getBoundDeviceBootstrapProfile,
  getDeviceBootstrapTokenProfile,
  redeemDeviceBootstrapTokenProfile,
  revokeDeviceBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import {
  deriveDeviceIdFromPublicKey,
  normalizeDevicePublicKeyBase64Url,
} from "../../../infra/device-identity.js";
import {
  approveBootstrapDevicePairing,
  approveDevicePairing,
  ensureDeviceToken,
  getPairedDevice,
  hasEffectivePairedDeviceRole,
  listApprovedPairedDeviceRoles,
  listDevicePairing,
  listEffectivePairedDeviceRoles,
  requestDevicePairing,
  updatePairedDeviceMetadata,
  verifyDeviceToken,
} from "../../../infra/device-pairing.js";
import {
  getPairedNode,
  requestNodePairing,
  updatePairedNodeMetadata,
} from "../../../infra/node-pairing.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../infra/skills-remote.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { rawDataToString } from "../../../infra/ws.js";
import { logRejectedLargePayload } from "../../../logging/diagnostic-payload.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  resolveBootstrapProfileScopesForRole,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import {
  isBrowserOperatorUiClient,
  isGatewayCliClient,
  isOperatorUiClient,
  isWebchatClient,
} from "../../../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayAuthResult } from "../../auth.js";
import { hasForwardedRequestHeaders, isLocalDirectRequest } from "../../auth.js";
import {
  buildCanvasScopedHostUrl,
  CANVAS_CAPABILITY_TTL_MS,
  mintCanvasCapabilityToken,
} from "../../canvas-capability.js";
import { normalizeDeviceMetadataForAuth } from "../../device-auth.js";
import { ADMIN_SCOPE } from "../../method-scopes.js";
import {
  isLocalishHost,
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveClientIp,
} from "../../net.js";
import { reconcileNodePairingOnConnect } from "../../node-connect-reconcile.js";
import {
  resolveNodePairingClientIpSource,
  shouldAutoApproveNodePairingFromTrustedCidrs,
} from "../../node-pairing-auto-approve.js";
import { checkBrowserOrigin } from "../../origin-check.js";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  ConnectErrorDetailCodes,
  type ConnectPairingRequiredReason,
  resolveDeviceAuthConnectErrorDetailCode,
  resolveAuthConnectErrorDetailCode,
} from "../../protocol/connect-error-details.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  PROTOCOL_VERSION,
  validateConnectParams,
  validateRequestFrame,
} from "../../protocol/index.js";
import { parseGatewayRole } from "../../role-policy.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PREAUTH_PAYLOAD_BYTES,
  TICK_INTERVAL_MS,
} from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  buildGatewaySnapshot,
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
  refreshGatewayHealthSnapshot,
} from "../health-state.js";
import { resolveSharedGatewaySessionGeneration } from "../ws-shared-generation.js";
import type { GatewayWsClient } from "../ws-types.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";
import {
  resolveDeviceSignaturePayloadVersion,
  resolveHandshakeBrowserSecurityContext,
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldAllowSilentLocalPairing,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEVICE_SIGNATURE_SKEW_MS = 2 * 60 * 1000;

export type WsOriginCheckMetrics = {
  hostHeaderFallbackAccepted: number;
};

function resolvePinnedClientMetadata(params: {
  claimedPlatform?: string;
  claimedDeviceFamily?: string;
  pairedPlatform?: string;
  pairedDeviceFamily?: string;
}): {
  platformMismatch: boolean;
  deviceFamilyMismatch: boolean;
  pinnedPlatform?: string;
  pinnedDeviceFamily?: string;
} {
  const claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
  const claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
  const pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
  const pairedDeviceFamily = normalizeDeviceMetadataForAuth(params.pairedDeviceFamily);
  const hasPinnedPlatform = pairedPlatform !== "";
  const hasPinnedDeviceFamily = pairedDeviceFamily !== "";
  const platformMismatch = hasPinnedPlatform && claimedPlatform !== pairedPlatform;
  const deviceFamilyMismatch = hasPinnedDeviceFamily && claimedDeviceFamily !== pairedDeviceFamily;
  return {
    platformMismatch,
    deviceFamilyMismatch,
    pinnedPlatform: hasPinnedPlatform ? params.pairedPlatform : undefined,
    pinnedDeviceFamily: hasPinnedDeviceFamily ? params.pairedDeviceFamily : undefined,
  };
}

export function attachGatewayWsMessageHandler(params: {
  socket: WebSocket;
  upgradeReq: IncomingMessage;
  connId: string;
  remoteAddr?: string;
  remotePort?: number;
  localAddr?: string;
  localPort?: number;
  endpoint?: string;
  forwardedFor?: string;
  realIp?: string;
  requestHost?: string;
  requestOrigin?: string;
  requestUserAgent?: string;
  canvasHostUrl?: string;
  connectNonce: string;
  getResolvedAuth: () => ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  gatewayMethods: string[];
  events: string[];
  extraHandlers: GatewayRequestHandlers;
  buildRequestContext: () => GatewayRequestContext;
  send: (obj: unknown) => void;
  close: (code?: number, reason?: string) => void;
  isClosed: () => boolean;
  clearHandshakeTimer: () => void;
  getClient: () => GatewayWsClient | null;
  setClient: (next: GatewayWsClient) => void;
  setHandshakeState: (state: "pending" | "connected" | "failed") => void;
  setCloseCause: (cause: string, meta?: Record<string, unknown>) => void;
  setLastFrameMeta: (meta: { type?: string; method?: string; id?: string }) => void;
  originCheckMetrics: WsOriginCheckMetrics;
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
}) {
  const {
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
    canvasHostUrl,
    connectNonce,
    getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration,
    rateLimiter,
    browserRateLimiter,
    gatewayMethods,
    events,
    extraHandlers,
    buildRequestContext,
    send,
    close,
    isClosed,
    clearHandshakeTimer,
    getClient,
    setClient,
    setHandshakeState,
    setCloseCause,
    setLastFrameMeta,
    originCheckMetrics,
    logGateway,
    logHealth,
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

  const configSnapshot = loadConfig();
  const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
  const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
  const clientIp = resolveClientIp({
    remoteAddr,
    forwardedFor,
    realIp,
    trustedProxies,
    allowRealIpFallback,
  });
  const peerLabel = endpoint ?? remoteAddr ?? "n/a";

  // If proxy headers are present but the remote address isn't trusted, don't treat
  // the connection as local. This prevents auth bypass when running behind a reverse
  // proxy without proper configuration - the proxy's loopback connection would otherwise
  // cause all external requests to be treated as trusted local clients.
  const hasProxyHeaders = hasForwardedRequestHeaders(upgradeReq);
  const remoteIsTrustedProxy = isTrustedProxyAddress(remoteAddr, trustedProxies);
  const hasUntrustedProxyHeaders = hasProxyHeaders && !remoteIsTrustedProxy;
  const hostIsLocalish = isLocalishHost(requestHost);
  const isLocalClient = isLocalDirectRequest(upgradeReq, trustedProxies, allowRealIpFallback);
  const reportedClientIp =
    isLocalClient || hasUntrustedProxyHeaders
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

  if (hasUntrustedProxyHeaders) {
    logWsControl.warn(
      "Proxy headers detected from untrusted address. " +
        "Connection will not be treated as local. " +
        "Configure gateway.trustedProxies to restore local client detection behind your proxy.",
    );
  }
  if (!hostIsLocalish && isLoopbackAddress(remoteAddr) && !hasProxyHeaders) {
    logWsControl.warn(
      "Loopback connection with non-local Host header. " +
        "Treating it as remote. If you're behind a reverse proxy, " +
        "set gateway.trustedProxies and forward X-Forwarded-For/X-Real-IP.",
    );
  }

  const isWebchatConnect = (p: ConnectParams | null | undefined) => isWebchatClient(p?.client);
  const unauthorizedFloodGuard = new UnauthorizedFloodGuard();
  const browserSecurity = resolveHandshakeBrowserSecurityContext({
    requestOrigin,
    clientIp,
    rateLimiter,
    browserRateLimiter,
  });
  const {
    hasBrowserOriginHeader,
    enforceOriginCheckForAnyClient,
    rateLimitClientIp: browserRateLimitClientIp,
    authRateLimiter,
  } = browserSecurity;

  socket.on("message", async (data) => {
    if (isClosed()) {
      return;
    }

    const preauthPayloadBytes = !getClient() ? getRawDataByteLength(data) : undefined;
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
    try {
      const parsed = JSON.parse(text);
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

      const client = getClient();
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
        const resolvedAuth = getResolvedAuth();
        const clientLabel = connectParams.client.displayName ?? connectParams.client.id;
        const clientMeta = {
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          mode: connectParams.client.mode,
          version: connectParams.client.version,
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

        // protocol negotiation
        const { minProtocol, maxProtocol } = connectParams;
        if (maxProtocol < PROTOCOL_VERSION || minProtocol > PROTOCOL_VERSION) {
          markHandshakeFailure("protocol-mismatch", {
            minProtocol,
            maxProtocol,
            expectedProtocol: PROTOCOL_VERSION,
          });
          logWsControl.warn(
            `protocol mismatch conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
            details: { expectedProtocol: PROTOCOL_VERSION },
          });
          close(1002, "protocol mismatch");
          return;
        }

        const roleRaw = connectParams.role ?? "operator";
        const role = parseGatewayRole(roleRaw);
        if (!role) {
          markHandshakeFailure("invalid-role", {
            role: roleRaw,
          });
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "invalid role");
          close(1008, "invalid role");
          return;
        }
        // Default-deny: scopes must be explicit. Empty/missing scopes means no permissions.
        // Note: If the client does not present a device identity, we can't bind scopes to a paired
        // device/token, so we will clear scopes after auth to avoid self-declared permissions.
        let scopes = Array.isArray(connectParams.scopes) ? connectParams.scopes : [];
        connectParams.role = role;
        connectParams.scopes = scopes;

        const isControlUi = isOperatorUiClient(connectParams.client);
        const isBrowserOperatorUi = isBrowserOperatorUiClient(connectParams.client);
        const isWebchat = isWebchatConnect(connectParams);
        if (enforceOriginCheckForAnyClient || isBrowserOperatorUi || isWebchat) {
          const hostHeaderOriginFallbackEnabled =
            configSnapshot.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true;
          const originCheck = checkBrowserOrigin({
            requestHost,
            origin: requestOrigin,
            allowedOrigins: configSnapshot.gateway?.controlUi?.allowedOrigins,
            allowHostHeaderOriginFallback: hostHeaderOriginFallbackEnabled,
            isLocalClient,
          });
          if (!originCheck.ok) {
            const errorMessage =
              "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
            markHandshakeFailure("origin-mismatch", {
              origin: requestOrigin ?? "n/a",
              host: requestHost ?? "n/a",
              reason: originCheck.reason,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, {
              details: {
                code: ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED,
                reason: originCheck.reason,
              },
            });
            close(1008, truncateCloseReason(errorMessage));
            return;
          }
          if (originCheck.matchedBy === "host-header-fallback") {
            originCheckMetrics.hostHeaderFallbackAccepted += 1;
            logWsControl.warn(
              `security warning: websocket origin accepted via Host-header fallback conn=${connId} count=${originCheckMetrics.hostHeaderFallbackAccepted} host=${requestHost ?? "n/a"} origin=${requestOrigin ?? "n/a"}`,
            );
            if (hostHeaderOriginFallbackEnabled) {
              logGateway.warn(
                "security metric: gateway.controlUi.dangerouslyAllowHostHeaderOriginFallback accepted a websocket connect request",
              );
            }
          }
        }

        const deviceRaw = connectParams.device;
        let devicePublicKey: string | null = null;
        let deviceAuthPayloadVersion: "v2" | "v3" | null = null;
        const hasTokenAuth = Boolean(connectParams.auth?.token);
        const hasPasswordAuth = Boolean(connectParams.auth?.password);
        const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
        const controlUiAuthPolicy = resolveControlUiAuthPolicy({
          isControlUi,
          controlUiConfig: configSnapshot.gateway?.controlUi,
          deviceRaw,
        });
        const device = controlUiAuthPolicy.device;

        let {
          authResult,
          authOk,
          authMethod,
          sharedAuthOk,
          bootstrapTokenCandidate,
          deviceTokenCandidate,
          deviceTokenCandidateSource,
        } = await resolveConnectAuthState({
          resolvedAuth,
          connectAuth: connectParams.auth,
          hasDeviceIdentity: Boolean(device),
          req: upgradeReq,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter: authRateLimiter,
          clientIp: browserRateLimitClientIp,
        });
        const rejectUnauthorized = (failedAuth: GatewayAuthResult) => {
          const { authProvided, canRetryWithDeviceToken, recommendedNextStep } =
            resolveUnauthorizedHandshakeContext({
              connectAuth: connectParams.auth,
              failedAuth,
              hasDeviceIdentity: Boolean(device),
            });
          markHandshakeFailure("unauthorized", {
            authMode: resolvedAuth.mode,
            authProvided,
            authReason: failedAuth.reason,
            allowTailscale: resolvedAuth.allowTailscale,
            peer: peerLabel,
            remoteAddr,
            remotePort,
            localAddr,
            localPort,
            role,
            scopeCount: scopes.length,
            hasDeviceIdentity: Boolean(device),
          });
          logWsControl.warn(
            `unauthorized conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} role=${role} scopes=${scopes.length} auth=${authProvided} device=${device ? "yes" : "no"} platform=${formatForLog(connectParams.client.platform)} instance=${formatForLog(connectParams.client.instanceId ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")} reason=${failedAuth.reason ?? "unknown"}`,
          );
          const authMessage = formatGatewayAuthFailureMessage({
            authMode: resolvedAuth.mode,
            authProvided,
            reason: failedAuth.reason,
            client: connectParams.client,
          });
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, authMessage, {
            details: {
              code: resolveAuthConnectErrorDetailCode(failedAuth.reason),
              authReason: failedAuth.reason,
              canRetryWithDeviceToken,
              recommendedNextStep,
            },
          });
          close(1008, truncateCloseReason(authMessage));
        };
        const clearUnboundScopes = () => {
          if (scopes.length > 0) {
            scopes = [];
            connectParams.scopes = scopes;
          }
        };
        let pairingLocality = resolvePairingLocality({
          connectParams,
          isLocalClient,
          requestHost,
          requestOrigin,
          remoteAddress: remoteAddr,
          hasProxyHeaders,
          hasBrowserOriginHeader,
          sharedAuthOk,
          authMethod,
        });
        let skipLocalBackendSelfPairing = shouldSkipLocalBackendSelfPairing({
          connectParams,
          locality: pairingLocality,
          hasBrowserOriginHeader,
          sharedAuthOk,
          authMethod,
        });
        const handleMissingDeviceIdentity = (): boolean => {
          const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
            isControlUi,
            role,
            authMode: resolvedAuth.mode,
            authOk,
            authMethod,
          });
          const preserveInsecureLocalControlUiScopes =
            isControlUi &&
            controlUiAuthPolicy.allowInsecureAuthConfigured &&
            isLocalClient &&
            (authMethod === "token" || authMethod === "password");
          const decision = evaluateMissingDeviceIdentity({
            hasDeviceIdentity: Boolean(device),
            role,
            isControlUi,
            controlUiAuthPolicy,
            trustedProxyAuthOk,
            sharedAuthOk,
            authOk,
            hasSharedAuth,
            isLocalClient,
          });
          // Shared token/password auth can bypass pairing for trusted operators.
          // Device-less clients still clear self-declared scopes by default, with
          // one narrow exception: the direct-local backend gateway-client shared-
          // auth handoff used for in-process control-plane coordination.
          if (
            !device &&
            !skipLocalBackendSelfPairing &&
            shouldClearUnboundScopesForMissingDeviceIdentity({
              decision,
              controlUiAuthPolicy,
              preserveInsecureLocalControlUiScopes,
              authMethod,
              trustedProxyAuthOk,
            })
          ) {
            clearUnboundScopes();
          }
          if (decision.kind === "allow") {
            return true;
          }

          if (decision.kind === "reject-control-ui-insecure-auth") {
            const errorMessage =
              "control ui requires device identity (use HTTPS or localhost secure context)";
            markHandshakeFailure("control-ui-insecure-auth", {
              insecureAuthConfigured: controlUiAuthPolicy.allowInsecureAuthConfigured,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, errorMessage, {
              details: { code: ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED },
            });
            close(1008, errorMessage);
            return false;
          }

          if (decision.kind === "reject-unauthorized") {
            rejectUnauthorized(authResult);
            return false;
          }

          markHandshakeFailure("device-required");
          sendHandshakeErrorResponse(ErrorCodes.NOT_PAIRED, "device identity required", {
            details: { code: ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED },
          });
          close(1008, "device identity required");
          return false;
        };
        if (!handleMissingDeviceIdentity()) {
          return;
        }
        if (device) {
          const rejectDeviceAuthInvalid = (reason: string, message: string) => {
            setHandshakeState("failed");
            setCloseCause("device-auth-invalid", {
              reason,
              client: connectParams.client.id,
              deviceId: device.id,
            });
            send({
              type: "res",
              id: frame.id,
              ok: false,
              error: errorShape(ErrorCodes.INVALID_REQUEST, message, {
                details: {
                  code: resolveDeviceAuthConnectErrorDetailCode(reason),
                  reason,
                },
              }),
            });
            close(1008, message);
          };
          const derivedId = deriveDeviceIdFromPublicKey(device.publicKey);
          if (!derivedId || derivedId !== device.id) {
            rejectDeviceAuthInvalid("device-id-mismatch", "device identity mismatch");
            return;
          }
          const signedAt = device.signedAt;
          if (
            typeof signedAt !== "number" ||
            Math.abs(Date.now() - signedAt) > DEVICE_SIGNATURE_SKEW_MS
          ) {
            rejectDeviceAuthInvalid("device-signature-stale", "device signature expired");
            return;
          }
          const providedNonce = typeof device.nonce === "string" ? device.nonce.trim() : "";
          if (!providedNonce) {
            rejectDeviceAuthInvalid("device-nonce-missing", "device nonce required");
            return;
          }
          if (providedNonce !== connectNonce) {
            rejectDeviceAuthInvalid("device-nonce-mismatch", "device nonce mismatch");
            return;
          }
          const rejectDeviceSignatureInvalid = () =>
            rejectDeviceAuthInvalid("device-signature", "device signature invalid");
          const payloadVersion = resolveDeviceSignaturePayloadVersion({
            device,
            connectParams,
            role,
            scopes,
            signedAtMs: signedAt,
            nonce: providedNonce,
          });
          if (!payloadVersion) {
            rejectDeviceSignatureInvalid();
            return;
          }
          deviceAuthPayloadVersion = payloadVersion;
          devicePublicKey = normalizeDevicePublicKeyBase64Url(device.publicKey);
          if (!devicePublicKey) {
            rejectDeviceAuthInvalid("device-public-key", "device public key invalid");
            return;
          }
        }

        ({ authResult, authOk, authMethod } = await resolveConnectAuthDecision({
          state: {
            authResult,
            authOk,
            authMethod,
            sharedAuthOk,
            sharedAuthProvided: hasSharedAuth,
            bootstrapTokenCandidate,
            deviceTokenCandidate,
            deviceTokenCandidateSource,
          },
          hasDeviceIdentity: Boolean(device),
          deviceId: device?.id,
          publicKey: device?.publicKey,
          role,
          scopes,
          rateLimiter: authRateLimiter,
          clientIp: browserRateLimitClientIp,
          verifyBootstrapToken: async ({ deviceId, publicKey, token, role, scopes }) =>
            await verifyDeviceBootstrapToken({
              deviceId,
              publicKey,
              token,
              role,
              scopes,
            }),
          verifyDeviceToken,
        }));
        pairingLocality = resolvePairingLocality({
          connectParams,
          isLocalClient,
          requestHost,
          requestOrigin,
          remoteAddress: remoteAddr,
          hasProxyHeaders,
          hasBrowserOriginHeader,
          sharedAuthOk,
          authMethod,
        });
        skipLocalBackendSelfPairing = shouldSkipLocalBackendSelfPairing({
          connectParams,
          locality: pairingLocality,
          hasBrowserOriginHeader,
          sharedAuthOk,
          authMethod,
        });
        if (!authOk) {
          rejectUnauthorized(authResult);
          return;
        }
        if (authMethod === "token" || authMethod === "password") {
          const sharedGatewaySessionGeneration =
            resolveSharedGatewaySessionGeneration(resolvedAuth);
          const requiredSharedGatewaySessionGeneration =
            getRequiredSharedGatewaySessionGeneration?.();
          if (
            requiredSharedGatewaySessionGeneration !== undefined &&
            sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration
          ) {
            setCloseCause("gateway-auth-rotated", {
              authGenerationStale: true,
            });
            close(4001, "gateway auth changed");
            return;
          }
        }
        const issuedBootstrapProfile =
          authMethod === "bootstrap-token" && bootstrapTokenCandidate
            ? await getDeviceBootstrapTokenProfile({ token: bootstrapTokenCandidate })
            : null;
        let boundBootstrapProfile: DeviceBootstrapProfile | null = null;
        let handoffBootstrapProfile: DeviceBootstrapProfile | null = null;

        const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
          isControlUi,
          role,
          authMode: resolvedAuth.mode,
          authOk,
          authMethod,
        });
        const skipControlUiPairingForDevice = shouldSkipControlUiPairing(
          controlUiAuthPolicy,
          role,
          trustedProxyAuthOk,
          resolvedAuth.mode,
        );
        if (device && devicePublicKey) {
          const formatAuditList = (items: string[] | undefined): string => {
            if (!items || items.length === 0) {
              return "<none>";
            }
            const out = new Set<string>();
            for (const item of items) {
              const trimmed = item.trim();
              if (trimmed) {
                out.add(trimmed);
              }
            }
            if (out.size === 0) {
              return "<none>";
            }
            return [...out].toSorted().join(",");
          };
          const logUpgradeAudit = (
            reason: "role-upgrade" | "scope-upgrade",
            currentRoles: string[] | undefined,
            currentScopes: string[] | undefined,
          ) => {
            logGateway.warn(
              `security audit: device access upgrade requested reason=${reason} device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} roleFrom=${formatAuditList(currentRoles)} roleTo=${role} scopesFrom=${formatAuditList(currentScopes)} scopesTo=${formatAuditList(scopes)} client=${connectParams.client.id} conn=${connId}`,
            );
          };
          const clientPairingMetadata = {
            displayName: connectParams.client.displayName,
            platform: connectParams.client.platform,
            deviceFamily: connectParams.client.deviceFamily,
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            role,
            scopes,
            remoteIp: reportedClientIp,
          };
          const clientAccessMetadata = {
            displayName: connectParams.client.displayName,
            clientId: connectParams.client.id,
            clientMode: connectParams.client.mode,
            remoteIp: reportedClientIp,
          };
          const requirePairing = async (
            reason: ConnectPairingRequiredReason,
            existingPairedDevice: Awaited<ReturnType<typeof getPairedDevice>> | null = null,
          ) => {
            const pairingStateAllowsRequestedAccess = (
              pairedCandidate: Awaited<ReturnType<typeof getPairedDevice>>,
            ): boolean => {
              if (!pairedCandidate || pairedCandidate.publicKey !== devicePublicKey) {
                return false;
              }
              if (!hasEffectivePairedDeviceRole(pairedCandidate, role)) {
                return false;
              }
              if (scopes.length === 0) {
                return true;
              }
              const pairedScopes = Array.isArray(pairedCandidate.approvedScopes)
                ? pairedCandidate.approvedScopes
                : Array.isArray(pairedCandidate.scopes)
                  ? pairedCandidate.scopes
                  : [];
              if (pairedScopes.length === 0) {
                return false;
              }
              return roleScopesAllow({
                role,
                requestedScopes: scopes,
                allowedScopes: pairedScopes,
              });
            };
            if (
              boundBootstrapProfile === null &&
              authMethod === "bootstrap-token" &&
              reason === "not-paired" &&
              role === "node" &&
              scopes.length === 0 &&
              !existingPairedDevice &&
              bootstrapTokenCandidate
            ) {
              boundBootstrapProfile = await getBoundDeviceBootstrapProfile({
                token: bootstrapTokenCandidate,
                deviceId: device.id,
                publicKey: devicePublicKey,
              });
            }
            const allowSilentLocalPairing = shouldAllowSilentLocalPairing({
              locality: pairingLocality,
              hasBrowserOriginHeader,
              isControlUi,
              isWebchat,
              reason,
            });
            const allowSilentTrustedCidrsNodePairing = shouldAutoApproveNodePairingFromTrustedCidrs(
              {
                existingPairedDevice: Boolean(existingPairedDevice),
                role,
                reason,
                scopes,
                hasBrowserOriginHeader,
                isControlUi,
                isWebchat,
                reportedClientIpSource,
                reportedClientIp,
                autoApproveCidrs: configSnapshot.gateway?.nodes?.pairing?.autoApproveCidrs,
              },
            );
            const allowSilentBootstrapPairing =
              authMethod === "bootstrap-token" &&
              reason === "not-paired" &&
              role === "node" &&
              scopes.length === 0 &&
              !existingPairedDevice &&
              boundBootstrapProfile !== null;
            const bootstrapProfileForSilentApproval = allowSilentBootstrapPairing
              ? boundBootstrapProfile
              : null;
            const bootstrapPairingRoles = bootstrapProfileForSilentApproval
              ? Array.from(new Set([role, ...bootstrapProfileForSilentApproval.roles]))
              : undefined;
            const pairing = await requestDevicePairing({
              deviceId: device.id,
              publicKey: devicePublicKey,
              ...clientPairingMetadata,
              ...(bootstrapPairingRoles ? { roles: bootstrapPairingRoles } : {}),
              silent:
                reason === "scope-upgrade"
                  ? false
                  : allowSilentLocalPairing ||
                    allowSilentBootstrapPairing ||
                    allowSilentTrustedCidrsNodePairing,
            });
            const context = buildRequestContext();
            let approved: Awaited<ReturnType<typeof approveDevicePairing>> | undefined;
            let resolvedByConcurrentApproval = false;
            let recoveryRequestId: string | undefined = pairing.request.requestId;
            const resolveLivePendingRequestId = async (): Promise<string | undefined> => {
              const pendingList = await listDevicePairing();
              const exactPending = pendingList.pending.find(
                (pending) => pending.requestId === pairing.request.requestId,
              );
              if (exactPending) {
                return exactPending.requestId;
              }
              const replacementPending = pendingList.pending.find(
                (pending) =>
                  pending.deviceId === device.id && pending.publicKey === devicePublicKey,
              );
              return replacementPending?.requestId;
            };
            if (pairing.request.silent === true) {
              approved = bootstrapProfileForSilentApproval
                ? await approveBootstrapDevicePairing(
                    pairing.request.requestId,
                    bootstrapProfileForSilentApproval,
                  )
                : await approveDevicePairing(pairing.request.requestId, {
                    callerScopes: scopes,
                  });
              if (approved?.status === "approved") {
                if (bootstrapProfileForSilentApproval) {
                  handoffBootstrapProfile = bootstrapProfileForSilentApproval;
                }
                logGateway.info(
                  `device pairing auto-approved device=${approved.device.deviceId} role=${approved.device.role ?? "unknown"}`,
                );
                context.broadcast(
                  "device.pair.resolved",
                  {
                    requestId: pairing.request.requestId,
                    deviceId: approved.device.deviceId,
                    decision: "approved",
                    ts: Date.now(),
                  },
                  { dropIfSlow: true },
                );
              } else {
                resolvedByConcurrentApproval = pairingStateAllowsRequestedAccess(
                  await getPairedDevice(device.id),
                );
                let requestStillPending = false;
                if (!resolvedByConcurrentApproval) {
                  recoveryRequestId = await resolveLivePendingRequestId();
                  requestStillPending = recoveryRequestId === pairing.request.requestId;
                }
                if (requestStillPending) {
                  context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
                }
              }
            } else if (pairing.created) {
              context.broadcast("device.pair.requested", pairing.request, { dropIfSlow: true });
            }
            // Re-resolve: another connection may have superseded/approved the request since we created it
            recoveryRequestId = await resolveLivePendingRequestId();
            if (
              !(
                pairing.request.silent === true &&
                (approved?.status === "approved" || resolvedByConcurrentApproval)
              )
            ) {
              const exposeApprovedAccess = existingPairedDevice?.publicKey === devicePublicKey;
              const approvedRoles = exposeApprovedAccess
                ? listApprovedPairedDeviceRoles(existingPairedDevice)
                : [];
              const approvedScopes = exposeApprovedAccess
                ? Array.isArray(existingPairedDevice.approvedScopes)
                  ? existingPairedDevice.approvedScopes
                  : Array.isArray(existingPairedDevice.scopes)
                    ? existingPairedDevice.scopes
                    : []
                : [];
              const pairingErrorDetails = buildPairingConnectErrorDetails({
                reason,
                requestId: recoveryRequestId,
                deviceId: device.id,
                requestedRole: role,
                requestedScopes: scopes,
                ...(approvedRoles.length > 0 ? { approvedRoles } : {}),
                ...(approvedScopes.length > 0 ? { approvedScopes } : {}),
              });
              const pairingErrorMessage = buildPairingConnectErrorMessage(reason);
              setHandshakeState("failed");
              setCloseCause("pairing-required", {
                deviceId: device.id,
                ...(recoveryRequestId ? { requestId: recoveryRequestId } : {}),
                reason,
              });
              send({
                type: "res",
                id: frame.id,
                ok: false,
                error: errorShape(ErrorCodes.NOT_PAIRED, pairingErrorMessage, {
                  details: pairingErrorDetails,
                }),
              });
              close(
                1008,
                truncateCloseReason(
                  buildPairingConnectCloseReason({
                    reason,
                    requestId: recoveryRequestId,
                  }),
                ),
              );
              return false;
            }
            return true;
          };

          const paired = await getPairedDevice(device.id);
          const isPaired = paired?.publicKey === devicePublicKey;
          if (!isPaired) {
            if (!(skipLocalBackendSelfPairing || skipControlUiPairingForDevice)) {
              const ok = await requirePairing("not-paired", paired);
              if (!ok) {
                return;
              }
            }
          } else {
            const claimedPlatform = connectParams.client.platform;
            const pairedPlatform = paired.platform;
            const claimedDeviceFamily = connectParams.client.deviceFamily;
            const pairedDeviceFamily = paired.deviceFamily;
            const metadataPinning = resolvePinnedClientMetadata({
              claimedPlatform,
              claimedDeviceFamily,
              pairedPlatform,
              pairedDeviceFamily,
            });
            const { platformMismatch, deviceFamilyMismatch } = metadataPinning;
            if (platformMismatch || deviceFamilyMismatch) {
              logGateway.warn(
                `security audit: device metadata upgrade requested reason=metadata-upgrade device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} payload=${deviceAuthPayloadVersion ?? "unknown"} claimedPlatform=${claimedPlatform ?? "<none>"} pinnedPlatform=${pairedPlatform ?? "<none>"} claimedDeviceFamily=${claimedDeviceFamily ?? "<none>"} pinnedDeviceFamily=${pairedDeviceFamily ?? "<none>"} client=${connectParams.client.id} conn=${connId}`,
              );
              const ok = await requirePairing("metadata-upgrade", paired);
              if (!ok) {
                return;
              }
            } else {
              if (metadataPinning.pinnedPlatform) {
                connectParams.client.platform = metadataPinning.pinnedPlatform;
              }
              if (metadataPinning.pinnedDeviceFamily) {
                connectParams.client.deviceFamily = metadataPinning.pinnedDeviceFamily;
              }
            }
            const pairedRoles = listEffectivePairedDeviceRoles(paired);
            const pairedScopes = Array.isArray(paired.approvedScopes)
              ? paired.approvedScopes
              : Array.isArray(paired.scopes)
                ? paired.scopes
                : [];
            const allowedRoles = new Set(pairedRoles);
            if (allowedRoles.size === 0) {
              logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) {
                return;
              }
            } else if (!allowedRoles.has(role)) {
              logUpgradeAudit("role-upgrade", pairedRoles, pairedScopes);
              const ok = await requirePairing("role-upgrade", paired);
              if (!ok) {
                return;
              }
            }

            if (scopes.length > 0) {
              if (pairedScopes.length === 0) {
                logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
                const ok = await requirePairing("scope-upgrade", paired);
                if (!ok) {
                  return;
                }
              } else {
                const scopesAllowed = roleScopesAllow({
                  role,
                  requestedScopes: scopes,
                  allowedScopes: pairedScopes,
                });
                if (!scopesAllowed) {
                  logUpgradeAudit("scope-upgrade", pairedRoles, pairedScopes);
                  const ok = await requirePairing("scope-upgrade", paired);
                  if (!ok) {
                    return;
                  }
                }
              }
            }

            // Metadata pinning is approval-bound. Reconnects can update access metadata,
            // but platform/device family must stay on the approved pairing record.
            await updatePairedDeviceMetadata(device.id, clientAccessMetadata);
          }
        }

        const deviceToken = device
          ? await ensureDeviceToken({ deviceId: device.id, role, scopes })
          : null;
        const bootstrapDeviceTokens: Array<{
          deviceToken: string;
          role: string;
          scopes: string[];
          issuedAtMs: number;
        }> = [];
        if (deviceToken) {
          bootstrapDeviceTokens.push({
            deviceToken: deviceToken.token,
            role: deviceToken.role,
            scopes: deviceToken.scopes,
            issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
          });
        }
        if (device && handoffBootstrapProfile) {
          const bootstrapProfileForHello = handoffBootstrapProfile as DeviceBootstrapProfile;
          for (const bootstrapRole of bootstrapProfileForHello.roles) {
            if (bootstrapDeviceTokens.some((entry) => entry.role === bootstrapRole)) {
              continue;
            }
            const bootstrapRoleScopes =
              bootstrapRole === "operator"
                ? resolveBootstrapProfileScopesForRole(
                    bootstrapRole,
                    bootstrapProfileForHello.scopes,
                  )
                : [];
            const extraToken = await ensureDeviceToken({
              deviceId: device.id,
              role: bootstrapRole,
              scopes: bootstrapRoleScopes,
            });
            if (!extraToken) {
              continue;
            }
            bootstrapDeviceTokens.push({
              deviceToken: extraToken.token,
              role: extraToken.role,
              scopes: extraToken.scopes,
              issuedAtMs: extraToken.rotatedAtMs ?? extraToken.createdAtMs,
            });
          }
        }

        if (role === "node") {
          const reconciliation = await reconcileNodePairingOnConnect({
            cfg: loadConfig(),
            connectParams,
            pairedNode: await getPairedNode(connectParams.device?.id ?? connectParams.client.id),
            reportedClientIp,
            requestPairing: async (input) => await requestNodePairing(input),
          });
          if (reconciliation.pendingPairing?.created) {
            const requestContext = buildRequestContext();
            requestContext.broadcast("node.pair.requested", reconciliation.pendingPairing.request, {
              dropIfSlow: true,
            });
          }
          connectParams.commands = reconciliation.effectiveCommands;
        }

        const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
        const clientId = connectParams.client.id;
        const instanceId = connectParams.client.instanceId;
        const presenceKey = shouldTrackPresence ? (device?.id ?? instanceId ?? connId) : undefined;

        logWs("in", "connect", {
          connId,
          client: connectParams.client.id,
          clientDisplayName: connectParams.client.displayName,
          version: connectParams.client.version,
          mode: connectParams.client.mode,
          clientId,
          platform: connectParams.client.platform,
          auth: authMethod,
        });

        if (isWebchatConnect(connectParams)) {
          logWsControl.info(
            `webchat connected conn=${connId} remote=${remoteAddr ?? "?"} client=${clientLabel} ${connectParams.client.mode} v${connectParams.client.version}`,
          );
        }

        if (presenceKey) {
          upsertPresence(presenceKey, {
            host: connectParams.client.displayName ?? connectParams.client.id ?? os.hostname(),
            ip: isLocalClient ? undefined : reportedClientIp,
            version: connectParams.client.version,
            platform: connectParams.client.platform,
            deviceFamily: connectParams.client.deviceFamily,
            modelIdentifier: connectParams.client.modelIdentifier,
            mode: connectParams.client.mode,
            deviceId: device?.id,
            roles: [role],
            scopes,
            instanceId: device?.id ?? instanceId,
            reason: "connect",
          });
          incrementPresenceVersion();
        }

        const snapshot = buildGatewaySnapshot({
          includeSensitive: scopes.includes(ADMIN_SCOPE),
        });
        const cachedHealth = getHealthCache();
        if (cachedHealth) {
          snapshot.health = cachedHealth;
          snapshot.stateVersion.health = getHealthVersion();
        }
        const canvasCapability = canvasHostUrl ? mintCanvasCapabilityToken() : undefined;
        const canvasCapabilityExpiresAtMs = canvasCapability
          ? Date.now() + CANVAS_CAPABILITY_TTL_MS
          : undefined;
        const usesSharedGatewayAuth = authMethod === "token" || authMethod === "password";
        const sharedGatewaySessionGeneration = usesSharedGatewayAuth
          ? resolveSharedGatewaySessionGeneration(resolvedAuth)
          : undefined;
        const scopedCanvasHostUrl =
          canvasHostUrl && canvasCapability
            ? (buildCanvasScopedHostUrl(canvasHostUrl, canvasCapability) ?? canvasHostUrl)
            : canvasHostUrl;
        const helloOkAuthScopes = deviceToken ? deviceToken.scopes : scopes;
        const helloOk = {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: {
            version: resolveRuntimeServiceVersion(process.env),
            connId,
          },
          features: { methods: gatewayMethods, events },
          snapshot,
          canvasHostUrl: scopedCanvasHostUrl,
          auth: {
            role,
            scopes: helloOkAuthScopes,
            ...(deviceToken
              ? {
                  deviceToken: deviceToken.token,
                  issuedAtMs: deviceToken.rotatedAtMs ?? deviceToken.createdAtMs,
                  ...(bootstrapDeviceTokens.length > 1
                    ? { deviceTokens: bootstrapDeviceTokens.slice(1) }
                    : {}),
                }
              : {}),
          },
          policy: {
            maxPayload: MAX_PAYLOAD_BYTES,
            maxBufferedBytes: MAX_BUFFERED_BYTES,
            tickIntervalMs: TICK_INTERVAL_MS,
          },
        };

        clearHandshakeTimer();
        const nextClient: GatewayWsClient = {
          socket,
          connect: connectParams,
          connId,
          isDeviceTokenAuth: authMethod === "device-token",
          usesSharedGatewayAuth,
          sharedGatewaySessionGeneration,
          presenceKey,
          clientIp: reportedClientIp,
          canvasHostUrl,
          canvasCapability,
          canvasCapabilityExpiresAtMs,
        };
        setSocketMaxPayload(socket, MAX_PAYLOAD_BYTES);
        setClient(nextClient);
        setHandshakeState("connected");
        if (role === "node") {
          const context = buildRequestContext();
          const nodeSession = context.nodeRegistry.register(nextClient, {
            remoteIp: reportedClientIp,
          });
          const instanceIdRaw = connectParams.client.instanceId;
          const instanceId = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
          const nodeIdsForPairing = new Set<string>([nodeSession.nodeId]);
          if (instanceId) {
            nodeIdsForPairing.add(instanceId);
          }
          for (const nodeId of nodeIdsForPairing) {
            void updatePairedNodeMetadata(nodeId, {
              lastConnectedAtMs: nodeSession.connectedAtMs,
            }).catch((err) =>
              logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`),
            );
          }
          recordRemoteNodeInfo({
            nodeId: nodeSession.nodeId,
            displayName: nodeSession.displayName,
            platform: nodeSession.platform,
            deviceFamily: nodeSession.deviceFamily,
            commands: nodeSession.commands,
            remoteIp: nodeSession.remoteIp,
          });
          void refreshRemoteNodeBins({
            nodeId: nodeSession.nodeId,
            platform: nodeSession.platform,
            deviceFamily: nodeSession.deviceFamily,
            commands: nodeSession.commands,
            cfg: loadConfig(),
          }).catch((err) =>
            logGateway.warn(
              `remote bin probe failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
            ),
          );
          void loadVoiceWakeConfig()
            .then((cfg) => {
              context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.changed", {
                triggers: cfg.triggers,
              });
            })
            .catch((err) =>
              logGateway.warn(
                `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
              ),
            );
        }

        try {
          await sendFrame({ type: "res", id: frame.id, ok: true, payload: helloOk });
        } catch (err) {
          setCloseCause("hello-send-failed", { error: formatForLog(err) });
          close();
          return;
        }
        if (authMethod === "bootstrap-token" && bootstrapTokenCandidate && device) {
          try {
            if (handoffBootstrapProfile) {
              const revoked = await revokeDeviceBootstrapToken({
                token: bootstrapTokenCandidate,
              });
              if (!revoked.removed) {
                logGateway.warn(
                  `bootstrap token revoke skipped after device-token handoff device=${device.id}`,
                );
              }
            } else if (issuedBootstrapProfile) {
              const redemption = await redeemDeviceBootstrapTokenProfile({
                token: bootstrapTokenCandidate,
                role,
                scopes,
              });
              if (redemption.fullyRedeemed) {
                const revoked = await revokeDeviceBootstrapToken({
                  token: bootstrapTokenCandidate,
                });
                if (!revoked.removed) {
                  logGateway.warn(
                    `bootstrap token revoke skipped after profile redemption device=${device.id}`,
                  );
                }
              }
            }
          } catch (err) {
            logGateway.warn(
              `bootstrap token post-connect bookkeeping failed device=${device.id}: ${formatForLog(err)}`,
            );
          }
        }
        logWs("out", "hello-ok", {
          connId,
          methods: gatewayMethods.length,
          events: events.length,
          presence: snapshot.presence.length,
          stateVersion: snapshot.stateVersion.presence,
        });
        void refreshGatewayHealthSnapshot({ probe: true }).catch((err) =>
          logHealth.error(`post-connect health refresh failed: ${formatError(err)}`),
        );
        return;
      }

      // After handshake, accept only req frames
      if (!validateRequestFrame(parsed)) {
        send({
          type: "res",
          id: (parsed as { id?: unknown })?.id ?? "invalid",
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid request frame: ${formatValidationErrors(validateRequestFrame.errors)}`,
          ),
        });
        return;
      }
      const req = parsed;
      logWs("in", "req", { connId, id: req.id, method: req.method });
      if (client.usesSharedGatewayAuth) {
        const requiredSharedGatewaySessionGeneration =
          getRequiredSharedGatewaySessionGeneration?.();
        if (
          requiredSharedGatewaySessionGeneration !== undefined &&
          client.sharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration
        ) {
          setCloseCause("gateway-auth-rotated", {
            authGenerationStale: true,
            method: req.method,
          });
          close(4001, "gateway auth changed");
          return;
        }
      }
      const respond = (
        ok: boolean,
        payload?: unknown,
        error?: ErrorShape,
        meta?: Record<string, unknown>,
      ) => {
        send({ type: "res", id: req.id, ok, payload, error });
        const unauthorizedRoleError = isUnauthorizedRoleError(error);
        let logMeta = meta;
        if (unauthorizedRoleError) {
          const unauthorizedDecision = unauthorizedFloodGuard.registerUnauthorized();
          if (unauthorizedDecision.suppressedSinceLastLog > 0) {
            logMeta = {
              ...logMeta,
              suppressedUnauthorizedResponses: unauthorizedDecision.suppressedSinceLastLog,
            };
          }
          if (!unauthorizedDecision.shouldLog) {
            return;
          }
          if (unauthorizedDecision.shouldClose) {
            setCloseCause("repeated-unauthorized-requests", {
              unauthorizedCount: unauthorizedDecision.count,
              method: req.method,
            });
            queueMicrotask(() => close(1008, "repeated unauthorized calls"));
          }
          logMeta = {
            ...logMeta,
            unauthorizedCount: unauthorizedDecision.count,
          };
        } else {
          unauthorizedFloodGuard.reset();
        }
        logWs("out", "res", {
          connId,
          id: req.id,
          ok,
          method: req.method,
          errorCode: error?.code,
          errorMessage: error?.message,
          ...logMeta,
        });
      };

      void (async () => {
        await handleGatewayRequest({
          req,
          respond,
          client,
          isWebchatConnect,
          extraHandlers,
          context: buildRequestContext(),
        });
      })().catch((err) => {
        logGateway.error(`request handler failed: ${formatForLog(err)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      });
    } catch (err) {
      logGateway.error(`parse/handle error: ${String(err)}`);
      logWs("out", "parse-error", { connId, error: formatForLog(err) });
      if (!getClient()) {
        close();
      }
    }
  });
}

function getRawDataByteLength(data: unknown): number {
  if (Buffer.isBuffer(data)) {
    return data.byteLength;
  }
  if (Array.isArray(data)) {
    return data.reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  return Buffer.byteLength(String(data));
}

function setSocketMaxPayload(socket: WebSocket, maxPayload: number): void {
  const receiver = (socket as { _receiver?: { _maxPayload?: number } })._receiver;
  if (receiver) {
    receiver._maxPayload = maxPayload;
  }
}
