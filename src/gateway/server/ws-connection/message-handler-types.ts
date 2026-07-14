import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import type {
  ConnectParams,
  RequestFrame,
  errorShape,
} from "../../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { DeviceAuthToken } from "../../../infra/device-pairing.types.js";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { DeviceBootstrapProfile } from "../../../shared/device-bootstrap-profile.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { GatewayAuthResult, ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayMethodRegistry } from "../../methods/registry.js";
import type { NodePairingAutoApproveClientIpSource } from "../../node-pairing-auto-approve.types.js";
import type { NodeReapprovalCoordinator } from "../../node-reapproval-coordinator.js";
import type { PluginNodeCapabilitySurface } from "../../plugin-node-capability.js";
import type { GatewayRole } from "../../role-policy.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import type { GatewayWsClient, WsHandshakePhase } from "../ws-types.js";
import type { resolveControlUiAuthPolicy } from "./connect-policy.js";
import type { resolvePairingLocality } from "./handshake-auth-helpers.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;
type ControlUiAuthPolicy = ReturnType<typeof resolveControlUiAuthPolicy>;
type PairingLocalityKind = ReturnType<typeof resolvePairingLocality>;

export type WsOriginCheckMetrics = {
  hostHeaderFallbackAccepted: number;
};

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

export type GatewayConnectPhaseContext = {
  handler: GatewayWsMessageHandlerParams;
  frame: RequestFrame;
  connectParams: ConnectParams;
  configSnapshot: OpenClawConfig;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  peerLabel: string;
  hasProxyHeaders: boolean;
  isLocalClient: boolean;
  reportedClientIp?: string;
  reportedClientIpSource: NodePairingAutoApproveClientIpSource;
  hasBrowserOriginHeader: boolean;
  enforceOriginCheckForAnyClient: boolean;
  browserRateLimitClientIp?: string;
  authRateLimiter?: AuthRateLimiter;
  clientLabel: string;
  clientMeta: Record<string, unknown>;
  markHandshakeFailure: (cause: string, meta?: Record<string, unknown>) => void;
  sendHandshakeErrorResponse: (
    code: Parameters<typeof errorShape>[0],
    message: string,
    options?: Parameters<typeof errorShape>[2],
  ) => void;
  sendFrame: (obj: unknown) => Promise<void>;
  isWebchatConnect: (params: ConnectParams | null | undefined) => boolean;
  runDetachedConnectWork: (run: () => Promise<void>, onError: (error: unknown) => void) => void;
  pendingNodePairingCleanup: {
    value?: import("../../../infra/node-pairing.js").NodePairingCleanupClaim;
  };
  broadcastNodePairingResult: (
    result: import("../../../infra/node-pairing.js").RequestNodePairingResult,
  ) => void;
  releasePendingNodePairingCleanup: () => Promise<void>;
};

export type AuthenticatedGatewayConnect = {
  resolvedAuth: ResolvedGatewayAuth;
  minProtocol: number;
  maxProtocol: number;
  usesLegacyNodeProtocol: boolean;
  role: GatewayRole;
  scopes: string[];
  isControlUi: boolean;
  isBrowserOperatorUi: boolean;
  isWebchat: boolean;
  isNativeAppUi: boolean;
  controlUiAuthPolicy: ControlUiAuthPolicy;
  device: ConnectParams["device"] | null | undefined;
  devicePublicKey: string | null;
  deviceAuthPayloadVersion: "v2" | "v3" | null;
  hasTokenAuth: boolean;
  hasPasswordAuth: boolean;
  bootstrapTokenCandidate?: string;
  deviceTokenSharedGatewaySessionGeneration?: string;
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  pairingLocality: PairingLocalityKind;
  usesSharedGatewayAuth: boolean;
  sessionUsesSharedGatewayAuth: boolean;
  sessionSharedGatewaySessionGeneration?: string;
  issuedBootstrapProfile: DeviceBootstrapProfile | null;
  handoffBootstrapProfile: DeviceBootstrapProfile | null;
  trustedProxyAuthOk: boolean;
  skipControlUiPairingForDevice: boolean;
  skipLocalBackendSelfPairing: boolean;
  rejectUnauthorized: (failedAuth: GatewayAuthResult) => void;
};

export type DeviceAuthorizedGatewayConnect = AuthenticatedGatewayConnect & {
  deviceToken: DeviceAuthToken | null;
  bootstrapDeviceTokens: Array<{
    deviceToken: string;
    role: string;
    scopes: string[];
    issuedAtMs: number;
  }>;
};
