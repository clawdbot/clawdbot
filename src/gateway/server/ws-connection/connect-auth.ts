// Gateway WebSocket connect authentication validates protocol, origin, credentials, and device proof.
import {
  ConnectErrorDetailCodes,
  resolveAuthConnectErrorDetailCode,
} from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { ErrorCodes } from "../../../../packages/gateway-protocol/src/index.js";
import {
  getDeviceBootstrapTokenProfile,
  verifyDeviceBootstrapToken,
} from "../../../infra/device-bootstrap.js";
import { verifyDeviceToken } from "../../../infra/device-pairing.js";
import type { DeviceBootstrapProfile } from "../../../shared/device-bootstrap-profile.js";
import type { GatewayAuthResult } from "../../auth.js";
import { formatForLog } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import { resolveSharedGatewaySessionGeneration } from "../ws-shared-generation.js";
import { resolveConnectAuthDecision, resolveConnectAuthState } from "./auth-context.js";
import { formatGatewayAuthFailureMessage } from "./auth-messages.js";
import { admitGatewayConnect, resolveTrustedProxyControlUiScopes } from "./connect-admission.js";
import { emitGatewayAuthSecurityEvent } from "./connect-auth-security.js";
import { verifyGatewayConnectDeviceProof } from "./connect-device-proof.js";
import {
  evaluateMissingDeviceIdentity,
  isTrustedProxyControlUiOperatorAuth,
  resolveControlUiAuthPolicy,
  shouldClearUnboundScopesForMissingDeviceIdentity,
  shouldSkipControlUiPairing,
} from "./connect-policy.js";
import {
  resolvePairingLocality,
  resolveUnauthorizedHandshakeContext,
  shouldPreserveLocalCliSharedAuthScopes,
  shouldSkipLocalBackendSelfPairing,
} from "./handshake-auth-helpers.js";
import {
  buildHandshakeAuthLogKey,
  HandshakeAuthLogLimiter,
  shouldLimitMissingCredentialAuthLog,
} from "./handshake-auth-log-limiter.js";
import type {
  AuthenticatedGatewayConnect,
  GatewayConnectPhaseContext,
} from "./message-handler-types.js";

const unauthorizedHandshakeLogLimiter = new HandshakeAuthLogLimiter();

export async function authenticateGatewayConnect(
  context: GatewayConnectPhaseContext,
): Promise<AuthenticatedGatewayConnect | undefined> {
  const {
    upgradeReq,
    connId,
    remoteAddr,
    remotePort,
    localAddr,
    localPort,
    requestHost,
    requestOrigin,
    requestUserAgent,
    getResolvedAuth,
    getRequiredSharedGatewaySessionGeneration,
    advanceHandshakePhase,
    setCloseCause,
    close,
    logWsControl,
  } = context.handler;
  const {
    connectParams,
    configSnapshot,
    trustedProxies,
    allowRealIpFallback,
    peerLabel,
    hasProxyHeaders,
    isLocalClient,
    hasBrowserOriginHeader,
    browserRateLimitClientIp,
    authRateLimiter,
    clientLabel,
    markHandshakeFailure,
    sendHandshakeErrorResponse,
  } = context;
  const resolvedAuth = getResolvedAuth();
  const admission = await admitGatewayConnect(context);
  if (!admission) {
    return undefined;
  }
  let { scopes } = admission;
  const {
    minProtocol,
    maxProtocol,
    usesLegacyNodeProtocol,
    role,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
  } = admission;

  const deviceRaw = connectParams.device;
  const hasTokenAuth = Boolean(connectParams.auth?.token);
  const hasPasswordAuth = Boolean(connectParams.auth?.password);
  const hasSharedAuth = hasTokenAuth || hasPasswordAuth;
  const controlUiAuthPolicy = resolveControlUiAuthPolicy({
    isControlUi,
    controlUiConfig: configSnapshot.gateway?.controlUi,
    deviceRaw,
  });
  const device = controlUiAuthPolicy.device;
  const hasBootstrapProof = Boolean(connectParams.auth?.bootstrapToken);
  const hasDeviceTokenProof = Boolean(connectParams.auth?.deviceToken);
  const hasRawHandshakeCredentials =
    hasSharedAuth || hasBootstrapProof || hasDeviceTokenProof || Boolean(device);
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
      ...(failedAuth.rateLimited === true
        ? {
            retryable: true,
            ...(failedAuth.retryAfterMs !== undefined
              ? { retryAfterMs: failedAuth.retryAfterMs }
              : {}),
          }
        : {}),
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
    return undefined;
  }
  const deviceProof = verifyGatewayConnectDeviceProof(context, {
    device,
    resolvedAuth,
    authMethod,
    role,
    scopes,
  });
  if (!deviceProof.ok) {
    return undefined;
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
    async verifyBootstrapToken({
      deviceId,
      publicKey,
      token,
      role: roleLocal,
      scopes: scopesLocal,
    }) {
      return await verifyDeviceBootstrapToken({
        deviceId,
        publicKey,
        token,
        role: roleLocal,
        scopes: scopesLocal,
      });
    },
    async verifyDeviceToken(paramsLocal) {
      return await verifyDeviceToken({
        ...paramsLocal,
        requiredSharedGatewaySessionGeneration: getRequiredSharedGatewaySessionGeneration?.(),
      });
    },
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
    return undefined;
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
    const requiredSharedGatewaySessionGeneration = getRequiredSharedGatewaySessionGeneration?.();
    if (
      requiredSharedGatewaySessionGeneration !== undefined &&
      sessionSharedGatewaySessionGeneration !== requiredSharedGatewaySessionGeneration
    ) {
      setCloseCause("gateway-auth-rotated", {
        authGenerationStale: true,
      });
      close(4001, "gateway auth changed");
      return undefined;
    }
  }
  const issuedBootstrapProfile =
    authMethod === "bootstrap-token" && bootstrapTokenCandidate
      ? await getDeviceBootstrapTokenProfile({ token: bootstrapTokenCandidate })
      : null;
  const handoffBootstrapProfile: DeviceBootstrapProfile | null = null;
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

  return {
    resolvedAuth,
    minProtocol,
    maxProtocol,
    usesLegacyNodeProtocol,
    role,
    scopes,
    isControlUi,
    isBrowserOperatorUi,
    isWebchat,
    isNativeAppUi,
    controlUiAuthPolicy,
    device,
    devicePublicKey: deviceProof.devicePublicKey,
    deviceAuthPayloadVersion: deviceProof.deviceAuthPayloadVersion,
    hasTokenAuth,
    hasPasswordAuth,
    bootstrapTokenCandidate,
    deviceTokenSharedGatewaySessionGeneration,
    authResult,
    authOk,
    authMethod,
    pairingLocality,
    usesSharedGatewayAuth,
    sessionUsesSharedGatewayAuth,
    sessionSharedGatewaySessionGeneration,
    issuedBootstrapProfile,
    handoffBootstrapProfile,
    trustedProxyAuthOk,
    skipControlUiPairingForDevice,
    skipLocalBackendSelfPairing,
    rejectUnauthorized,
  };
}
