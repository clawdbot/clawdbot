// Handshake auth helpers classify browser security context, pairing locality, and connect auth details.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { ConnectParams } from "../../../../packages/gateway-protocol/src/index.js";
import { verifyDeviceSignature } from "../../../infra/device-identity.js";
import type { AuthRateLimiter } from "../../auth-rate-limit.js";
import type { GatewayAuthResult } from "../../auth.js";
import { buildDeviceAuthPayload, buildDeviceAuthPayloadV3 } from "../../device-auth.js";
import {
  isLoopbackAddress,
  isLoopbackHost,
  isPrivateOrLoopbackAddress,
  isPrivateOrLoopbackHost,
  resolveHostName,
} from "../../net.js";
import type { AuthProvidedKind } from "./auth-messages.js";

const BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP = "198.18.0.1";
const BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX = "browser-origin:";
type PairingLocalityKind =
  | "direct_local"
  | "cli_container_local"
  | "browser_container_local"
  | "shared_secret_loopback_local"
  | "remote";

type HandshakeBrowserSecurityContext = {
  hasBrowserOriginHeader: boolean;
  enforceOriginCheckForAnyClient: boolean;
  rateLimitClientIp: string | undefined;
  authRateLimiter?: AuthRateLimiter;
};

export function isNativeAppUiClient(client: ConnectParams["client"]): boolean {
  return (
    client.mode === GATEWAY_CLIENT_MODES.UI &&
    (client.id === GATEWAY_CLIENT_IDS.MACOS_APP ||
      client.id === GATEWAY_CLIENT_IDS.LINUX_APP ||
      client.id === GATEWAY_CLIENT_IDS.IOS_APP ||
      client.id === GATEWAY_CLIENT_IDS.ANDROID_APP)
  );
}

function resolveBrowserOriginRateLimitKey(requestOrigin?: string): string {
  const trimmedOrigin = requestOrigin?.trim();
  if (!trimmedOrigin) {
    return BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP;
  }
  try {
    return `${BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX}${normalizeLowercaseStringOrEmpty(new URL(trimmedOrigin).origin)}`;
  } catch {
    return BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP;
  }
}

export function resolveHandshakeBrowserSecurityContext(params: {
  requestOrigin?: string;
  clientIp: string | undefined;
  rateLimiter?: AuthRateLimiter;
  browserRateLimiter?: AuthRateLimiter;
}): HandshakeBrowserSecurityContext {
  const hasBrowserOriginHeader = Boolean(
    params.requestOrigin && params.requestOrigin.trim() !== "",
  );
  return {
    hasBrowserOriginHeader,
    enforceOriginCheckForAnyClient: hasBrowserOriginHeader,
    rateLimitClientIp:
      hasBrowserOriginHeader && isLoopbackAddress(params.clientIp)
        ? resolveBrowserOriginRateLimitKey(params.requestOrigin)
        : params.clientIp,
    authRateLimiter:
      hasBrowserOriginHeader && params.browserRateLimiter
        ? params.browserRateLimiter
        : params.rateLimiter,
  };
}

export function shouldAllowSilentLocalPairing(params: {
  autoApproveLocal?: boolean;
  locality: PairingLocalityKind;
  hasBrowserOriginHeader: boolean;
  isControlUi: boolean;
  isWebchat: boolean;
  isNativeAppUi?: boolean;
  authMethod?: GatewayAuthResult["method"];
  reason: "not-paired" | "role-upgrade" | "scope-upgrade" | "metadata-upgrade";
}): boolean {
  if (params.locality === "remote") {
    return false;
  }
  if (params.hasBrowserOriginHeader && !params.isControlUi && !params.isWebchat) {
    return false;
  }
  if (params.reason === "metadata-upgrade") {
    // Metadata-only reconnect refreshes stay automatic even when the operator
    // disabled autoApproveLocal, to avoid approval churn after benign client or
    // OS metadata changes. Direct-local refresh is limited to first-party
    // native app UI clients; node-host, Browser, and Control-UI metadata
    // pinning stays on the explicit approval path.
    return (
      !params.hasBrowserOriginHeader &&
      !params.isControlUi &&
      !params.isWebchat &&
      ((params.locality === "direct_local" && params.isNativeAppUi === true) ||
        params.locality === "cli_container_local" ||
        params.locality === "shared_secret_loopback_local")
    );
  }
  // Operators can require explicit approval for pairing and access upgrades.
  if (params.autoApproveLocal === false) {
    return false;
  }
  if (params.reason === "scope-upgrade") {
    // Silently widening an existing row grants nothing a fresh local identity
    // could not get through silent initial pairing — but only when this
    // connect proved local-grade credentials itself. Identity-proxy methods
    // (tailscale, trusted-proxy) and bearer device tokens never did, so their
    // rows remain a durable scope cap.
    return (
      params.authMethod === "none" ||
      params.authMethod === "token" ||
      params.authMethod === "password"
    );
  }
  return true;
}

