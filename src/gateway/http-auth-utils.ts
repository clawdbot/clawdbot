// Gateway HTTP auth helpers.
// Authenticates HTTP endpoints and derives trusted operator scopes.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { GatewayOperatorRoleDefinition } from "../config/types.gateway.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { verifyDeviceToken } from "../infra/device-pairing-tokens.js";
import { listDevicePairing } from "../infra/device-pairing.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import { roleScopesAllow } from "../shared/operator-scope-compat.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
} from "./auth-rate-limit.js";
import {
  authorizeControlUiReadHttpGatewayConnect,
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import type { ControlUiPluginFrameGrantAck } from "./control-ui-contract.js";
import {
  resolveControlUiPluginAuthCookieGrants,
  setControlUiPluginAuthCookie,
} from "./control-ui-plugin-auth-cookie.js";
import {
  listControlUiPluginTabAuthGrants,
  type ControlUiPluginTabAuthGrant,
} from "./control-ui-plugin-tabs.js";
import {
  resolveAuthenticatedHttpUserProfile,
  resolveHttpProfile,
  usesSharedSecretGatewayMethod,
} from "./http-auth-user-profile.js";
import { sendGatewayAuthFailure, sendJson, sendMissingScopeForbidden } from "./http-common.js";
import {
  prepareGatewayIngressAttribution,
  PROXY_ATTRIBUTION_REQUIRED_REASON,
} from "./ingress-attribution.js";
import {
  ADMIN_SCOPE,
  CLI_DEFAULT_OPERATOR_SCOPES,
  authorizeOperatorScopesForMethod,
} from "./method-scopes.js";
import { resolveBrowserOriginPolicy } from "./origin-check.js";
import { withSerializedCredentialFallbackAttempt } from "./rate-limit-attempt-serialization.js";
import type { GatewayClient } from "./server-methods/shared-types.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read";
const CONTROL_UI_OPERATOR_ROLE = "operator";

export function getHeader(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[normalizeLowercaseStringOrEmpty(name)];
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw[0];
  }
  return undefined;
}

export function getBearerToken(req: IncomingMessage): string | undefined {
  // Bearer parsing is intentionally minimal: callers pass the extracted token
  // into the shared gateway auth verifier for constant-time comparison.
  const raw = normalizeOptionalString(getHeader(req, "authorization")) ?? "";
  if (!normalizeLowercaseStringOrEmpty(raw).startsWith("bearer ")) {
    return undefined;
  }
  return normalizeOptionalString(raw.slice(7));
}

type SharedSecretGatewayAuth = Pick<ResolvedGatewayAuth, "mode">;
export type AuthorizedGatewayHttpRequest = {
  authMethod?: GatewayAuthResult["method"];
  user?: string;
  trustDeclaredOperatorScopes: boolean;
  authenticatedUserProfile?: GatewayClient["authenticatedUserProfile"];
  operatorRolePolicy?: GatewayOperatorRoleDefinition;
  operatorRoleActor?: { kind: "system" };
  controlUiPluginGrants?: ControlUiPluginTabAuthGrant[];
  controlUiPluginGrant?: ControlUiPluginTabAuthGrant;
};
type AuthenticatedHttpUserProfile = Pick<
  AuthorizedGatewayHttpRequest,
  "authenticatedUserProfile" | "operatorRolePolicy"
>;

export type GatewayHttpRequestAuthCheckResult =
  | {
      ok: true;
      requestAuth: AuthorizedGatewayHttpRequest;
    }
  | {
      ok: false;
      authResult: GatewayAuthResult;
    };

