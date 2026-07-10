// WebSocket message handler validates frames, dispatches gateway RPCs, manages pairing, and reports responses.
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  normalizeSortedUniqueTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { RawData, WebSocket } from "ws";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import {
  buildPairingConnectCloseReason,
  buildPairingConnectErrorDetails,
  buildPairingConnectErrorMessage,
  ConnectErrorDetailCodes,
  type ConnectPairingRequiredReason,
  resolveDeviceAuthConnectErrorDetailCode,
  resolveAuthConnectErrorDetailCode,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import {
  type ConnectParams,
  ErrorCodes,
  type ErrorShape,
  errorShape,
  formatValidationErrors,
  GATEWAY_SERVER_CAPS,
  MIN_NODE_PROTOCOL_VERSION,
  MIN_PROBE_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  validateConnectParams,
  validateRequestFrame,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  gatewayStartupUnavailableDetails,
  GATEWAY_STARTUP_CLOSE_CODE,
  GATEWAY_STARTUP_CLOSE_REASON,
  GATEWAY_STARTUP_PENDING_CLOSE_CAUSE,
  GATEWAY_STARTUP_RETRY_AFTER_MS,
} from "../../../../packages/gateway-protocol/src/startup-unavailable.js";
import { getRuntimeConfig } from "../../../config/io.js";
import { resolveStateDir } from "../../../config/paths.js";
import { sha256HexPrefix } from "../../../infra/crypto-digest.js";
import {
  getBoundDeviceBootstrapProfile,
  getDeviceBootstrapTokenProfile,
  redeemDeviceBootstrapTokenProfile,
  revokeDeviceBootstrapToken,
  restoreDeviceBootstrapToken,
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
  emitTrustedSecurityEvent,
  type DiagnosticSecurityEventInput,
} from "../../../infra/diagnostic-events.js";
import {
  createDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  releaseNodePairingCleanupClaim,
  requestNodePairing,
  type NodePairingCleanupClaim,
  type RequestNodePairingResult,
  updatePairedNodeMetadata,
} from "../../../infra/node-pairing.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeRoutingConfig } from "../../../infra/voicewake-routing.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { rawDataToString } from "../../../infra/ws.js";
import { logRejectedLargePayload } from "../../../logging/diagnostic-payload.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import {
  BOOTSTRAP_HANDOFF_OPERATOR_SCOPES,
  isPairingSetupBootstrapProfile,
  resolveBootstrapProfileScopesForRole,
  resolveBootstrapProfileScopesForRoles,
  type DeviceBootstrapProfile,
} from "../../../shared/device-bootstrap-profile.js";
import { roleScopesAllow } from "../../../shared/operator-scope-compat.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../skills/runtime/remote.js";
import {
  isBrowserOperatorUiClient,
  isGatewayCliClient,
  isOperatorUiClient,
  isWebchatClient,
} from "../../../utils/message-channel.js";
import { resolveRuntimeServiceVersion } from "../../../version.js";
import { verifyAgentRuntimeIdentityToken } from "../../agent-runtime-identity-token.js";
import { AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING, type AuthRateLimiter } from "../../auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import { hasForwardedRequestHeaders, isLocalDirectRequest } from "../../auth.js";
import { listControlUiPluginTabs } from "../../control-ui-plugin-tabs.js";
import { normalizeDeviceMetadataForAuth } from "../../device-auth.js";
import { pruneSupersededSilentPairingsAfterApproval } from "../../device-pairing-prune.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../../method-scopes.js";
import type { GatewayMethodRegistry } from "../../methods/registry.js";
import {
  isLocalishHost,
  isLoopbackAddress,
  isTrustedProxyAddress,
  resolveClientIp,
} from "../../net.js";
import { filterLegacyNodeProtocolFeatures } from "../../node-command-policy.js";
import { reconcileNodePairingOnConnect } from "../../node-connect-reconcile.js";
import {
  resolveNodePairingClientIpSource,
  shouldAutoApproveNodePairingFromTrustedCidrs,
} from "../../node-pairing-auto-approve.js";
import type { NodeReapprovalCoordinator } from "../../node-reapproval-coordinator.js";
import { isOperatorApprovalRuntimeToken } from "../../operator-approval-runtime-token.js";
import { checkBrowserOrigin } from "../../origin-check.js";
import {
  buildPluginNodeCapabilityScopedHostUrl,
  indexPluginNodeCapabilitySurfaces,
  mintPluginNodeCapabilityToken,
  type PluginNodeCapabilitySurface,
  resolvePluginNodeCapabilityExpiresAtMs,
  setClientPluginNodeCapability,
} from "../../plugin-node-capability.js";
import { withSerializedRateLimitAttempt } from "../../rate-limit-attempt-serialization.js";
import { parseGatewayRole } from "../../role-policy.js";
import {
  MAX_BUFFERED_BYTES,
  MAX_PAYLOAD_BYTES,
  MAX_PREAUTH_PAYLOAD_BYTES,
  TICK_INTERVAL_MS,
} from "../../server-constants.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import {
  buildGatewaySnapshot,
  getHealthCache,
  getHealthVersion,
  incrementPresenceVersion,
} from "../health-state.js";
import { resolveSharedGatewaySessionGeneration } from "../ws-shared-generation.js";
import type { GatewayWsClient, WsHandshakePhase } from "../ws-types.js";
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
  shouldPreserveLocalCliSharedAuthScopes,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";
import {
  buildHandshakeAuthLogKey,
  HandshakeAuthLogLimiter,
  shouldLimitMissingCredentialAuthLog,
} from "./handshake-auth-log-limiter.js";
import { isUnauthorizedRoleError, UnauthorizedFloodGuard } from "./unauthorized-flood-guard.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const DEVICE_SIGNATURE_SKEW_MS = 2 * 60 * 1000;
const DEVICE_CREDENTIAL_INVALIDATING_METHODS = new Set([
  "device.pair.remove",
  "device.token.rotate",
  "device.token.revoke",
  "node.pair.remove",
]);
const unauthorizedHandshakeLogLimiter = new HandshakeAuthLogLimiter();

class NodePairingRateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("node pairing rate limited");
  }
}

function hashGatewaySecurityId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return `sha256:${sha256HexPrefix(normalized, 12)}`;
}

function emitGatewayAuthSecurityEvent(params: {
  action: "gateway.auth.succeeded" | "gateway.auth.failed";
  outcome: DiagnosticSecurityEventInput["outcome"];
  severity: DiagnosticSecurityEventInput["severity"];
  authMode: string;
  authMethod?: string;
  authProvided?: string;
  role: string;
  scopes: readonly string[];
  clientMode?: string;
  deviceId?: string;
  reason?: string;
  rateLimited?: boolean;
}) {
  emitTrustedSecurityEvent({
    category: "auth",
    action: params.action,
    outcome: params.outcome,
    severity: params.severity,
    actor: {
      kind: params.role === "node" ? "node" : "operator",
      ...(params.deviceId ? { deviceIdHash: hashGatewaySecurityId(params.deviceId) } : {}),
      role: params.role,
    },
    target: {
      kind: "gateway",
      name: "websocket",
    },
    policy: {
      id: "gateway.websocket-auth",
      decision: params.outcome === "success" ? "allow" : "deny",
      ...(params.reason ? { reason: params.reason } : {}),
    },
    control: {
      id: "gateway.ws.connect",
      family: "auth",
    },
    ...(params.reason ? { reason: params.reason } : {}),
    attributes: {
      auth_mode: params.authMode,
      auth_method: params.authMethod ?? "unknown",
      auth_provided: params.authProvided ?? "unknown",
      client_mode: params.clientMode ?? "unknown",
      has_device_identity: Boolean(params.deviceId),
      scope_count: params.scopes.length,
      ...(params.rateLimited !== undefined ? { rate_limited: params.rateLimited } : {}),
    },
  });
}

