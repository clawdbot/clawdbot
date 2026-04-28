import type { IncomingMessage, ServerResponse } from "node:http";
import { getRuntimeConfig } from "../config/io.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { sendGatewayAuthFailure, sendJson } from "./http-common.js";
import { ADMIN_SCOPE, CLI_DEFAULT_OPERATOR_SCOPES } from "./method-scopes.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

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
}): Promise<{ cfg: OpenClawConfig; requestAuth: AuthorizedGatewayHttpRequest } | null> {
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

  const requestedScopes = params.resolveOperatorScopes(params.req, requestAuth);
  const scopeAuth = authorizeOperatorScopesForMethod(params.operatorMethod, requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(params.res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
    return null;
  }

  return { cfg, requestAuth };
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
  if (usesSharedSecretGatewayMethod(requestAuth.authMethod)) {
    // Shared-secret HTTP bearer auth is a documented trusted-operator surface
    // for the compat APIs and direct /tools/invoke. This is designed-as-is:
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
    // per-request owner primitive on that shared-secret path, so owner-only
    // tool policy follows the documented trusted-operator contract.
    return true;
  }
  return resolveHttpSenderIsOwner(req, requestAuth);
}