type GatewayHttpRequestAuthParams = {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

type GatewayHttpRequestAuthCheckParams = Omit<GatewayHttpRequestAuthParams, "res"> & {
  cfg?: OpenClawConfig;
};

type GatewayHttpConnectAuthorizer = (
  params: Parameters<typeof authorizeHttpGatewayConnect>[0],
) => Promise<GatewayAuthResult>;

export type AuthorizedControlUiReadRequest = AuthenticatedHttpUserProfile & {
  authMethod: NonNullable<GatewayAuthResult["method"]>;
  operatorScopes: string[];
};

type ControlUiReadAuthParams = Omit<GatewayHttpRequestAuthParams, "auth"> & {
  auth?: ResolvedGatewayAuth;
  allowQueryToken?: boolean;
  requiredOperatorMethod?: string;
  onPluginFrameGrants?: (grants: readonly ControlUiPluginFrameGrantAck[]) => void;
};

export function resolveHttpBrowserOriginPolicy(
  req: IncomingMessage,
  cfg = getRuntimeConfig(),
): NonNullable<Parameters<typeof authorizeHttpGatewayConnect>[0]["browserOriginPolicy"]> {
  return resolveBrowserOriginPolicy({ req, cfg });
}

function usesSharedSecretHttpAuth(auth: SharedSecretGatewayAuth | undefined): boolean {
  return auth?.mode === "token" || auth?.mode === "password";
}

export function applyHttpOperatorRoleScopeCeiling<Scope extends string>(
  scopes: Scope[],
  auth: Pick<AuthorizedGatewayHttpRequest, "operatorRolePolicy"> | undefined,
): Scope[] {
  const allowedScopes = auth?.operatorRolePolicy?.scopes;
  return allowedScopes
    ? scopes.filter((scope) =>
        roleScopesAllow({ role: "operator", requestedScopes: [scope], allowedScopes }),
      )
    : scopes;
}

function shouldTrustDeclaredHttpOperatorScopes(
  req: IncomingMessage,
  authOrRequest:
    | SharedSecretGatewayAuth
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">
    | undefined,
): boolean {
  if (authOrRequest && "trustDeclaredOperatorScopes" in authOrRequest) {
    return authOrRequest.trustDeclaredOperatorScopes;
  }
  return !isGatewayBearerHttpRequest(req, authOrRequest);
}

function resolveControlUiReadAuthToken(
  req: IncomingMessage,
  allowQueryToken: boolean | undefined,
): string | undefined {
  const bearer = getBearerToken(req);
  if (bearer || !allowQueryToken || !req.url) {
    return bearer;
  }
  try {
    return normalizeOptionalString(new URL(req.url, "http://localhost").searchParams.get("token"));
  } catch {
    return undefined;
  }
}

async function verifyControlUiDeviceReadToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
): Promise<string[] | null> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorToken = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (
      !operatorToken ||
      operatorToken.revokedAtMs ||
      !verifyPairingToken(token, operatorToken.token)
    ) {
      continue;
    }
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: CONTROL_UI_OPERATOR_ROLE,
      scopes: [CONTROL_UI_OPERATOR_READ_SCOPE],
      requiredSharedGatewaySessionGeneration,
    });
    return verified.ok ? [...operatorToken.scopes] : null;
  }
  return null;
}

function resolveControlUiReadOperatorScopes(
  req: IncomingMessage,
  authMethod: NonNullable<GatewayAuthResult["method"]>,
  deviceScopes: string[] | undefined,
  authenticatedRequest?: Pick<AuthorizedGatewayHttpRequest, "operatorRolePolicy">,
): string[] {
  if (authMethod === "device-token") {
    return applyHttpOperatorRoleScopeCeiling(deviceScopes ?? [], authenticatedRequest);
  }
  if (authMethod === "trusted-proxy" || authMethod === "tailscale") {
    return resolveTrustedHttpOperatorScopes(req, {
      trustDeclaredOperatorScopes: true,
      ...authenticatedRequest,
    });
  }
  return authMethod === "bootstrap-token" ? [] : [...CLI_DEFAULT_OPERATOR_SCOPES];
}