/** Match production release versions (YYYY.M.PATCH or YYYY.M.PATCH-beta.N). */
const RELEASED_VERSION_RE = /^\d{4}\.\d+\.\d+/;

function isReleasedVersion(version: string): boolean {
  return RELEASED_VERSION_RE.test(version);
}

/**
 * Lazily resolve the local node host's nodeId from ~/.openclaw/node.json.
 * Process-stable: only changes on `openclaw node install`, which requires restart.
 */
let cachedLocalNodeId: string | null | undefined;
function resolveLocalNodeId(): string | null {
  if (cachedLocalNodeId !== undefined) {
    return cachedLocalNodeId;
  }
  try {
    const raw = fs.readFileSync(path.join(resolveStateDir(), "node.json"), "utf8");
    const parsed = JSON.parse(raw) as { nodeId?: string };
    cachedLocalNodeId = typeof parsed.nodeId === "string" ? parsed.nodeId.trim() || null : null;
  } catch {
    cachedLocalNodeId = null;
  }
  return cachedLocalNodeId;
}

async function requestNodePairingFromConnect(params: {
  input: Parameters<typeof requestNodePairing>[0];
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  pairedReconnect?: boolean;
  cleanupClaim?: NodePairingCleanupClaim;
  reapprovalCoordinator?: NodeReapprovalCoordinator;
}): Promise<Awaited<ReturnType<typeof requestNodePairing>> | null> {
  if (params.pairedReconnect) {
    return params.reapprovalCoordinator
      ? await params.reapprovalCoordinator.request({
          input: params.input,
          cleanupClaim: params.cleanupClaim,
        })
      : await requestNodePairing(params.input);
  }
  if (!params.rateLimiter) {
    return await requestNodePairing(params.input);
  }
  return await withSerializedRateLimitAttempt({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
    run: async () => {
      const rateCheck = params.rateLimiter?.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING,
      );
      if (rateCheck && !rateCheck.allowed) {
        throw new NodePairingRateLimitError(rateCheck.retryAfterMs);
      }
      const result = await requestNodePairing(params.input);
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_NODE_PAIRING);
      return result;
    },
  });
}

export type WsOriginCheckMetrics = {
  hostHeaderFallbackAccepted: number;
};

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolvePairedAccessScopes(
  device: { approvedScopes?: unknown; scopes?: unknown } | null | undefined,
): string[] {
  const scopes = Array.isArray(device?.approvedScopes)
    ? device.approvedScopes
    : Array.isArray(device?.scopes)
      ? device.scopes
      : [];
  return normalizeSortedUniqueTrimmedStringList(scopes);
}

function isSetupCodeMobileBootstrapClient(client: {
  id?: string;
  platform?: string;
  deviceFamily?: string;
}): boolean {
  const platform = normalizeDeviceMetadataForAuth(client.platform);
  const deviceFamily = normalizeDeviceMetadataForAuth(client.deviceFamily);
  if (client.id === GATEWAY_CLIENT_IDS.ANDROID_APP) {
    return /^android(?:\s|$)/.test(platform) && deviceFamily === "android";
  }
  if (client.id === GATEWAY_CLIENT_IDS.IOS_APP) {
    return /^(?:ios|ipados)(?:\s|$)/.test(platform) && /^(?:iphone|ipad|ios)$/.test(deviceFamily);
  }
  return false;
}

