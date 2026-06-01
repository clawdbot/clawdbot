import type { IncomingMessage } from "node:http";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "../../auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  authorizeWsControlUiGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "../../auth.js";
import { withSerializedRateLimitAttempt } from "../../rate-limit-attempt-serialization.js";

type HandshakeConnectAuth = {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
  password?: string;
  approvalRuntimeToken?: string;
};

export type DeviceTokenCandidateSource = "explicit-device-token" | "shared-token-fallback";

export type ConnectAuthState = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  sharedAuthOk: boolean;
  sharedAuthProvided: boolean;
  bootstrapTokenCandidate?: string;
  deviceTokenCandidate?: string;
  deviceTokenCandidateSource?: DeviceTokenCandidateSource;
};

type SharedGatewayAuthDeviceTokenIssuer = {
  kind: "shared-gateway-auth";
  generation: string;
};

type VerifyDeviceTokenResult = {
  ok: boolean;
  reason?: string;
  issuer?: SharedGatewayAuthDeviceTokenIssuer;
};
type VerifyBootstrapTokenResult = { ok: boolean; reason?: string };

export type ConnectAuthDecision = {
  authResult: GatewayAuthResult;
  authOk: boolean;
  authMethod: GatewayAuthResult["method"];
  deviceTokenSharedGatewaySessionGeneration?: string;
};

type ResolveConnectAuthDecisionParams = {
  state: ConnectAuthState;
  hasDeviceIdentity: boolean;
  deviceId?: string;
  publicKey?: string;
  role: string;
  scopes: string[];
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
  verifyBootstrapToken: (params: {
    deviceId: string;
    publicKey: string;
    token: string;
    role: string;
    scopes: string[];
  }) => Promise<VerifyBootstrapTokenResult>;
  verifyDeviceToken: (params: {
    deviceId: string;
    token: string;
    role: string;
    scopes: string[];
  }) => Promise<VerifyDeviceTokenResult>;
};

function mapDeviceTokenAuthFailureReason(params: {
  tokenCheckReason?: string;
  candidateSource?: DeviceTokenCandidateSource;
  fallbackReason?: string;
}): string {
  if (
    params.tokenCheckReason === "scope-mismatch" ||
    params.tokenCheckReason === "scope_mismatch"
  ) {
    return "scope_mismatch";
  }
  if (params.candidateSource === "explicit-device-token") {
    return "device_token_mismatch";
  }
  return params.fallbackReason ?? "device_token_mismatch";
}

function resolveSharedConnectAuth(
  connectAuth: HandshakeConnectAuth | null | undefined,
): { token?: string; password?: string } | undefined {
  const token = normalizeOptionalString(connectAuth?.token);
  const password = normalizeOptionalString(connectAuth?.password);
  if (!token && !password) {
    return undefined;
  }
  return { token, password };
}

function resolveDeviceTokenCandidate(connectAuth: HandshakeConnectAuth | null | undefined): {
  token?: string;
  source?: DeviceTokenCandidateSource;
} {
  const explicitDeviceToken = normalizeOptionalString(connectAuth?.deviceToken);
  if (explicitDeviceToken) {
    return { token: explicitDeviceToken, source: "explicit-device-token" };
  }
  const fallbackToken = normalizeOptionalString(connectAuth?.token);
  if (!fallbackToken) {
    return {};
  }
  return { token: fallbackToken, source: "shared-token-fallback" };
}

export async function resolveConnectAuthState(params: {
  resolvedAuth: ResolvedGatewayAuth;
  connectAuth: HandshakeConnectAuth | null | undefined;
  hasDeviceIdentity: boolean;
  req: IncomingMessage;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
  clientIp?: string;
}): Promise<ConnectAuthState> {
  const sharedConnectAuth = resolveSharedConnectAuth(params.connectAuth);
  const sharedAuthProvided = Boolean(sharedConnectAuth);
  const bootstrapTokenCandidate = params.hasDeviceIdentity
    ? normalizeOptionalString(params.connectAuth?.bootstrapToken)
    : undefined;
  const { token: deviceTokenCandidate, source: deviceTokenCandidateSource } =
    params.hasDeviceIdentity ? resolveDeviceTokenCandidate(params.connectAuth) : {};

  const authResult: GatewayAuthResult = await authorizeWsControlUiGatewayConnect({
    auth: params.resolvedAuth,
    connectAuth: sharedConnectAuth,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: sharedAuthProvided ? params.rateLimiter : undefined,
    clientIp: params.clientIp,
    rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  });

  const sharedAuthResult =
    sharedConnectAuth &&
    (await authorizeHttpGatewayConnect({
      auth: { ...params.resolvedAuth, allowTailscale: false },
      connectAuth: sharedConnectAuth,
      req: params.req,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      // Shared-auth probe only; rate-limit side effects are handled in the
      // primary auth flow (or deferred for device-token candidates).
      rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    }));
  // Trusted-proxy auth is semantically shared: the proxy vouches for identity,
  // no per-device credential needed. Include it so operator connections
  // can skip device identity via roleCanSkipDeviceIdentity().
  const sharedAuthOk =
    (sharedAuthResult?.ok === true &&
      (sharedAuthResult.method === "token" || sharedAuthResult.method === "password")) ||
    (authResult.ok && authResult.method === "trusted-proxy");

  return {
    authResult,
    authOk: authResult.ok,
    authMethod:
      authResult.method ?? (params.resolvedAuth.mode === "password" ? "password" : "token"),
    sharedAuthOk,
    sharedAuthProvided,
    bootstrapTokenCandidate,
    deviceTokenCandidate,
    deviceTokenCandidateSource,
  };
}