/** Authorize a read-only same-origin Control UI request, including paired devices. */
export async function authorizeControlUiReadRequestOrReply(
  params: ControlUiReadAuthParams,
): Promise<AuthorizedControlUiReadRequest | null> {
  const auth = params.auth;
  if (!auth) {
    params.onPluginFrameGrants?.([]);
    return { authMethod: "none", operatorScopes: [...CLI_DEFAULT_OPERATOR_SCOPES] };
  }

  const token = resolveControlUiReadAuthToken(params.req, params.allowQueryToken);
  const ingressAttribution = prepareGatewayIngressAttribution({
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
  });
  if (ingressAttribution.kind === "unattributable-proxy") {
    sendGatewayAuthFailure(params.res, { ok: false, reason: ingressAttribution.reason });
    return null;
  }
  const clientIp = ingressAttribution.rateLimit.subject.key;
  const canUseDeviceTokenFallback =
    Boolean(token) && auth.mode !== "trusted-proxy" && auth.mode !== "none";
  const run = async (): Promise<AuthorizedControlUiReadRequest | null> => {
    const authResult = await authorizeControlUiReadHttpGatewayConnect({
      auth,
      connectAuth: token ? { token, password: token } : null,
      req: params.req,
      browserOriginPolicy: resolveHttpBrowserOriginPolicy(params.req),
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
      rateLimiter: token ? params.rateLimiter : undefined,
      clientIp,
      rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
      deferRateLimitFailure: canUseDeviceTokenFallback,
    });
    const authGeneration = resolveSharedGatewaySessionGeneration(auth, params.trustedProxies);
    let resolvedAuthResult = authResult;
    let deviceScopes: string[] | undefined;
    if (
      !authResult.ok &&
      authResult.reason !== PROXY_ATTRIBUTION_REQUIRED_REASON &&
      canUseDeviceTokenFallback &&
      token
    ) {
      const recordSharedSecretFailure = async () => {
        if (authResult.reason === "token_mismatch" || authResult.reason === "password_mismatch") {
          await params.rateLimiter?.recordFailureAndDelay(
            clientIp,
            AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
          );
        }
      };
      const deviceRateCheck = params.rateLimiter?.check(
        clientIp,
        AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
      );
      if (deviceRateCheck && !deviceRateCheck.allowed) {
        await recordSharedSecretFailure();
        resolvedAuthResult = {
          ok: false,
          reason: "rate_limited",
          rateLimited: true,
          retryAfterMs: deviceRateCheck.retryAfterMs,
        };
      } else {
        const verifiedScopes = await verifyControlUiDeviceReadToken(token, authGeneration);
        if (verifiedScopes) {
          deviceScopes = verifiedScopes;
          params.rateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
          resolvedAuthResult = { ok: true, method: "device-token" };
        } else {
          await recordSharedSecretFailure();
          await params.rateLimiter?.recordFailureAndDelay(
            clientIp,
            AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
          );
        }
      }
    }
    if (!resolvedAuthResult.ok) {
      sendGatewayAuthFailure(params.res, resolvedAuthResult);
      return null;
    }

    const cfg = getRuntimeConfig();
    let authenticatedProfile;
    try {
      authenticatedProfile = await resolveAuthenticatedHttpUserProfile({
        authResult: resolvedAuthResult,
        cfg,
        req: params.req,
      });
    } catch {
      sendGatewayAuthFailure(params.res, { ok: false, reason: "user_profile_unavailable" });
      return null;
    }
    const authMethod = resolvedAuthResult.method ?? "none";
    const trustDeclaredOperatorScopes =
      authMethod === "trusted-proxy" || authMethod === "tailscale";
    const operatorScopes = resolveControlUiReadOperatorScopes(
      params.req,
      authMethod,
      deviceScopes,
      authenticatedProfile,
    );
    params.onPluginFrameGrants?.(
      setControlUiPluginAuthCookieForRequest(
        params.req,
        params.res,
        authMethod,
        trustDeclaredOperatorScopes,
        authGeneration,
        operatorScopes,
        authenticatedProfile.authenticatedUserProfile?.profileId,
      ),
    );
    const scopeAuth = authorizeOperatorScopesForMethod(
      params.requiredOperatorMethod ?? "assistant.media.get",
      operatorScopes,
    );
    if (!scopeAuth.allowed) {
      sendMissingScopeForbidden(params.res, scopeAuth.missingScope);
      return null;
    }
    return { authMethod, operatorScopes, ...authenticatedProfile };
  };

  if (!canUseDeviceTokenFallback || !params.rateLimiter) {
    return await run();
  }
  // Shared and device credentials form one terminal auth attempt. Keep their
  // async checks together so concurrent fallbacks cannot outrun either bucket.
  return await withSerializedCredentialFallbackAttempt({
    limiter: params.rateLimiter,
    ip: clientIp,
    run,
  });
}