function isControlUiOperatorBootstrapProfile(params: {
  profile: DeviceBootstrapProfile | null;
  requestedScopes: readonly string[];
}): params is { profile: DeviceBootstrapProfile; requestedScopes: readonly string[] } {
  const { profile, requestedScopes } = params;
  if (!profile || profile.purpose !== "control-ui") {
    return false;
  }
  if (profile.roles.length !== 1 || profile.roles[0] !== "operator") {
    return false;
  }
  if (
    !profile.scopes.every((scope) =>
      (BOOTSTRAP_HANDOFF_OPERATOR_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    return false;
  }
  return roleScopesAllow({
    role: "operator",
    requestedScopes,
    allowedScopes: profile.scopes,
  });
}

function resolveTrustedProxyControlUiScopes(params: {
  requestedScopes: string[];
  upgradeReq: IncomingMessage;
}): string[] {
  const rawHeader = firstHeaderValue(params.upgradeReq.headers["x-openclaw-scopes"]);
  if (rawHeader === undefined) {
    return params.requestedScopes;
  }
  const declaredScopes = new Set(
    rawHeader
      .split(",")
      .map((scope) => scope.trim())
      .filter((scope) => scope.length > 0),
  );
  if (declaredScopes.size === 0) {
    return [];
  }
  return params.requestedScopes.filter((scope) => declaredScopes.has(scope));
}

function resolvePinnedClientMetadata(params: {
  clientId?: string;
  clientMode?: string;
  claimedPlatform?: string;
  claimedDeviceFamily?: string;
  pairedPlatform?: string;
  pairedDeviceFamily?: string;
}): {
  platformMismatch: boolean;
  deviceFamilyMismatch: boolean;
  pinnedPlatform?: string;
  pinnedDeviceFamily?: string;
  refreshPairedPlatform?: string;
} {
  function normalizeLegacyNodeHostPlatformPin(value: string): string {
    switch (value) {
      case "darwin":
      case "macos":
        return "macos";
      case "win32":
      case "windows":
        return "windows";
      default:
        return value;
    }
  }

  function normalizeMobileAppPlatformPin(clientId: string | undefined, value: string): string {
    if (clientId === GATEWAY_CLIENT_IDS.IOS_APP && /^(?:ios|ipados)(?:\s|$)/.test(value)) {
      return "ios-family";
    }
    if (clientId === GATEWAY_CLIENT_IDS.ANDROID_APP && /^android(?:\s|$)/.test(value)) {
      return "android";
    }
    return value;
  }

  const claimedPlatform = normalizeDeviceMetadataForAuth(params.claimedPlatform);
  const claimedDeviceFamily = normalizeDeviceMetadataForAuth(params.claimedDeviceFamily);
  const pairedPlatform = normalizeDeviceMetadataForAuth(params.pairedPlatform);
  const pairedDeviceFamily = normalizeDeviceMetadataForAuth(params.pairedDeviceFamily);
  const hasPinnedPlatform = pairedPlatform !== "";
  const hasPinnedDeviceFamily = pairedDeviceFamily !== "";
  const isLegacyNodeHostPlatformPin =
    params.clientId === GATEWAY_CLIENT_IDS.NODE_HOST &&
    params.clientMode === GATEWAY_CLIENT_MODES.NODE &&
    hasPinnedPlatform &&
    claimedPlatform !== "" &&
    normalizeLegacyNodeHostPlatformPin(claimedPlatform) ===
      normalizeLegacyNodeHostPlatformPin(pairedPlatform);
  const isMobileAppPlatformVersionRefresh =
    hasPinnedPlatform &&
    claimedPlatform !== "" &&
    claimedPlatform !== pairedPlatform &&
    normalizeMobileAppPlatformPin(params.clientId, claimedPlatform) ===
      normalizeMobileAppPlatformPin(params.clientId, pairedPlatform);
  const platformMismatch =
    hasPinnedPlatform &&
    claimedPlatform !== pairedPlatform &&
    !isLegacyNodeHostPlatformPin &&
    !isMobileAppPlatformVersionRefresh;
  const deviceFamilyMismatch = hasPinnedDeviceFamily && claimedDeviceFamily !== pairedDeviceFamily;
  const pinnedPlatform =
    claimedPlatform === pairedPlatform
      ? params.pairedPlatform
      : isLegacyNodeHostPlatformPin
        ? normalizeLegacyNodeHostPlatformPin(pairedPlatform)
        : isMobileAppPlatformVersionRefresh
          ? params.claimedPlatform
          : undefined;
  return {
    platformMismatch,
    deviceFamilyMismatch,
    pinnedPlatform: hasPinnedPlatform ? pinnedPlatform : undefined,
    pinnedDeviceFamily: hasPinnedDeviceFamily ? params.pairedDeviceFamily : undefined,
    ...(isMobileAppPlatformVersionRefresh ? { refreshPairedPlatform: params.claimedPlatform } : {}),
  };
}

export type GatewayWsMessageHandlerParams = {
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
  pluginSurfaceBaseUrl?: string;
  pluginNodeCapabilities?: PluginNodeCapabilitySurface[];
  connectNonce: string;
  getResolvedAuth: () => ResolvedGatewayAuth;
  getRequiredSharedGatewaySessionGeneration?: () => string | undefined;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  /** Browser-origin fallback limiter (loopback is never exempt). */
  browserRateLimiter?: AuthRateLimiter;
  nodeReapprovalCoordinator?: NodeReapprovalCoordinator;
  isStartupPending?: () => boolean;
  gatewayMethods: string[];
  events: string[];
  extraHandlers: GatewayRequestHandlers;
  getMethodRegistry?: () => GatewayMethodRegistry;
  buildRequestContext: () => GatewayRequestContext;
  refreshHealthSnapshot: GatewayRequestContext["refreshHealthSnapshot"];
  send: (obj: unknown) => void;
  close: (code?: number, reason?: string) => void;
  isClosed: () => boolean;
  clearHandshakeTimer: () => void;
  getClient: () => GatewayWsClient | null;
  setClient: (next: GatewayWsClient) => boolean;
  setHandshakeState: (state: "pending" | "connected" | "failed") => void;
  advanceHandshakePhase: (phase: WsHandshakePhase) => void;
  setCloseCause: (cause: string, meta?: Record<string, unknown>) => void;
  setLastFrameMeta: (meta: { type?: string; method?: string; id?: string }) => void;
  originCheckMetrics: WsOriginCheckMetrics;
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
};

export function attachGatewayWsMessageHandler(params: GatewayWsMessageHandlerParams) {
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
    pluginSurfaceBaseUrl,
    pluginNodeCapabilities = [],
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
    isClosed,
    clearHandshakeTimer,
    getClient,
    setClient,
    setHandshakeState,
    advanceHandshakePhase,
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

  const configSnapshot = getRuntimeConfig();
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
  let deviceCredentialMutationBarrier: Promise<void> | undefined;
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
  const closeInvalidatedClient = (client: GatewayWsClient, method: string): boolean => {
    if (!client.invalidated) {
      return false;
    }
    const reason = client.invalidatedReason ?? "invalidated";
    setCloseCause("client-invalidated", {
      reason,
      method,
    });
    close(4001, `client invalidated: ${reason}`);
    return true;
  };

  const handleMessage = async (data: RawData) => {
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
    let pendingNodePairingCleanup: NodePairingCleanupClaim | undefined;
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
      const claim = pendingNodePairingCleanup;
      pendingNodePairingCleanup = undefined;
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

        if (isStartupPending?.()) {
          markHandshakeFailure(GATEWAY_STARTUP_PENDING_CLOSE_CAUSE);
          await sendFrame({
            type: "res",
            id: frame.id,
            ok: false,
            error: errorShape(ErrorCodes.UNAVAILABLE, "gateway starting; retry shortly", {
              retryable: true,
              retryAfterMs: GATEWAY_STARTUP_RETRY_AFTER_MS,
              details: gatewayStartupUnavailableDetails(),
            }),
          }).catch(() => {});
          queueMicrotask(() => close(GATEWAY_STARTUP_CLOSE_CODE, GATEWAY_STARTUP_CLOSE_REASON));
          return;
        }

        // protocol negotiation
        const { minProtocol, maxProtocol } = connectParams;
        const supportsCurrentProtocol =
          maxProtocol >= PROTOCOL_VERSION && minProtocol <= PROTOCOL_VERSION;
        const supportsProbeRestartProtocol =
          connectParams.client.mode === GATEWAY_CLIENT_MODES.PROBE &&
          maxProtocol >= MIN_PROBE_PROTOCOL_VERSION &&
          minProtocol <= PROTOCOL_VERSION;
        // Protocol v4 changed chat deltas, not node RPC frames. Keep N-1 limited to
        // the node role+mode so stale operator/UI clients cannot enter the v4 surface.
        const supportsPreviousNodeProtocol =
          connectParams.role === "node" &&
          connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE &&
          maxProtocol >= MIN_NODE_PROTOCOL_VERSION &&
          minProtocol <= MIN_NODE_PROTOCOL_VERSION;
        const usesLegacyNodeProtocol = !supportsCurrentProtocol && supportsPreviousNodeProtocol;
        if (
          !supportsCurrentProtocol &&
          !supportsProbeRestartProtocol &&
          !supportsPreviousNodeProtocol
        ) {
          markHandshakeFailure("protocol-mismatch", {
            minProtocol,
            maxProtocol,
            expectedProtocol: PROTOCOL_VERSION,
            minimumProbeProtocol: MIN_PROBE_PROTOCOL_VERSION,
          });
          logWsControl.warn(
            `protocol mismatch conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} remotePort=${remotePort ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} min=${minProtocol} max=${maxProtocol} expected=${PROTOCOL_VERSION} probeMin=${MIN_PROBE_PROTOCOL_VERSION} instance=${formatForLog(connectParams.client.instanceId ?? "n/a")}`,
          );
          sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "protocol mismatch", {
            details: {
              code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
              clientMinProtocol: minProtocol,
              clientMaxProtocol: maxProtocol,
              expectedProtocol: PROTOCOL_VERSION,
              minimumProbeProtocol: MIN_PROBE_PROTOCOL_VERSION,
            },
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
        const isNativeAppUi =
          connectParams.client.mode === GATEWAY_CLIENT_MODES.UI &&
          (connectParams.client.id === GATEWAY_CLIENT_IDS.MACOS_APP ||
            connectParams.client.id === GATEWAY_CLIENT_IDS.IOS_APP ||
            connectParams.client.id === GATEWAY_CLIENT_IDS.ANDROID_APP);
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
        const hasRawHandshakeCredentials =
          hasSharedAuth ||
          Boolean(connectParams.auth?.bootstrapToken) ||
          Boolean(connectParams.auth?.deviceToken) ||
          Boolean(device);
        if (hasRawHandshakeCredentials) {
          advanceHandshakePhase("auth_credentials_received");
        }
        const connectAuthState = await resolveConnectAuthState({
          resolvedAuth,
          connectAuth: connectParams.auth,
          hasDeviceIdentity: Boolean(device),
          req: upgradeReq,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter: authRateLimiter,
          clientIp: browserRateLimitClientIp,
        });
        const {
          sharedAuthOk,
          bootstrapTokenCandidate,
          deviceTokenCandidate,
          deviceTokenCandidateSource,
        } = connectAuthState;
        let { authResult, authOk, authMethod } = connectAuthState;
        const rejectUnauthorized = (failedAuth: GatewayAuthResult) => {
          const { authProvided, canRetryWithDeviceToken, recommendedNextStep } =
            resolveUnauthorizedHandshakeContext({
              connectAuth: connectParams.auth,
              failedAuth,
              hasDeviceIdentity: Boolean(device),
            });
          emitGatewayAuthSecurityEvent({
            action: "gateway.auth.failed",
            outcome: "denied",
            severity: failedAuth.rateLimited ? "high" : "medium",
            authMode: resolvedAuth.mode,
            authMethod: failedAuth.method ?? authMethod,
            authProvided,
            role,
            scopes,
            clientMode: connectParams.client.mode,
            deviceId: device?.id,
            reason: failedAuth.reason ?? "unknown",
            rateLimited: failedAuth.rateLimited === true,
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
          const authLogDecision = shouldLimitMissingCredentialAuthLog({
            reason: failedAuth.reason,
            authProvided,
          })
            ? unauthorizedHandshakeLogLimiter.register(
                buildHandshakeAuthLogKey({
                  reason: failedAuth.reason,
                  remoteAddr,
                  client: clientLabel,
                  mode: connectParams.client.mode,
                  authProvided,
                }),
              )
            : { shouldLog: true, suppressedSinceLastLog: 0 };
          if (authLogDecision.shouldLog) {
            const suppressedText =
              authLogDecision.suppressedSinceLastLog > 0
                ? ` suppressed=${authLogDecision.suppressedSinceLastLog}`
                : "";
            logWsControl.warn(
              `unauthorized conn=${connId} peer=${formatForLog(peerLabel)} remote=${remoteAddr ?? "?"} client=${formatForLog(clientLabel)} ${connectParams.client.mode} v${formatForLog(connectParams.client.version)} role=${role} scopes=${scopes.length} auth=${authProvided} device=${device ? "yes" : "no"} platform=${formatForLog(connectParams.client.platform)} instance=${formatForLog(connectParams.client.instanceId ?? "n/a")} host=${formatForLog(requestHost ?? "n/a")} origin=${formatForLog(requestOrigin ?? "n/a")} ua=${formatForLog(requestUserAgent ?? "n/a")} reason=${failedAuth.reason ?? "unknown"}${suppressedText}`,
            );
          }
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
        let preserveLocalCliSharedAuthScopes = shouldPreserveLocalCliSharedAuthScopes({
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
            localBackendSelfPairingOk: skipLocalBackendSelfPairing,
            sharedAuthOk,
            authOk,
            hasSharedAuth,
            isLocalClient,
          });
          // Device-less shared auth clears self-declared scopes by default.
          // Only first-party local control paths preserve scopes: backend self-
          // calls and CLI shared-secret calls that already proved loopback auth.
          if (
            !device &&
            !skipLocalBackendSelfPairing &&
            !preserveLocalCliSharedAuthScopes &&
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
            emitGatewayAuthSecurityEvent({
              action: "gateway.auth.failed",
              outcome: "denied",
              severity: "medium",
              authMode: resolvedAuth.mode,
              authMethod,
              authProvided: "device-signature",
              role,
              scopes,
              clientMode: connectParams.client.mode,
              deviceId: device.id,
              reason,
            });
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

        const authDecision = await resolveConnectAuthDecision({
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
          verifyBootstrapToken: async ({
            deviceId,
            publicKey,
            token,
            role: roleLocal,
            scopes: scopesLocal,
          }) =>
            await verifyDeviceBootstrapToken({
              deviceId,
              publicKey,
              token,
              role: roleLocal,
              scopes: scopesLocal,
            }),
          verifyDeviceToken: async (paramsLocal) =>
            await verifyDeviceToken({
              ...paramsLocal,
              requiredSharedGatewaySessionGeneration: getRequiredSharedGatewaySessionGeneration?.(),
            }),
        });
        ({ authResult, authOk, authMethod } = authDecision);
        const deviceTokenSharedGatewaySessionGeneration =
          authDecision.deviceTokenSharedGatewaySessionGeneration;
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
        preserveLocalCliSharedAuthScopes = shouldPreserveLocalCliSharedAuthScopes({
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
        advanceHandshakePhase("auth_validated");
        const usesSharedGatewayAuth =
          authMethod === "token" || authMethod === "password" || authMethod === "trusted-proxy";
        const sharedGatewaySessionGeneration = usesSharedGatewayAuth
          ? resolveSharedGatewaySessionGeneration(resolvedAuth, trustedProxies)
          : undefined;
        const sessionUsesSharedGatewayAuth =
          usesSharedGatewayAuth || deviceTokenSharedGatewaySessionGeneration !== undefined;
        const sessionSharedGatewaySessionGeneration =
          sharedGatewaySessionGeneration ?? deviceTokenSharedGatewaySessionGeneration;
        if (sessionUsesSharedGatewayAuth) {
          const requiredSharedGatewaySessionGeneration =
            getRequiredSharedGatewaySessionGeneration?.();
          if (
            requiredSharedGatewaySessionGeneration !== undefined &&
            sessionSharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration
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
        let handoffBootstrapProfile: DeviceBootstrapProfile | null = null;
        const trustedProxyAuthOk = isTrustedProxyControlUiOperatorAuth({
          isControlUi,
          role,
          authMode: resolvedAuth.mode,
          authOk,
          authMethod,
        });
        if (trustedProxyAuthOk) {
          scopes = resolveTrustedProxyControlUiScopes({
            requestedScopes: scopes,
            upgradeReq,
          });
          connectParams.scopes = scopes;
        }
        const skipControlUiPairingForDevice = shouldSkipControlUiPairing(
          controlUiAuthPolicy,
          role,
          trustedProxyAuthOk,
          resolvedAuth.mode,
          authMethod,
        );
        let hasServerApprovedDeviceTokenBaseline = false;
        if (device && devicePublicKey) {
          const formatAuditList = (items: string[] | undefined): string => {
            const normalized = normalizeSortedUniqueTrimmedStringList(items);
            return normalized.length > 0 ? normalized.join(",") : "<none>";
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
            remoteIp: reportedClientIp,
            lastSeenAtMs: Date.now(),
            lastSeenReason: "connect",
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
              const pairedScopes = resolvePairedAccessScopes(pairedCandidate);
              if (pairedScopes.length === 0) {
                return false;
              }
              return roleScopesAllow({
                role,
                requestedScopes: scopes,
                allowedScopes: pairedScopes,
              });
            };
            const allowSilentExistingNonOperatorPairing = !(
              existingPairedDevice && role !== "operator"
            );
            const allowSilentLocalPairing =
              allowSilentExistingNonOperatorPairing &&
              shouldAllowSilentLocalPairing({
                locality: pairingLocality,
                hasBrowserOriginHeader,
                isControlUi,
                isWebchat,
                isNativeAppUi,
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
            const boundBootstrapProfile =
              authMethod === "bootstrap-token" &&
              bootstrapTokenCandidate &&
              reason === "not-paired" &&
              !existingPairedDevice &&
              ((role === "node" &&
                scopes.length === 0 &&
                !isControlUi &&
                !isBrowserOperatorUi &&
                !isWebchat &&
                connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE) ||
                (isControlUi && role === "operator"))
                ? await getBoundDeviceBootstrapProfile({
                    token: bootstrapTokenCandidate,
                    deviceId: device.id,
                    publicKey: devicePublicKey,
                  })
                : null;
            const allowSetupCodeMobileBootstrapPairing =
              boundBootstrapProfile !== null &&
              isPairingSetupBootstrapProfile(boundBootstrapProfile) &&
              role === "node" &&
              scopes.length === 0 &&
              !isControlUi &&
              !isBrowserOperatorUi &&
              !isWebchat &&
              connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE &&
              isSetupCodeMobileBootstrapClient(connectParams.client);
            const setupCodeMobileBootstrapProfile = allowSetupCodeMobileBootstrapPairing
              ? boundBootstrapProfile
              : null;
            const allowControlUiOperatorBootstrapPairing = isControlUiOperatorBootstrapProfile({
              profile: boundBootstrapProfile,
              requestedScopes: scopes,
            });
            const controlUiOperatorBootstrapProfile = allowControlUiOperatorBootstrapPairing
              ? boundBootstrapProfile
              : null;
            // This is the native QR/setup-code onboarding seam. Mobile clients
            // must prove their canonical client id and platform/family metadata
            // agree before the Gateway can skip owner approval and hand off the
            // bounded operator token below. Admin/pairing still require an explicit owner flow.
            const bootstrapPairingRoles = setupCodeMobileBootstrapProfile
              ? uniqueStrings([role, ...setupCodeMobileBootstrapProfile.roles])
              : controlUiOperatorBootstrapProfile
                ? ["operator"]
                : undefined;
            const bootstrapPairingScopes = setupCodeMobileBootstrapProfile
              ? resolveBootstrapProfileScopesForRoles(
                  bootstrapPairingRoles ?? [],
                  setupCodeMobileBootstrapProfile.scopes,
                )
              : controlUiOperatorBootstrapProfile
                ? resolveBootstrapProfileScopesForRole(
                    "operator",
                    controlUiOperatorBootstrapProfile.scopes,
                  )
                : undefined;
            const bootstrapApprovalProfile =
              setupCodeMobileBootstrapProfile ?? controlUiOperatorBootstrapProfile;
            const pairing = await requestDevicePairing({
              deviceId: device.id,
              publicKey: devicePublicKey,
              ...clientPairingMetadata,
              ...(bootstrapPairingRoles
                ? {
                    roles: bootstrapPairingRoles,
                    scopes: bootstrapPairingScopes ?? [],
                  }
                : {}),
              silent:
                reason === "scope-upgrade"
                  ? false
                  : allowSilentLocalPairing ||
                    allowSilentTrustedCidrsNodePairing ||
                    allowSetupCodeMobileBootstrapPairing ||
                    allowControlUiOperatorBootstrapPairing,
            });
            const context = buildRequestContext();
            // A replacement request obsoletes older pending requestIds; tell approval
            // UIs so they drop the stale prompts instead of stacking alerts forever.
            const supersededResolvedAt = Date.now();
            for (const superseded of pairing.superseded ?? []) {
              context.broadcast(
                "device.pair.resolved",
                {
                  requestId: superseded.requestId,
                  deviceId: superseded.deviceId,
                  decision: "rejected",
                  ts: supersededResolvedAt,
                },
                { dropIfSlow: true },
              );
            }
            let approved: Awaited<ReturnType<typeof approveDevicePairing>> | undefined;
            let resolvedByConcurrentApproval = false;
            let recoveryRequestId: string | undefined;
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
              approved = bootstrapApprovalProfile
                ? await approveBootstrapDevicePairing(
                    pairing.request.requestId,
                    bootstrapApprovalProfile,
                    { accessMetadata: clientAccessMetadata },
                  )
                : await approveDevicePairing(pairing.request.requestId, {
                    callerScopes: scopes,
                    accessMetadata: clientAccessMetadata,
                    // Same-host local approvals are prune-eligible "silent";
                    // trusted-CIDR approvals cross hosts and must never be
                    // auto-pruned, so they carry their own provenance.
                    approvedVia: allowSilentLocalPairing ? "silent" : "trusted-cidr",
                  });
              if (approved?.status === "approved") {
                if (bootstrapApprovalProfile) {
                  handoffBootstrapProfile = bootstrapApprovalProfile;
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
                if (!(allowSetupCodeMobileBootstrapPairing && boundBootstrapProfile)) {
                  // Best-effort retirement of stale silent siblings; a prune
                  // failure must never fail the fresh device's handshake.
                  try {
                    await pruneSupersededSilentPairingsAfterApproval({
                      deviceId: approved.device.deviceId,
                      context,
                    });
                  } catch (error) {
                    logGateway.warn(
                      `device pairing prune failed device=${approved.device.deviceId} error=${String(error)}`,
                    );
                  }
                }
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
                ? resolvePairedAccessScopes(existingPairedDevice)
                : [];
              const retryAfterBootstrapPairingApproval =
                authMethod === "bootstrap-token" &&
                reason === "not-paired" &&
                role === "node" &&
                scopes.length === 0 &&
                !existingPairedDevice;
              const pairingErrorDetails = buildPairingConnectErrorDetails({
                reason,
                requestId: recoveryRequestId,
                ...(retryAfterBootstrapPairingApproval
                  ? {
                      recommendedNextStep: "wait_then_retry",
                      retryable: true,
                      pauseReconnect: false,
                    }
                  : {}),
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
              hasServerApprovedDeviceTokenBaseline = true;
            } else if (
              skipControlUiPairingForDevice ||
              (skipLocalBackendSelfPairing && authMethod !== "device-token")
            ) {
              hasServerApprovedDeviceTokenBaseline = true;
            }
          } else {
            hasServerApprovedDeviceTokenBaseline = true;
            const claimedPlatform = connectParams.client.platform;
            const pairedPlatform = paired.platform;
            const claimedDeviceFamily = connectParams.client.deviceFamily;
            const pairedDeviceFamily = paired.deviceFamily;
            const metadataPinning = resolvePinnedClientMetadata({
              clientId: connectParams.client.id,
              clientMode: connectParams.client.mode,
              claimedPlatform,
              claimedDeviceFamily,
              pairedPlatform,
              pairedDeviceFamily,
            });
            const { platformMismatch, deviceFamilyMismatch } = metadataPinning;
            if (platformMismatch || deviceFamilyMismatch) {
              const allowSilentMetadataUpgrade = shouldAllowSilentLocalPairing({
                locality: pairingLocality,
                hasBrowserOriginHeader,
                isControlUi,
                isWebchat,
                isNativeAppUi,
                reason: "metadata-upgrade",
              });
              if (!allowSilentMetadataUpgrade) {
                logGateway.warn(
                  `security audit: device metadata upgrade requested reason=metadata-upgrade device=${device.id} ip=${reportedClientIp ?? "unknown-ip"} auth=${authMethod} payload=${deviceAuthPayloadVersion ?? "unknown"} claimedPlatform=${claimedPlatform ?? "<none>"} pinnedPlatform=${pairedPlatform ?? "<none>"} claimedDeviceFamily=${claimedDeviceFamily ?? "<none>"} pinnedDeviceFamily=${pairedDeviceFamily ?? "<none>"} client=${connectParams.client.id} conn=${connId}`,
                );
              }
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
            const pairedScopes = resolvePairedAccessScopes(paired);
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

            const retryBootstrapHandoffProfile =
              authMethod === "bootstrap-token" &&
              bootstrapTokenCandidate &&
              role === "node" &&
              scopes.length === 0 &&
              !isControlUi &&
              !isBrowserOperatorUi &&
              !isWebchat &&
              connectParams.client.mode === GATEWAY_CLIENT_MODES.NODE &&
              pairedRoles.includes("operator")
                ? await getBoundDeviceBootstrapProfile({
                    token: bootstrapTokenCandidate,
                    deviceId: device.id,
                    publicKey: devicePublicKey,
                  })
                : null;
            if (retryBootstrapHandoffProfile) {
              const retryBootstrapOperatorScopes = resolveBootstrapProfileScopesForRole(
                "operator",
                retryBootstrapHandoffProfile.scopes,
              );
              if (
                isPairingSetupBootstrapProfile(retryBootstrapHandoffProfile) &&
                roleScopesAllow({
                  role: "operator",
                  requestedScopes: retryBootstrapOperatorScopes,
                  allowedScopes: pairedScopes,
                })
              ) {
                // If the first QR bootstrap hello-ok failed to reach mobile, the
                // bootstrap token is restored while the paired device already has
                // node+operator grants. Preserve the same bounded handoff on retry.
                handoffBootstrapProfile = retryBootstrapHandoffProfile;
              }
            }

            // Metadata pinning is approval-bound. Reconnects can update access metadata
            // and same-family mobile OS version labels, but real platform/device-family
            // changes must stay on the approved pairing record.
            await updatePairedDeviceMetadata(device.id, {
              ...clientAccessMetadata,
              ...(metadataPinning.refreshPairedPlatform
                ? { platform: metadataPinning.refreshPairedPlatform }
                : {}),
            });
          }
        }

        const shouldIssueDeviceToken = !trustedProxyAuthOk;
        const sharedGatewayAuthIssuer =
          sessionSharedGatewaySessionGeneration &&
          (deviceTokenSharedGatewaySessionGeneration !== undefined ||
            (usesSharedGatewayAuth && (isBrowserOperatorUi || isWebchat)))
            ? {
                kind: "shared-gateway-auth" as const,
                generation: sessionSharedGatewaySessionGeneration,
              }
            : undefined;
        const deviceToken =
          shouldIssueDeviceToken && device && hasServerApprovedDeviceTokenBaseline
            ? await ensureDeviceToken({
                deviceId: device.id,
                role,
                scopes,
                issuer: sharedGatewayAuthIssuer,
              })
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
        const approvedHandoffBootstrapProfile = handoffBootstrapProfile;
        if (device && approvedHandoffBootstrapProfile) {
          for (const bootstrapRole of approvedHandoffBootstrapProfile.roles) {
            if (bootstrapDeviceTokens.some((entry) => entry.role === bootstrapRole)) {
              continue;
            }
            // Extra hello-ok handoff tokens are only emitted for the approved
            // setup-code profile. Operator scopes are filtered through the
            // documented allowlist so QR bootstrap cannot grant admin/pairing.
            const bootstrapRoleScopes =
              bootstrapRole === "operator"
                ? resolveBootstrapProfileScopesForRole(
                    bootstrapRole,
                    approvedHandoffBootstrapProfile.scopes,
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
          const nodeId = connectParams.device?.id ?? connectParams.client.id;
          const nodePairingSnapshot = await beginNodePairingConnect(nodeId);
          const pairedNode = nodePairingSnapshot.pairedNode;
          pendingNodePairingCleanup = nodePairingSnapshot.cleanupClaim;
          let reconciliation: Awaited<ReturnType<typeof reconcileNodePairingOnConnect>>;
          try {
            reconciliation = await reconcileNodePairingOnConnect({
              cfg: getRuntimeConfig(),
              connectParams,
              pairedNode,
              reportedClientIp,
              requestPairing: async (input) => {
                return await requestNodePairingFromConnect({
                  input,
                  rateLimiter: authRateLimiter,
                  clientIp: browserRateLimitClientIp,
                  pairedReconnect: pairedNode !== null,
                  cleanupClaim: pendingNodePairingCleanup,
                  reapprovalCoordinator: nodeReapprovalCoordinator,
                });
              },
            });
          } catch (error) {
            await releasePendingNodePairingCleanup();
            if (error instanceof NodePairingRateLimitError) {
              rejectUnauthorized({
                ok: false,
                reason: "rate_limited",
                rateLimited: true,
                retryAfterMs: error.retryAfterMs,
              });
              return;
            }
            throw error;
          }
          if (!reconciliation.shouldClearPendingPairings) {
            await releasePendingNodePairingCleanup();
          }
          if (reconciliation.pendingPairing) {
            broadcastNodePairingResult(reconciliation.pendingPairing);
          }
          const nodeConnectParams = connectParams as ConnectParams & {
            declaredCaps?: string[];
            declaredCommands?: string[];
            declaredPermissions?: Record<string, boolean>;
            sessionCapsCeiling?: string[];
            sessionCommandsCeiling?: string[];
          };
          nodeConnectParams.declaredCaps = reconciliation.declaredCaps;
          nodeConnectParams.declaredCommands = reconciliation.declaredCommands;
          nodeConnectParams.declaredPermissions = reconciliation.declaredPermissions;
          const pluginSurfaces = pluginNodeCapabilities.map((surface) => surface.surface);
          if (usesLegacyNodeProtocol) {
            const sessionCeiling = filterLegacyNodeProtocolFeatures({
              caps: reconciliation.declaredCaps,
              commands: reconciliation.declaredCommands,
              pluginSurfaces,
            });
            nodeConnectParams.sessionCapsCeiling = sessionCeiling.caps;
            nodeConnectParams.sessionCommandsCeiling = sessionCeiling.commands;
          }
          const effectiveFeatures = usesLegacyNodeProtocol
            ? filterLegacyNodeProtocolFeatures({
                caps: reconciliation.effectiveCaps,
                commands: reconciliation.effectiveCommands,
                pluginSurfaces,
              })
            : {
                caps: reconciliation.effectiveCaps,
                commands: reconciliation.effectiveCommands,
              };
          connectParams.caps = effectiveFeatures.caps;
          connectParams.commands = effectiveFeatures.commands;
          connectParams.permissions = reconciliation.effectivePermissions;
        }

        const shouldTrackPresence = !isGatewayCliClient(connectParams.client);
        const clientId = connectParams.client.id;
        const instanceId = connectParams.client.instanceId;
        const presenceKey = shouldTrackPresence ? (device?.id ?? instanceId ?? connId) : undefined;

        if (isClosed()) {
          await releasePendingNodePairingCleanup();
          setCloseCause("connect-aborted-before-register", {
            ...clientMeta,
            auth: authMethod,
          });
          return;
        }

        const pluginSurfaceUrls: Record<string, string> = {};
        const pluginNodeCapabilitySurfaces =
          indexPluginNodeCapabilitySurfaces(pluginNodeCapabilities);
        const pendingPluginNodeCapabilities: Array<{
          surface: PluginNodeCapabilitySurface;
          capability: string;
          expiresAtMs: number;
        }> = [];
        if (pluginSurfaceBaseUrl && !usesLegacyNodeProtocol) {
          for (const pluginCapabilitySurface of Object.values(pluginNodeCapabilitySurfaces)) {
            const capability = mintPluginNodeCapabilityToken();
            const expiresAtMs = resolvePluginNodeCapabilityExpiresAtMs(pluginCapabilitySurface);
            if (expiresAtMs === undefined) {
              continue;
            }
            const scopedUrl =
              buildPluginNodeCapabilityScopedHostUrl(pluginSurfaceBaseUrl, capability) ??
              pluginSurfaceBaseUrl;
            pluginSurfaceUrls[pluginCapabilitySurface.surface] = scopedUrl;
            pendingPluginNodeCapabilities.push({
              surface: pluginCapabilitySurface,
              capability,
              expiresAtMs,
            });
          }
        }
        const isTrustedApprovalRuntime =
          pairingLocality !== "remote" &&
          scopes.includes(APPROVALS_SCOPE) &&
          connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
          connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND &&
          isOperatorApprovalRuntimeToken(connectParams.auth?.approvalRuntimeToken);
        const agentRuntimeIdentityToken = connectParams.auth?.agentRuntimeIdentityToken;
        const canAcceptAgentRuntimeIdentity =
          pairingLocality !== "remote" &&
          connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
          connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND;
        let trustedAgentRuntimeIdentity:
          | ReturnType<typeof verifyAgentRuntimeIdentityToken>
          | undefined;
        if (typeof agentRuntimeIdentityToken === "string") {
          if (!canAcceptAgentRuntimeIdentity) {
            const message =
              "agent runtime identity token is only accepted from local backend gateway clients";
            markHandshakeFailure("agent-runtime-identity-untrusted-client", {
              client: connectParams.client.id,
              mode: connectParams.client.mode,
              pairingLocality,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, message);
            close(1008, truncateCloseReason(message));
            return;
          }
          trustedAgentRuntimeIdentity = verifyAgentRuntimeIdentityToken(agentRuntimeIdentityToken);
          if (!trustedAgentRuntimeIdentity) {
            const message = "invalid agent runtime identity token";
            markHandshakeFailure("agent-runtime-identity-invalid", {
              client: connectParams.client.id,
              mode: connectParams.client.mode,
              pairingLocality,
            });
            sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, message);
            close(1008, message);
            return;
          }
        }
        const internal =
          isTrustedApprovalRuntime || trustedAgentRuntimeIdentity
            ? {
                ...(isTrustedApprovalRuntime ? { approvalRuntime: true } : {}),
                ...(trustedAgentRuntimeIdentity
                  ? { agentRuntimeIdentity: trustedAgentRuntimeIdentity }
                  : {}),
              }
            : undefined;
        if (usesLegacyNodeProtocol) {
          logWsControl.warn(
            `legacy node protocol accepted conn=${connId} client=${formatForLog(clientLabel)} v${formatForLog(connectParams.client.version)} min=${minProtocol} max=${maxProtocol} current=${PROTOCOL_VERSION}; upgrade recommended`,
          );
        }
        clearHandshakeTimer();
        const nextClient: GatewayWsClient = {
          socket,
          connect: connectParams,
          connId,
          isDeviceTokenAuth: authMethod === "device-token",
          usesSharedGatewayAuth: sessionUsesSharedGatewayAuth,
          sharedGatewaySessionGeneration: sessionSharedGatewaySessionGeneration,
          presenceKey,
          clientIp: reportedClientIp,
          ...(internal ? { internal } : {}),
          ...(Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {}),
          ...(Object.keys(pluginNodeCapabilitySurfaces).length > 0
            ? { pluginNodeCapabilitySurfaces }
            : {}),
        };
        for (const entry of pendingPluginNodeCapabilities) {
          setClientPluginNodeCapability({
            client: nextClient,
            surface: entry.surface,
            capability: entry.capability,
            expiresAtMs: entry.expiresAtMs,
          });
        }
        setSocketMaxPayload(socket, MAX_PAYLOAD_BYTES);

        // Version mismatch: kick the local node host so the OS supervisor restarts it.
        // Only applies when the connecting node is the same-install local node (verified by
        // matching instanceId against ~/.openclaw/node.json nodeId). SSH-tunneled remote
        // nodes also appear as loopback but have different instanceIds, so they are exempt.
        // Placed before setClient/presence to avoid phantom online state on rejection.
        if (role === "node" && isLocalClient) {
          const localNodeId = resolveLocalNodeId();
          const clientInstanceId = connectParams.client.instanceId?.trim();
          if (localNodeId && clientInstanceId && clientInstanceId === localNodeId) {
            const gatewayVersion = resolveRuntimeServiceVersion(process.env);
            const clientVersion = connectParams.client.version;
            if (
              clientVersion &&
              gatewayVersion &&
              clientVersion !== gatewayVersion &&
              isReleasedVersion(gatewayVersion) &&
              isReleasedVersion(clientVersion)
            ) {
              logWsControl.info(
                `node version mismatch conn=${connId} client=${formatForLog(clientLabel)} clientVersion=${formatForLog(clientVersion)} gatewayVersion=${gatewayVersion}; closing for supervisor restart`,
              );
              sendHandshakeErrorResponse(ErrorCodes.INVALID_REQUEST, "client version mismatch", {
                details: {
                  code: ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH,
                  clientVersion,
                  gatewayVersion,
                },
              });
              await releasePendingNodePairingCleanup();
              close(1008, "client version mismatch");
              return;
            }
          }
        }

        if (!setClient(nextClient)) {
          await releasePendingNodePairingCleanup();
          setCloseCause("connect-aborted-before-register", {
            ...clientMeta,
            auth: authMethod,
          });
          return;
        }
        setHandshakeState("connected");
        advanceHandshakePhase("session_attached");
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
        if (role === "node") {
          const context = buildRequestContext();
          const nodeSession = context.nodeRegistry.register(nextClient, {
            remoteIp: reportedClientIp,
          });
          const instanceIdRaw = connectParams.client.instanceId;
          const instanceIdLocal = typeof instanceIdRaw === "string" ? instanceIdRaw.trim() : "";
          const nodeIdsForPairing = new Set<string>([nodeSession.nodeId]);
          if (instanceIdLocal) {
            nodeIdsForPairing.add(instanceIdLocal);
          }
          for (const nodeId of nodeIdsForPairing) {
            void updatePairedNodeMetadata(nodeId, {
              lastConnectedAtMs: nodeSession.connectedAtMs,
            }).catch((err: unknown) =>
              logGateway.warn(`failed to record last connect for ${nodeId}: ${formatForLog(err)}`),
            );
          }
          recordRemoteNodeInfo({
            nodeId: nodeSession.nodeId,
            connId: nodeSession.connId,
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
            cfg: getRuntimeConfig(),
            // The node socket is registered before macOS app command handlers finish warming.
            // Delay only the connect-time probe; later skill refreshes use the live session.
            readinessDelayMs: 5_000,
          }).catch((err: unknown) =>
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
            .catch((err: unknown) =>
              logGateway.warn(
                `voicewake snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
              ),
            );
          void loadVoiceWakeRoutingConfig()
            .then((routing) => {
              context.nodeRegistry.sendEvent(nodeSession.nodeId, "voicewake.routing.changed", {
                config: routing,
              });
            })
            .catch((err: unknown) =>
              logGateway.warn(
                `voicewake routing snapshot failed for ${nodeSession.nodeId}: ${formatForLog(err)}`,
              ),
            );
        }

        const snapshot = buildGatewaySnapshot({
          includeSensitive: scopes.includes(ADMIN_SCOPE),
        });
        const cachedHealth = getHealthCache();
        if (cachedHealth) {
          snapshot.health = cachedHealth;
          snapshot.stateVersion.health = getHealthVersion();
        }
        const helloOkAuthScopes = deviceToken ? deviceToken.scopes : scopes;
        const controlUiTabs = listControlUiPluginTabs(helloOkAuthScopes);
        const helloOk = {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: {
            version: resolveRuntimeServiceVersion(process.env),
            connId,
          },
          features: {
            methods: gatewayMethods,
            events,
            capabilities: [GATEWAY_SERVER_CAPS.CHAT_SEND_ROUTING_CONTRACT],
          },
          snapshot,
          ...(controlUiTabs.length > 0 ? { controlUiTabs } : {}),
          ...(Object.keys(pluginSurfaceUrls).length > 0 ? { pluginSurfaceUrls } : {}),
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
        advanceHandshakePhase("hello_payload_prepared");

        let revokedBootstrapTokenRecord:
          | Awaited<ReturnType<typeof revokeDeviceBootstrapToken>>["record"]
          | undefined;
        if (authMethod === "bootstrap-token" && bootstrapTokenCandidate && device) {
          try {
            if (handoffBootstrapProfile || issuedBootstrapProfile) {
              const redemption = await redeemDeviceBootstrapTokenProfile({
                token: bootstrapTokenCandidate,
                role,
                scopes,
              });
              if (handoffBootstrapProfile || redemption.fullyRedeemed) {
                const revoked = await revokeDeviceBootstrapToken({
                  token: bootstrapTokenCandidate,
                });
                if (!revoked.removed) {
                  logGateway.warn(
                    `bootstrap token revoke skipped after profile redemption device=${device.id}`,
                  );
                } else {
                  revokedBootstrapTokenRecord = revoked.record;
                }
              }
            }
          } catch (err) {
            logGateway.warn(
              `bootstrap token post-connect bookkeeping failed device=${device.id}: ${formatForLog(err)}`,
            );
          }
        }
        try {
          await sendFrame({ type: "res", id: frame.id, ok: true, payload: helloOk });
        } catch (err) {
          if (revokedBootstrapTokenRecord) {
            try {
              await restoreDeviceBootstrapToken({ record: revokedBootstrapTokenRecord });
            } catch (restoreErr) {
              logGateway.warn(
                `bootstrap token restore after hello-send failure failed device=${device?.id ?? "unknown"}: ${formatForLog(restoreErr)}`,
              );
            }
          }
          await releasePendingNodePairingCleanup();
          setCloseCause("hello-send-failed", { error: formatForLog(err) });
          close();
          return;
        }
        emitGatewayAuthSecurityEvent({
          action: "gateway.auth.succeeded",
          outcome: "success",
          severity: "low",
          authMode: resolvedAuth.mode,
          authMethod,
          authProvided:
            authMethod === "device-token" || authMethod === "bootstrap-token"
              ? authMethod
              : hasPasswordAuth
                ? "password"
                : hasTokenAuth
                  ? "token"
                  : authMethod,
          role,
          scopes: helloOkAuthScopes,
          clientMode: connectParams.client.mode,
          deviceId: device?.id,
        });
        advanceHandshakePhase("ready");
        if (pendingNodePairingCleanup) {
          const context = buildRequestContext();
          const cleanupClaim = pendingNodePairingCleanup;
          pendingNodePairingCleanup = undefined;
          try {
            const resolvedPairings = nodeReapprovalCoordinator
              ? await nodeReapprovalCoordinator.finalizeCleanup(cleanupClaim)
              : await finalizeNodePairingCleanupClaim(cleanupClaim);
            const resolvedAt = Date.now();
            for (const resolved of resolvedPairings) {
              context.broadcast(
                "node.pair.resolved",
                {
                  requestId: resolved.requestId,
                  nodeId: resolved.nodeId,
                  decision: "rejected",
                  ts: resolvedAt,
                },
                { dropIfSlow: true },
              );
            }
          } catch (error) {
            logGateway.warn(
              `failed to clear stale pending pairings for ${cleanupClaim.nodeId}: ${formatForLog(error)}`,
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
        // Post-connect refresh only needs a cached/config snapshot for UI state;
        // live channel probes here pulled slow Discord/Telegram HTTP checks into
        // reply-adjacent websocket handshakes.
        void refreshHealthSnapshot({ probe: false }).catch((err: unknown) =>
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
      for (;;) {
        const barrier = deviceCredentialMutationBarrier;
        if (!barrier) {
          break;
        }
        await barrier.catch(() => undefined);
        if (isClosed()) {
          return;
        }
      }
      if (closeInvalidatedClient(client, req.method)) {
        return;
      }
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

      const dispatch = (async () => {
        const { handleGatewayRequest } = await import("../../server-methods.js");
        await handleGatewayRequest({
          req,
          respond,
          client,
          isWebchatConnect,
          extraHandlers,
          methodRegistry: getMethodRegistry?.(),
          context: buildRequestContext(),
        });
      })().catch((err: unknown) => {
        logGateway.error(`request handler failed: ${formatForLog(err)}`);
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err)));
      });
      if (DEVICE_CREDENTIAL_INVALIDATING_METHODS.has(req.method)) {
        const barrier = dispatch.finally(() => {
          if (deviceCredentialMutationBarrier === barrier) {
            deviceCredentialMutationBarrier = undefined;
          }
        });
        deviceCredentialMutationBarrier = barrier;
      }
      void dispatch;
    } catch (err) {
      await releasePendingNodePairingCleanup();
      logGateway.error(`parse/handle error: ${String(err)}`);
      logWs("out", "parse-error", { connId, error: formatForLog(err) });
      if (!getClient()) {
        close();
      }
    }
  };

  socket.on("message", (data) => {
    void runWithDiagnosticTraceContext(createDiagnosticTraceContext(), () => handleMessage(data));
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
  const receiver = (socket as { _receiver?: { _maxPayload?: number } })["_receiver"];
  if (receiver) {
    receiver["_maxPayload"] = maxPayload;
  }
}

export const testing = {
  resolvePinnedClientMetadata,
};
export { testing as __testing };