function isCliCliClient(client: ConnectParams["client"]): boolean {
  return client.id === GATEWAY_CLIENT_IDS.CLI && client.mode === GATEWAY_CLIENT_MODES.CLI;
}

function isSharedSecretAuthMethod(method: GatewayAuthResult["method"]): boolean {
  return method === "token" || method === "password";
}

function isSharedSecretLoopbackLocalEquivalent(params: {
  requestHost?: string;
  remoteAddress?: string;
  hasProxyHeaders: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  return (
    params.sharedAuthOk &&
    isSharedSecretAuthMethod(params.authMethod) &&
    !params.hasProxyHeaders &&
    !params.hasBrowserOriginHeader &&
    isLoopbackAddress(params.remoteAddress) &&
    isPrivateOrLoopbackHost(resolveHostName(params.requestHost))
  );
}

function resolveOriginHost(origin?: string): string {
  const trimmed = origin?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).hostname;
  } catch {
    return "";
  }
}

function isControlUiBrowserContainerLocalEquivalent(params: {
  connectParams: ConnectParams;
  requestHost?: string;
  requestOrigin?: string;
  remoteAddress?: string;
  hasProxyHeaders: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  const isControlUiBrowser =
    params.connectParams.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.WEBCHAT;
  return (
    isControlUiBrowser &&
    params.sharedAuthOk &&
    isSharedSecretAuthMethod(params.authMethod) &&
    !params.hasProxyHeaders &&
    params.hasBrowserOriginHeader &&
    isPrivateOrLoopbackAddress(params.remoteAddress) &&
    isLoopbackHost(resolveHostName(params.requestHost)) &&
    isLoopbackHost(resolveOriginHost(params.requestOrigin))
  );
}

export function resolvePairingLocality(params: {
  connectParams: ConnectParams;
  isLocalClient: boolean;
  requestHost?: string;
  requestOrigin?: string;
  remoteAddress?: string;
  hasProxyHeaders: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): PairingLocalityKind {
  if (params.isLocalClient) {
    return "direct_local";
  }
  if (isControlUiBrowserContainerLocalEquivalent(params)) {
    return "browser_container_local";
  }
  if (isSharedSecretLoopbackLocalEquivalent(params)) {
    // The CLI container lane shares the shared-secret loopback predicate; only
    // the client class distinguishes it for scope-preservation policy.
    return isCliCliClient(params.connectParams.client)
      ? "cli_container_local"
      : "shared_secret_loopback_local";
  }
  return "remote";
}

export function shouldSkipLocalBackendSelfPairing(params: {
  connectParams: ConnectParams;
  locality: PairingLocalityKind;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  const isBackendClient =
    params.connectParams.client.id === GATEWAY_CLIENT_IDS.GATEWAY_CLIENT &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.BACKEND;
  const isLocal =
    params.locality === "direct_local" || params.locality === "shared_secret_loopback_local";
  if (!isBackendClient || !isLocal || params.hasBrowserOriginHeader) {
    return false;
  }
  // No-auth local backend: scoped bypass — not shared secret, but local-only
  // device-less operation is safe when auth.mode is explicitly "none".
  return (
    params.authMethod === "none" ||
    params.authMethod === "device-token" ||
    (params.sharedAuthOk && isSharedSecretAuthMethod(params.authMethod))
  );
}

export function shouldPreserveLocalCliSharedAuthScopes(params: {
  connectParams: ConnectParams;
  locality: PairingLocalityKind;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  return (
    isCliCliClient(params.connectParams.client) &&
    (params.locality === "direct_local" || params.locality === "cli_container_local") &&
    !params.hasBrowserOriginHeader &&
    params.sharedAuthOk &&
    isSharedSecretAuthMethod(params.authMethod)
  );
}

function resolveSignatureToken(connectParams: ConnectParams): string | null {
  return (
    connectParams.auth?.token ??
    connectParams.auth?.deviceToken ??
    connectParams.auth?.bootstrapToken ??
    null
  );
}

function buildUnauthorizedHandshakeContext(params: {
  authProvided: AuthProvidedKind;
  canRetryWithDeviceToken: boolean;
  recommendedNextStep:
    | "retry_with_device_token"
    | "update_auth_configuration"
    | "update_auth_credentials"
    | "wait_then_retry"
    | "review_auth_configuration";
}) {
  return {
    authProvided: params.authProvided,
    canRetryWithDeviceToken: params.canRetryWithDeviceToken,
    recommendedNextStep: params.recommendedNextStep,
  };
}

export function resolveDeviceSignaturePayloadVersion(params: {
  device: {
    id: string;
    signature: string;
    publicKey: string;
  };
  connectParams: ConnectParams;
  role: string;
  scopes: string[];
  signedAtMs: number;
  nonce: string;
}): "v3" | "v2" | null {
  const signatureToken = resolveSignatureToken(params.connectParams);
  const basePayload = {
    deviceId: params.device.id,
    clientId: params.connectParams.client.id,
    clientMode: params.connectParams.client.mode,
    role: params.role,
    scopes: params.scopes,
    signedAtMs: params.signedAtMs,
    token: signatureToken,
    nonce: params.nonce,
  };
  const payloadV3 = buildDeviceAuthPayloadV3({
    ...basePayload,
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
  });
  if (verifyDeviceSignature(params.device.publicKey, payloadV3, params.device.signature)) {
    return "v3";
  }

  const payloadV2 = buildDeviceAuthPayload(basePayload);
  if (verifyDeviceSignature(params.device.publicKey, payloadV2, params.device.signature)) {
    return "v2";
  }
  return null;
}

function resolveAuthProvidedKind(connectAuth: ConnectParams["auth"] | null): AuthProvidedKind {
  return connectAuth?.password
    ? "password"
    : connectAuth?.token
      ? "token"
      : connectAuth?.bootstrapToken
        ? "bootstrap-token"
        : connectAuth?.deviceToken
          ? "device-token"
          : "none";
}

export function resolveUnauthorizedHandshakeContext(params: {
  connectAuth: ConnectParams["auth"] | null;
  failedAuth: GatewayAuthResult;
  hasDeviceIdentity: boolean;
}): {
  authProvided: AuthProvidedKind;
  canRetryWithDeviceToken: boolean;
  recommendedNextStep:
    | "retry_with_device_token"
    | "update_auth_configuration"
    | "update_auth_credentials"
    | "wait_then_retry"
    | "review_auth_configuration";
} {
  const authProvided = resolveAuthProvidedKind(params.connectAuth);
  const canRetryWithDeviceToken =
    params.failedAuth.reason === "token_mismatch" &&
    params.hasDeviceIdentity &&
    authProvided === "token" &&
    !params.connectAuth?.deviceToken;
  if (canRetryWithDeviceToken) {
    return buildUnauthorizedHandshakeContext({
      authProvided,
      canRetryWithDeviceToken,
      recommendedNextStep: "retry_with_device_token",
    });
  }
  switch (params.failedAuth.reason) {
    case "token_missing":
    case "token_missing_config":
    case "password_missing":
    case "password_missing_config":
      return buildUnauthorizedHandshakeContext({
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "update_auth_configuration",
      });
    case "token_mismatch":
    case "password_mismatch":
    case "device_token_mismatch":
      return buildUnauthorizedHandshakeContext({
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "update_auth_credentials",
      });
    case "scope_mismatch":
      return buildUnauthorizedHandshakeContext({
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "review_auth_configuration",
      });
    case "rate_limited":
      return buildUnauthorizedHandshakeContext({
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "wait_then_retry",
      });
    default:
      return buildUnauthorizedHandshakeContext({
        authProvided,
        canRetryWithDeviceToken,
        recommendedNextStep: "review_auth_configuration",
      });
  }
}