/**
 * Session byte routes cannot apply the client-specific `sessions.list` filter.
 * Require its read scope plus admin, whose owner view is not narrowed by that filter.
 */
export async function authorizeControlUiSessionOwnerReadRequestOrReply(
  params: Omit<ControlUiReadAuthParams, "allowQueryToken" | "requiredOperatorMethod">,
): Promise<AuthorizedControlUiReadRequest | null> {
  const requestAuth = await authorizeControlUiReadRequestOrReply({
    ...params,
    requiredOperatorMethod: "sessions.list",
  });
  if (!requestAuth || requestAuth.operatorScopes.includes(ADMIN_SCOPE)) {
    return requestAuth;
  }
  sendJson(params.res, 403, {
    ok: false,
    error: { message: "owner access required", type: "forbidden" },
  });
  return null;
}

export async function authorizeGatewayHttpRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<AuthorizedGatewayHttpRequest | null> {
  return await authorizeGatewayHttpRequestWithOrReply(params, authorizeHttpGatewayConnect);
}

async function authorizeGatewayHttpRequestWithOrReply(
  params: GatewayHttpRequestAuthParams,
  authorizeConnect: GatewayHttpConnectAuthorizer,
): Promise<AuthorizedGatewayHttpRequest | null> {
  const result = await checkGatewayHttpRequestAuthWith(params, authorizeConnect);
  if (!result.ok) {
    sendGatewayAuthFailure(params.res, result.authResult);
    return null;
  }
  return result.requestAuth;
}

export function setControlUiPluginAuthCookieForRequest(
  req: IncomingMessage,
  res: ServerResponse,
  authMethod: GatewayAuthResult["method"],
  trustDeclaredOperatorScopes: boolean,
  authGeneration: string | undefined,
  authenticatedScopes?: readonly string[],
  authenticatedProfileId?: string,
): ControlUiPluginTabAuthGrant[] {
  const scopes =
    authenticatedScopes ??
    (usesSharedSecretGatewayMethod(authMethod)
      ? [...CLI_DEFAULT_OPERATOR_SCOPES]
      : authMethod === "trusted-proxy" || authMethod === "tailscale"
        ? resolveTrustedHttpOperatorScopes(req, {
            trustDeclaredOperatorScopes,
          })
        : []);
  const grants = listControlUiPluginTabAuthGrants(scopes);
  if (grants.length > 0) {
    return setControlUiPluginAuthCookie(res, grants, {
      generation: authGeneration,
      ...(authenticatedProfileId ? { profileId: authenticatedProfileId } : {}),
    });
  }
  return [];
}

export function authorizeControlUiPluginCookieRequest(
  req: IncomingMessage,
  params: { requestPath: string; authGeneration: string | undefined },
): {
  requestAuth: AuthorizedGatewayHttpRequest;
  operatorScopes: string[];
} | null {
  // WebSocket upgrades bypass this HTTP-only handoff and use
  // checkGatewayHttpRequestAuth directly in attachGatewayUpgradeHandler.
  if (req.method !== "GET" && req.method !== "HEAD") {
    return null;
  }
  // Native plugins and the UI they serve share the Gateway's trusted in-process
  // boundary. Cross-site sandbox descendants need an ambient cookie, so this
  // handoff is read-only; mutations stay on explicit Gateway auth surfaces.
  const grants = resolveControlUiPluginAuthCookieGrants(req, {
    requestPath: params.requestPath,
    generation: params.authGeneration,
  });
  if (grants.length === 0) {
    return null;
  }
  const cfg = getRuntimeConfig();
  let authenticatedProfile: AuthenticatedHttpUserProfile = {};
  if (cfg.gateway?.roles) {
    const profileId = grants[0]?.profileId;
    if (!profileId || grants.some((grant) => grant.profileId !== profileId)) {
      return null;
    }
    try {
      const profile = getUserProfileListItem(profileId);
      authenticatedProfile = resolveHttpProfile(profile.id, profile.updatedAt, cfg);
    } catch {
      return null;
    }
  }
  for (const grant of grants) {
    grant.scopes = applyHttpOperatorRoleScopeCeiling(grant.scopes, authenticatedProfile);
  }
  return {
    requestAuth: {
      trustDeclaredOperatorScopes: false,
      controlUiPluginGrants: grants,
      ...authenticatedProfile,
    },
    // Route dispatch selects the candidate that owns the first matched gateway
    // route. Do not union scopes before that owner boundary is known.
    operatorScopes: [],
  };
}

export async function authorizePluginGatewayHttpRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  requestPath: string;
  resolveOperatorScopes: (
    req: IncomingMessage,
    requestAuth: AuthorizedGatewayHttpRequest,
  ) => string[];
}): Promise<{
  requestAuth: AuthorizedGatewayHttpRequest;
  operatorScopes: string[];
} | null> {
  const authGeneration = resolveSharedGatewaySessionGeneration(params.auth, params.trustedProxies);
  const cookieAuth = authorizeControlUiPluginCookieRequest(params.req, {
    requestPath: params.requestPath,
    authGeneration,
  });
  if (cookieAuth) {
    return cookieAuth;
  }
  const requestAuth = await authorizeGatewayHttpRequestOrReply(params);
  return requestAuth
    ? { requestAuth, operatorScopes: params.resolveOperatorScopes(params.req, requestAuth) }
    : null;
}

export async function checkGatewayHttpRequestAuth(params: {
  req: IncomingMessage;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  cfg?: OpenClawConfig;
}): Promise<GatewayHttpRequestAuthCheckResult> {
  return await checkGatewayHttpRequestAuthWith(params, authorizeHttpGatewayConnect);
}

async function checkGatewayHttpRequestAuthWith(
  params: GatewayHttpRequestAuthCheckParams,
  authorizeConnect: GatewayHttpConnectAuthorizer,
): Promise<GatewayHttpRequestAuthCheckResult> {
  const token = getBearerToken(params.req);
  const browserOriginPolicy = resolveHttpBrowserOriginPolicy(params.req, params.cfg);
  const authResult = await authorizeConnect({
    auth: params.auth,
    connectAuth: token ? { token, password: token } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
    browserOriginPolicy,
  });
  if (!authResult.ok) {
    return { ok: false, authResult };
  }
  let authenticatedProfile;
  try {
    authenticatedProfile = await resolveAuthenticatedHttpUserProfile({
      authResult,
      cfg: params.cfg ?? getRuntimeConfig(),
      req: params.req,
    });
  } catch {
    return { ok: false, authResult: { ok: false, reason: "user_profile_unavailable" } };
  }
  return {
    ok: true,
    requestAuth: {
      authMethod: authResult.method,
      ...(authResult.user ? { user: authResult.user } : {}),
      // Shared-secret bearer auth proves possession of the gateway secret, but it
      // does not prove a narrower per-request operator identity. HTTP endpoints
      // must opt in explicitly if they want to treat that shared-secret path as a
      // full trusted-operator surface.
      trustDeclaredOperatorScopes: !usesSharedSecretGatewayMethod(authResult.method),
      // Shared-secret authority belongs to authentication, independently of profile attribution.
      ...(usesSharedSecretGatewayMethod(authResult.method)
        ? { operatorRoleActor: { kind: "system" as const } }
        : {}),
      ...authenticatedProfile,
    },
  };
}

export async function authorizeScopedGatewayHttpRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
  operatorMethod: string;
  resolveOperatorScopes: (
    req: IncomingMessage,
    requestAuth: AuthorizedGatewayHttpRequest,
  ) => string[];
}): Promise<{
  cfg: OpenClawConfig;
  requestAuth: AuthorizedGatewayHttpRequest;
  operatorScopes: string[];
} | null> {
  return await authorizeScopedGatewayHttpRequestWithOrReply(params, authorizeHttpGatewayConnect);
}

