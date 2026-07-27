// Gateway HTTP auth helpers.
// Authenticates HTTP endpoints and derives trusted operator scopes.
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import {
  resolveControlUiPluginAuthCookieGrants,
  setControlUiPluginAuthCookie,
} from "./control-ui-plugin-auth-cookie.js";
import {
  listControlUiPluginTabAuthGrants,
  type ControlUiPluginTabAuthGrant,
} from "./control-ui-plugin-tabs.js";
import { sendGatewayAuthFailure, sendMissingScopeForbidden } from "./http-common.js";
import { ADMIN_SCOPE, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

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
  trustDeclaredOperatorScopes: boolean;
  controlUiPluginGrants?: ControlUiPluginTabAuthGrant[];
  controlUiPluginGrant?: ControlUiPluginTabAuthGrant;
};

export type GatewayHttpRequestAuthCheckResult =
  | {
      ok: true;
      requestAuth: AuthorizedGatewayHttpRequest;
    }
  | {
      ok: false;
      authResult: GatewayAuthResult;
    };

export function resolveHttpBrowserOriginPolicy(
  req: IncomingMessage,
  cfg = getRuntimeConfig(),
): NonNullable<Parameters<typeof authorizeHttpGatewayConnect>[0]["browserOriginPolicy"]> {
  return {
    requestHost: getHeader(req, "host"),
    origin: getHeader(req, "origin"),
    allowedOrigins: cfg.gateway?.controlUi?.allowedOrigins,
    allowHostHeaderOriginFallback:
      cfg.gateway?.controlUi?.dangerouslyAllowHostHeaderOriginFallback === true,
  };
}

function usesSharedSecretHttpAuth(auth: SharedSecretGatewayAuth | undefined): boolean {
  return auth?.mode === "token" || auth?.mode === "password";
}

function usesSharedSecretGatewayMethod(method: GatewayAuthResult["method"] | undefined): boolean {
  return method === "token" || method === "password";
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

export async function authorizeGatewayHttpRequestOrReply(params: {
  req: IncomingMessage;
  res: ServerResponse;
  auth: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
}): Promise<AuthorizedGatewayHttpRequest | null> {
  const result = await checkGatewayHttpRequestAuth(params);
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
): ControlUiPluginTabAuthGrant[] {
  const scopes = usesSharedSecretGatewayMethod(authMethod)
    ? [...CLI_DEFAULT_OPERATOR_SCOPES]
    : authMethod === "trusted-proxy" || authMethod === "tailscale"
      ? resolveTrustedHttpOperatorScopes(req, {
          trustDeclaredOperatorScopes,
        })
      : authMethod === "device-token"
        ? (authenticatedScopes ?? [])
        : [];
  const grants = listControlUiPluginTabAuthGrants(scopes);
  if (grants.length > 0) {
    return setControlUiPluginAuthCookie(res, grants, { generation: authGeneration });
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
  return {
    requestAuth: {
      trustDeclaredOperatorScopes: false,
      controlUiPluginGrants: grants,
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
  const token = getBearerToken(params.req);
  const browserOriginPolicy = resolveHttpBrowserOriginPolicy(params.req, params.cfg);
  const authResult = await authorizeHttpGatewayConnect({
    auth: params.auth,
    connectAuth: token ? { token, password: token } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
    browserOriginPolicy,
  });
  if (!authResult.ok) {
    return {
      ok: false,
      authResult,
    };
  }
  return {
    ok: true,
    requestAuth: {
      authMethod: authResult.method,
      // Shared-secret bearer auth proves possession of the gateway secret, but it
      // does not prove a narrower per-request operator identity. HTTP endpoints
      // must opt in explicitly if they want to treat that shared-secret path as a
      // full trusted-operator surface.
      trustDeclaredOperatorScopes: !usesSharedSecretGatewayMethod(authResult.method),
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
  const cfg = getRuntimeConfig();
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req: params.req,
    res: params.res,
    auth: params.auth,
    trustedProxies: params.trustedProxies ?? cfg.gateway?.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback ?? cfg.gateway?.allowRealIpFallback,
    rateLimiter: params.rateLimiter,
  });
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
    | Pick<AuthorizedGatewayHttpRequest, "trustDeclaredOperatorScopes">,
): string[] {
  if (!shouldTrustDeclaredHttpOperatorScopes(req, authOrRequest)) {
    // Gateway bearer auth only proves possession of the shared secret. Do not
    // let HTTP clients self-assert operator scopes through request headers.
    return [];
  }

  const headerValue = getHeader(req, "x-openclaw-scopes");
  if (headerValue === undefined) {
    // No scope header present - trusted clients without an explicit header
    // get the default operator scopes (matching pre-#57783 behavior).
    return [...CLI_DEFAULT_OPERATOR_SCOPES];
  }
  const raw = headerValue.trim();
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
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
