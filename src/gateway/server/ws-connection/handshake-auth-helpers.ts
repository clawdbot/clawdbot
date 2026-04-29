import { verifyDeviceSignature } from "../../../infra/device-identity.js";
import { normalizeLowercaseStringOrEmpty } from "../../../shared/string-coerce.js";
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
import { GATEWAY_CLIENT_IDS, GATEWAY_CLIENT_MODES } from "../../protocol/client-info.js";
import type { ConnectParams } from "../../protocol/index.js";
import type { AuthProvidedKind } from "./auth-messages.js";

export const BROWSER_ORIGIN_LOOPBACK_RATE_LIMIT_IP = "198.18.0.1";
export const BROWSER_ORIGIN_RATE_LIMIT_KEY_PREFIX = "browser-origin:";
export type PairingLocalityKind =
  | "direct_local"
  | "cli_container_local"
  | "browser_container_local"
  | "shared_secret_loopback_local"
  | "remote";

export type HandshakeBrowserSecurityContext = {
  hasBrowserOriginHeader: boolean;
  enforceOriginCheckForAnyClient: boolean;
  rateLimitClientIp: string | undefined;
  authRateLimiter?: AuthRateLimiter;
};

type HandshakeConnectAuth = {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
};

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
  locality: PairingLocalityKind;
  hasBrowserOriginHeader: boolean;
  isControlUi: boolean;
  isWebchat: boolean;
  isNativeAppUi?: boolean;
  reason: "not-paired" | "role-upgrade" | "scope-upgrade" | "metadata-upgrade";
}): boolean {
  if (params.locality === "remote") {
    return false;
  }
  if (params.hasBrowserOriginHeader && !params.isControlUi && !params.isWebchat) {
    return false;
  }
  if (
    params.reason === "not-paired" ||
    params.reason === "scope-upgrade" ||
    params.reason === "role-upgrade"
  ) {
    return true;
  }
  // metadata-upgrade auto-approves only for non-browser local reconnects that
  // already proved possession of local/shared credentials. Direct-local
  // metadata refresh is limited to first-party native app UI clients, covering
  // same-host app reconnects after OS version metadata changes while keeping
  // node-host, Browser, and Control-UI metadata pinning on the explicit approval path.
  if (
    params.reason === "metadata-upgrade" &&
    !params.hasBrowserOriginHeader &&
    !params.isControlUi &&
    !params.isWebchat &&
    ((params.locality === "direct_local" && params.isNativeAppUi === true) ||
      params.locality === "cli_container_local" ||
      params.locality === "shared_secret_loopback_local")
  ) {
    return true;
  }
  return false;
}

function isCliContainerLocalEquivalent(params: {
  connectParams: ConnectParams;
  requestHost?: string;
  remoteAddress?: string;
  hasProxyHeaders: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  const isCliClient =
    params.connectParams.client.id === GATEWAY_CLIENT_IDS.CLI &&
    params.connectParams.client.mode === GATEWAY_CLIENT_MODES.CLI;
  const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
  return (
    isCliClient &&
    params.sharedAuthOk &&
    usesSharedSecretAuth &&
    !params.hasProxyHeaders &&
    !params.hasBrowserOriginHeader &&
    isLoopbackAddress(params.remoteAddress) &&
    isPrivateOrLoopbackHost(resolveHostName(params.requestHost))
  );
}

function isSharedSecretLoopbackLocalEquivalent(params: {
  requestHost?: string;
  remoteAddress?: string;
  hasProxyHeaders: boolean;
  hasBrowserOriginHeader: boolean;
  sharedAuthOk: boolean;
  authMethod: GatewayAuthResult["method"];
}): boolean {
  const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
  return (
    params.sharedAuthOk &&
    usesSharedSecretAuth &&
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
  const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
  return (
    isControlUiBrowser &&
    params.sharedAuthOk &&
    usesSharedSecretAuth &&
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
  if (
    isControlUiBrowserContainerLocalEquivalent({
      connectParams: params.connectParams,
      requestHost: params.requestHost,
      requestOrigin: params.requestOrigin,
      remoteAddress: params.remoteAddress,
      hasProxyHeaders: params.hasProxyHeaders,
      hasBrowserOriginHeader: params.hasBrowserOriginHeader,
      sharedAuthOk: params.sharedAuthOk,
      authMethod: params.authMethod,
    })
  ) {
    return "browser_container_local";
  }
  if (
    isCliContainerLocalEquivalent({
      connectParams: params.connectParams,
      requestHost: params.requestHost,
      remoteAddress: params.remoteAddress,
      hasProxyHeaders: params.hasProxyHeaders,
      hasBrowserOriginHeader: params.hasBrowserOriginHeader,
      sharedAuthOk: params.sharedAuthOk,
      authMethod: params.authMethod,
    })
  ) {
    return "cli_container_local";
  }
  if (
    isSharedSecretLoopbackLocalEquivalent({
      requestHost: params.requestHost,
      remoteAddress: params.remoteAddress,
      hasProxyHeaders: params.hasProxyHeaders,
      hasBrowserOriginHeader: params.hasBrowserOriginHeader,
      sharedAuthOk: params.sharedAuthOk,
      authMethod: params.authMethod,
    })
  ) {
    return "shared_secret_loopback_local";
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
  if (!isBackendClient) {
    return false;
  }
  const usesSharedSecretAuth = params.authMethod === "token" || params.authMethod === "password";
  const usesDeviceTokenAuth = params.authMethod === "device-token";
  return (
    (params.locality === "direct_local" || params.locality === "shared_secret_loopback_local") &&
    !params.hasBrowserOriginHeader &&
    ((params.sharedAuthOk && usesSharedSecretAuth) || usesDeviceTokenAuth)
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

export function resolveAuthProvidedKind(
  connectAuth: HandshakeConnectAuth | null | undefined,
): AuthProvidedKind {
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
  connectAuth: HandshakeConnectAuth | null | undefined;
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