async function authorizeScopedGatewayHttpRequestWithOrReply(
  params: Parameters<typeof authorizeScopedGatewayHttpRequestOrReply>[0],
  authorizeConnect: GatewayHttpConnectAuthorizer,
): ReturnType<typeof authorizeScopedGatewayHttpRequestOrReply> {
  const cfg = getRuntimeConfig();
  const requestAuth = await authorizeGatewayHttpRequestWithOrReply(
    {
      req: params.req,
      res: params.res,
      auth: params.auth,
      trustedProxies: params.trustedProxies ?? cfg.gateway?.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
      rateLimiter: params.rateLimiter,
    },
    authorizeConnect,
  );
  if (!requestAuth) {
    return null;
  }

  const operatorScopes = params.resolveOperatorScopes(params.req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod(params.operatorMethod, operatorScopes);
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(params.res, scopeAuth.missingScope);
    return null;
  }

  return { cfg, requestAuth, operatorScopes };
}

export function isGatewayBearerHttpRequest(
  req: IncomingMessage,
  auth?: SharedSecretGatewayAuth,
): boolean {
  return usesSharedSecretHttpAuth(auth) && Boolean(getBearerToken(req));
}

export function resolveTrustedHttpOperatorScopes(
  req: IncomingMessage,
  authOrRequest?:
    | SharedSecretGatewayAuth
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes" | "operatorRolePolicy">,
): string[] {
  if (!shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest)) {
    // Gateway bearer auth only proves possession of the shared secret. Do not
    // let HTTP clients self-assert operator scopes through request headers.
    return [];
  }

  const headerValue = getHeader(req, "x-openclaw-scopes");
  // Missing headers preserve trusted-client defaults; present empty headers grant nothing.
  const scopes =
    headerValue === undefined
      ? [...CLI_DEFAULT_OPERATOR_SCOPES]
      : headerValue
          .split(",")
          .map((scope) => scope.trim())
          .filter((scope) => scope.length > 0);
  return applyHttpOperatorRoleScopeCeiling(
    scopes,
    authOrRequest && "trustDeclaredOperatorScopes" in authOrRequest ? authOrRequest : undefined,
  );
}

export function resolveOpenAiCompatibleHttpOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): string[] {
  return resolveSharedSecretHttpOperatorScopes(req, requestAuth);
}

export function resolveSharedSecretHttpOperatorScopes(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): string[] {
  if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
    // Shared-secret HTTP bearer auth is a documented trusted-operator surface
    // for direct HTTP surfaces that opt into it. This is designed-as-is:
    // token/password auth proves possession of the gateway operator secret, not
    // a narrower per-request scope identity, so restore the normal defaults.
    return [...CLI_DEFAULT_OPERATOR_SCOPES];
  }
  return resolveTrustedHttpOperatorScopes(req, requestAuth);
}

export function resolveHttpSenderIsOwner(
  req: IncomingMessage,
  authOrRequest?:
    | SharedSecretGatewayAuth
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">,
): boolean {
  return resolveTrustedHttpOperatorScopes(req, authOrRequest).includes(ADMIN_SCOPE);
}

export function resolveOpenAiCompatibleHttpSenderIsOwner(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): boolean {
  if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
    // Shared-secret HTTP bearer auth also carries owner semantics on the compat
    // APIs and direct /tools/invoke. This is intentional: there is no separate
    // per-request owner primitive on that shared-secret path, so managed
    // attachment ownership follows the documented trusted-operator contract.
    return true;
  }
  return resolveHttpSenderIsOwner(req, requestAuth);
}

export function authorizeOpenAiCompatibleHttpModelOverride(
  req: IncomingMessage,
  requestAuth: AuthorizedGatewayHttpRequest,
): { allowed: true } | { allowed: false; missingScope: typeof ADMIN_SCOPE } {
  const requestedModelOverride = normalizeOptionalString(getHeader(req, "x-openclaw-model"));
  if (!requestedModelOverride || resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth)) {
    return { allowed: true };
  }
  return { allowed: false, missingScope: ADMIN_SCOPE };
}