export async function resolveConnectAuthDecision(
  params: ResolveConnectAuthDecisionParams,
): Promise<ConnectAuthDecision> {
  const shouldSerializeBootstrapAttempt = Boolean(
    params.rateLimiter &&
    params.hasDeviceIdentity &&
    params.deviceId &&
    params.publicKey &&
    params.state.bootstrapTokenCandidate,
  );
  if (!shouldSerializeBootstrapAttempt) {
    return await resolveConnectAuthDecisionCore(params);
  }
  return await withSerializedRateLimitAttempt({
    ip: params.clientIp,
    scope: AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
    run: async () => await resolveConnectAuthDecisionCore(params),
  });
}

async function resolveConnectAuthDecisionCore(
  params: ResolveConnectAuthDecisionParams,
): Promise<ConnectAuthDecision> {
  let authResult = params.state.authResult;
  let authOk = params.state.authOk;
  let authMethod = params.state.authMethod;
  let deviceTokenSharedGatewaySessionGeneration: string | undefined;
  let pendingBootstrapFailure = false;

  function finish(): ConnectAuthDecision {
    if (pendingBootstrapFailure && !authOk) {
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN);
    }
    return {
      authResult,
      authOk,
      authMethod,
      deviceTokenSharedGatewaySessionGeneration,
    };
  }

  const bootstrapTokenCandidate = params.state.bootstrapTokenCandidate;
  if (params.hasDeviceIdentity && params.deviceId && params.publicKey && bootstrapTokenCandidate) {
    // Per-IP gate on the bootstrap-token verify path.
    // verifyDeviceBootstrapToken is mutex-serialized and runs fs read + fs
    // write per attempt, so unrate-limited attackers can queue the bootstrap
    // pairing flow behind their requests and block legitimate onboarding.
    let bootstrapRateLimited = false;
    if (params.rateLimiter) {
      const bootstrapRateCheck = params.rateLimiter.check(
        params.clientIp,
        AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN,
      );
      if (!bootstrapRateCheck.allowed) {
        bootstrapRateLimited = true;
        if (!authOk) {
          authResult = {
            ok: false,
            reason: "rate_limited",
            rateLimited: true,
            retryAfterMs: bootstrapRateCheck.retryAfterMs,
          };
        }
      }
    }
    if (!bootstrapRateLimited) {
      const tokenCheck = await params.verifyBootstrapToken({
        deviceId: params.deviceId,
        publicKey: params.publicKey,
        token: bootstrapTokenCandidate,
        role: params.role,
        scopes: params.scopes,
      });
      if (tokenCheck.ok) {
        // Prefer an explicit valid bootstrap token even when another auth path
        // (for example tailscale serve header auth) already succeeded. QR pairing
        // relies on the server classifying the handshake as bootstrap-token so the
        // initial node pairing can be silently auto-approved and the bootstrap
        // token can be revoked after approval.
        authOk = true;
        authMethod = "bootstrap-token";
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_BOOTSTRAP_TOKEN);
      } else {
        pendingBootstrapFailure = true;
        if (!authOk) {
          authResult = { ok: false, reason: tokenCheck.reason ?? "bootstrap_token_invalid" };
        }
      }
    }
  }

  const deviceTokenCandidate = params.state.deviceTokenCandidate;
  if (!params.hasDeviceIdentity || !params.deviceId || authOk || !deviceTokenCandidate) {
    return finish();
  }

  let deviceTokenRateLimited = false;
  if (params.rateLimiter) {
    const deviceRateCheck = params.rateLimiter.check(
      params.clientIp,
      AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
    );
    if (!deviceRateCheck.allowed) {
      deviceTokenRateLimited = true;
      authResult = {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: deviceRateCheck.retryAfterMs,
      };
    }
  }
  if (!deviceTokenRateLimited) {
    const tokenCheck = await params.verifyDeviceToken({
      deviceId: params.deviceId,
      token: deviceTokenCandidate,
      role: params.role,
      scopes: params.scopes,
    });
    if (tokenCheck.ok) {
      authOk = true;
      authMethod = "device-token";
      if (tokenCheck.issuer?.kind === "shared-gateway-auth") {
        deviceTokenSharedGatewaySessionGeneration = tokenCheck.issuer.generation;
      }
      params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
      if (params.state.sharedAuthProvided) {
        params.rateLimiter?.reset(params.clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
      }
    } else {
      authResult = {
        ok: false,
        reason: mapDeviceTokenAuthFailureReason({
          tokenCheckReason: tokenCheck.reason,
          candidateSource: params.state.deviceTokenCandidateSource,
          fallbackReason: authResult.reason,
        }),
      };
      params.rateLimiter?.recordFailure(params.clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    }
  }

  return finish();
}
