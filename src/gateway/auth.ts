// Gateway connection authorization.
// Authorizes HTTP/websocket gateway requests across shared-secret, Tailscale, and proxy modes.
import type { IncomingMessage } from "node:http";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { GatewayAuthConfig, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth-resolve.js";
import {
  prepareGatewayIngressAttribution,
  PROXY_ATTRIBUTION_REQUIRED_REASON,
  type GatewayIngressAttribution,
  type VerifiedTailscaleIngressIdentity,
} from "./ingress-attribution.js";
import {
  isLocalDirectRequest,
  isLoopbackAddress,
  resolveLocalInterfaceAddressMatch,
  resolveRequestClientIpFromHeaders,
  isTrustedProxyAddress,
} from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";
export { resolveGatewayAuth, type ResolvedGatewayAuth } from "./auth-resolve.js";
const LEGACY_OPENCLAW_ENV_NOTE =
  " Legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored; use OPENCLAW_* names.";

/** Normalized outcome for gateway shared-secret, Tailscale, device, and proxy auth. */
export type GatewayAuthResult = {
  ok: boolean;
  method?:
    | "none"
    | "token"
    | "password"
    | "tailscale"
    | "device-token"
    | "bootstrap-token"
    | "trusted-proxy";
  user?: string;
  /** Full verified Tailscale identity; present only after header + WhoIs agreement. */
  tailscaleIdentity?: VerifiedTailscaleIdentity;
  reason?: string;
  /** Present when the request was blocked by the rate limiter. */
  rateLimited?: boolean;
  /** Milliseconds the client should wait before retrying (when rate-limited). */
  retryAfterMs?: number;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type GatewayAuthSurface = "http" | "http-control-ui-read" | "ws-control-ui";

/** Inputs needed to authorize one HTTP or websocket gateway connection. */
type AuthorizeGatewayConnectParams = {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: Parameters<typeof prepareGatewayIngressAttribution>[0]["tailscaleWhois"];
  ingressAttribution?: GatewayIngressAttribution;
  /**
   * Explicit auth surface. HTTP keeps Tailscale forwarded-header auth disabled.
   * WS Control UI enables it intentionally for tokenless trusted-host login.
   */
  authSurface?: GatewayAuthSurface;
  /** Optional rate limiter instance; when provided, failed attempts are tracked per IP. */
  rateLimiter?: AuthRateLimiter;
  /** Client IP used for rate-limit tracking. Falls back to proxy-aware request IP resolution. */
  clientIp?: string;
  /** Optional limiter scope; defaults to shared-secret auth scope. */
  rateLimitScope?: string;
  /** Let an owner with credential fallbacks record the shared-secret failure after all fallbacks fail. */
  deferRateLimitFailure?: boolean;
  /** Trust X-Real-IP only when explicitly enabled. */
  allowRealIpFallback?: boolean;
  /** Optional browser-origin policy for HTTP requests that require Origin checks. */
  browserOriginPolicy?: {
    requestHost?: string;
    origin?: string;
    fetchSite?: string;
    allowedOrigins?: string[];
    allowHostHeaderOriginFallback?: boolean;
  };
};

type VerifiedTailscaleIdentity = VerifiedTailscaleIngressIdentity;

type GatewayAuthRequestContext = {
  authSurface: GatewayAuthSurface;
  limiter?: AuthRateLimiter;
  subject?: string;
  rateLimitScope: string;
  localDirect: boolean;
  resetOnSuccess: boolean;
  ingressAttribution?: GatewayIngressAttribution;
};

function resolveGatewayAuthRequestContext(
  params: AuthorizeGatewayConnectParams,
): GatewayAuthRequestContext {
  const { req, trustedProxies } = params;
  const authSurface = params.authSurface ?? "http";
  const attributed =
    params.ingressAttribution?.kind === "unattributable-proxy"
      ? undefined
      : params.ingressAttribution;
  const fallbackIp =
    attributed?.clientIp ??
    resolveRequestClientIpFromHeaders(req, trustedProxies, params.allowRealIpFallback === true) ??
    req?.socket?.remoteAddress;
  const localDirect = attributed
    ? attributed.kind === "direct-local"
    : isLocalDirectRequest(req, trustedProxies, params.allowRealIpFallback === true);

  return {
    authSurface,
    limiter: params.rateLimiter,
    subject:
      attributed && !localDirect
        ? attributed.rateLimit.subject.key
        : (params.clientIp ?? attributed?.rateLimit.subject.key ?? fallbackIp),
    rateLimitScope: params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
    localDirect,
    resetOnSuccess: attributed?.rateLimit.resetOnSuccess ?? true,
    ingressAttribution: params.ingressAttribution,
  };
}

function hasExplicitSharedSecretAuth(connectAuth?: ConnectAuth | null): boolean {
  return Boolean(
    normalizeOptionalString(connectAuth?.token) || normalizeOptionalString(connectAuth?.password),
  );
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Validate that the selected gateway auth mode has the required resolved credentials/config. */
export function assertGatewayAuthConfigured(
  auth: ResolvedGatewayAuth,
  rawAuthConfig?: GatewayAuthConfig | null,
): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) {
      return;
    }
    throw new Error(
      `gateway auth mode is token, but no token was configured (set gateway.auth.token or OPENCLAW_GATEWAY_TOKEN).${LEGACY_OPENCLAW_ENV_NOTE}`,
    );
  }
  if (auth.mode === "password" && !auth.password) {
    if (
      rawAuthConfig?.password != null && // pragma: allowlist secret
      typeof rawAuthConfig.password !== "string" // pragma: allowlist secret
    ) {
      throw new Error(
        "gateway auth mode is password, but gateway.auth.password contains a provider reference object instead of a resolved string — bootstrap secrets (gateway.auth.password) must be plaintext strings or set via the OPENCLAW_GATEWAY_PASSWORD environment variable because the secrets provider system has not initialised yet at gateway startup", // pragma: allowlist secret
      );
    }
    throw new Error(
      `gateway auth mode is password, but no password was configured.${LEGACY_OPENCLAW_ENV_NOTE}`,
    );
  }
  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      throw new Error(
        "gateway auth mode is trusted-proxy, but no trustedProxy config was provided (set gateway.auth.trustedProxy)",
      );
    }
    if (!auth.trustedProxy.userHeader || auth.trustedProxy.userHeader.trim() === "") {
      throw new Error(
        "gateway auth mode is trusted-proxy, but trustedProxy.userHeader is empty (set gateway.auth.trustedProxy.userHeader)",
      );
    }
    if (auth.token) {
      throw new Error(
        "gateway auth mode is trusted-proxy, but a shared token is also configured; remove gateway.auth.token / OPENCLAW_GATEWAY_TOKEN because trusted-proxy and token auth are mutually exclusive",
      );
    }
  }
}

/**
 * Check if the request came from a trusted proxy and extract user identity.
 * Returns the user identity if valid, or null with a reason if not.
 */
function authorizeTrustedProxy(params: {
  req?: IncomingMessage;
  trustedProxies?: string[];
  trustedProxyConfig: GatewayTrustedProxyConfig;
}): { user: string } | { reason: string } {
  const { req, trustedProxies, trustedProxyConfig } = params;

  if (!req) {
    return { reason: "trusted_proxy_no_request" };
  }

  const remoteAddr = req.socket?.remoteAddress;
  if (!remoteAddr || !isTrustedProxyAddress(remoteAddr, trustedProxies)) {
    return { reason: "trusted_proxy_untrusted_source" };
  }
  const remoteIsLoopback = isLoopbackAddress(remoteAddr);
  if (remoteIsLoopback && trustedProxyConfig.allowLoopback !== true) {
    return { reason: "trusted_proxy_loopback_source" };
  }
  if (!remoteIsLoopback) {
    const localInterfaceMatch = resolveLocalInterfaceAddressMatch(remoteAddr);
    if (localInterfaceMatch === undefined) {
      return { reason: "trusted_proxy_local_interface_check_failed" };
    }
    if (localInterfaceMatch) {
      return { reason: "trusted_proxy_local_interface_source" };
    }
  }

  const requiredHeaders = trustedProxyConfig.requiredHeaders ?? [];
  for (const header of requiredHeaders) {
    const value = headerValue(req.headers[normalizeLowercaseStringOrEmpty(header)]);
    if (!value || value.trim() === "") {
      return { reason: `trusted_proxy_missing_header_${header}` };
    }
  }

  const userHeaderValue = headerValue(
    req.headers[normalizeLowercaseStringOrEmpty(trustedProxyConfig.userHeader)],
  );
  if (!userHeaderValue || userHeaderValue.trim() === "") {
    return { reason: "trusted_proxy_user_missing" };
  }

  const user = userHeaderValue.trim();

  const allowUsers = trustedProxyConfig.allowUsers ?? [];
  if (allowUsers.length > 0 && !allowUsers.includes(user)) {
    return { reason: "trusted_proxy_user_not_allowed" };
  }

  return { user };
}

function shouldAllowTailscaleHeaderAuth(authSurface: GatewayAuthSurface): boolean {
  return authSurface === "ws-control-ui" || authSurface === "http-control-ui-read";
}

function authorizeHttpBrowserOrigin(params: {
  authSurface: GatewayAuthSurface;
  browserOriginPolicy?: AuthorizeGatewayConnectParams["browserOriginPolicy"];
  isLocalClient: boolean;
  reason: string;
  requireSameOriginFetchWithoutOrigin?: boolean;
  allowWildcardOrigin?: boolean;
}): { ok: false; reason: string } | null {
  if (params.authSurface === "ws-control-ui") {
    return null;
  }

  const origin = params.browserOriginPolicy?.origin?.trim();
  if (!origin) {
    return params.requireSameOriginFetchWithoutOrigin &&
      normalizeLowercaseStringOrEmpty(params.browserOriginPolicy?.fetchSite) !== "same-origin"
      ? { ok: false, reason: params.reason }
      : null;
  }

  const originCheck = checkBrowserOrigin({
    requestHost: params.browserOriginPolicy?.requestHost,
    origin,
    allowedOrigins:
      params.allowWildcardOrigin === false
        ? params.browserOriginPolicy?.allowedOrigins?.filter(
            (candidate) => normalizeLowercaseStringOrEmpty(candidate) !== "*",
          )
        : params.browserOriginPolicy?.allowedOrigins,
    allowHostHeaderOriginFallback: params.browserOriginPolicy?.allowHostHeaderOriginFallback,
    isLocalClient: params.isLocalClient,
  });
  if (originCheck.ok) {
    return null;
  }
  return { ok: false, reason: params.reason };
}

function authorizeTrustedProxyBrowserOrigin(params: {
  authSurface: GatewayAuthSurface;
  browserOriginPolicy?: AuthorizeGatewayConnectParams["browserOriginPolicy"];
}): { ok: false; reason: string } | null {
  return authorizeHttpBrowserOrigin({
    ...params,
    isLocalClient: false,
    reason: "trusted_proxy_origin_not_allowed",
  });
}

async function authorizeTokenAuth(params: {
  authToken?: string;
  connectToken?: string;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
  deferRateLimitFailure?: boolean;
  resetOnSuccess?: boolean;
}): Promise<GatewayAuthResult> {
  if (!params.authToken) {
    return { ok: false, reason: "token_missing_config" };
  }
  if (!params.connectToken) {
    // Don't burn rate-limit slots for missing credentials — the client
    // simply hasn't provided a token yet (e.g. bare browser open).
    // Only actual *wrong* credentials should count as failures.
    return { ok: false, reason: "token_missing" };
  }
  if (!safeEqualSecret(params.connectToken, params.authToken)) {
    if (!params.deferRateLimitFailure) {
      await params.limiter?.recordFailureAndDelay(params.ip, params.rateLimitScope);
    }
    return { ok: false, reason: "token_mismatch" };
  }
  if (params.resetOnSuccess !== false) {
    params.limiter?.reset(params.ip, params.rateLimitScope);
  }
  return { ok: true, method: "token" };
}

async function authorizePasswordAuth(params: {
  authPassword?: string;
  connectPassword?: string;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
  deferRateLimitFailure?: boolean;
  resetOnSuccess?: boolean;
}): Promise<GatewayAuthResult> {
  if (!params.authPassword) {
    return { ok: false, reason: "password_missing_config" };
  }
  if (!params.connectPassword) {
    // Same as token_missing — don't penalize absent credentials.
    return { ok: false, reason: "password_missing" };
  }
  if (!safeEqualSecret(params.connectPassword, params.authPassword)) {
    if (!params.deferRateLimitFailure) {
      await params.limiter?.recordFailureAndDelay(params.ip, params.rateLimitScope);
    }
    return { ok: false, reason: "password_mismatch" };
  }
  if (params.resetOnSuccess !== false) {
    params.limiter?.reset(params.ip, params.rateLimitScope);
  }
  return { ok: true, method: "password" };
}

function rejectIfRateLimited(params: {
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
}): GatewayAuthResult | undefined {
  if (!params.limiter) {
    return undefined;
  }
  const rlCheck: RateLimitCheckResult = params.limiter.check(params.ip, params.rateLimitScope);
  if (rlCheck.allowed) {
    return undefined;
  }
  return {
    ok: false,
    reason: "rate_limited",
    rateLimited: true,
    retryAfterMs: rlCheck.retryAfterMs,
  };
}

/** Authorize a gateway connection, including rate-limit handling around shared-secret failures. */
async function authorizeGatewayConnect(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth } = params;
  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      return { ok: false, reason: "trusted_proxy_config_missing" };
    }
    if (!params.trustedProxies || params.trustedProxies.length === 0) {
      return { ok: false, reason: "trusted_proxy_no_proxies_configured" };
    }
  }
  const ingressAttribution =
    params.ingressAttribution ??
    (params.req
      ? prepareGatewayIngressAttribution({
          req: params.req,
          trustedProxies: params.trustedProxies,
          allowRealIpFallback: params.allowRealIpFallback,
          tailscaleWhois: params.tailscaleWhois,
        })
      : undefined);
  if (ingressAttribution?.kind === "unattributable-proxy") {
    return { ok: false, reason: PROXY_ATTRIBUTION_REQUIRED_REASON };
  }
  const preparedParams = ingressAttribution ? { ...params, ingressAttribution } : params;
  const { authSurface, limiter, subject, rateLimitScope } =
    resolveGatewayAuthRequestContext(preparedParams);

  // Keep the limiter strict on the async Serve WhoIs branch by serializing
  // attempts for the same {scope, ip} key across the pre-check and failure write.
  if (
    limiter &&
    shouldAllowTailscaleHeaderAuth(authSurface) &&
    auth.allowTailscale &&
    ingressAttribution?.kind === "tailscale-serve"
  ) {
    return await withSerializedRateLimitAttempt({
      ip: subject,
      scope: rateLimitScope,
      run: async () => await authorizeGatewayConnectCore(preparedParams),
    });
  }

  return await authorizeGatewayConnectCore(preparedParams);
}

async function authorizeGatewayConnectCore(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const {
    authSurface,
    limiter,
    subject,
    rateLimitScope,
    localDirect,
    resetOnSuccess,
    ingressAttribution,
  } = resolveGatewayAuthRequestContext(params);
  const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);
  const explicitSharedSecretAuth = hasExplicitSharedSecretAuth(connectAuth);

  if (
    authSurface === "http-control-ui-read" &&
    auth.allowTailscale &&
    !localDirect &&
    !explicitSharedSecretAuth
  ) {
    // Reject cross-origin ambient Control UI requests before the Tailscale WhoIs
    // lookup. Explicit shared-secret auth is not subject to this browser gate.
    const originResult = authorizeHttpBrowserOrigin({
      authSurface,
      browserOriginPolicy: params.browserOriginPolicy,
      isLocalClient: localDirect,
      reason: "origin_not_allowed",
      requireSameOriginFetchWithoutOrigin: true,
      allowWildcardOrigin: false,
    });
    if (originResult) {
      return originResult;
    }
  }

  if (auth.mode === "trusted-proxy") {
    if (!auth.trustedProxy) {
      return { ok: false, reason: "trusted_proxy_config_missing" };
    }
    const result = authorizeTrustedProxy({
      req,
      trustedProxies,
      trustedProxyConfig: auth.trustedProxy,
    });

    if ("user" in result) {
      if (ingressAttribution?.kind !== "trusted-proxy") {
        return { ok: false, reason: PROXY_ATTRIBUTION_REQUIRED_REASON };
      }
      const originResult = authorizeTrustedProxyBrowserOrigin({
        authSurface,
        browserOriginPolicy: params.browserOriginPolicy,
      });
      if (originResult) {
        return originResult;
      }
      return { ok: true, method: "trusted-proxy", user: result.user };
    }
    if (localDirect && auth.password && connectAuth?.password) {
      const rateLimitResult = rejectIfRateLimited({ limiter, ip: subject, rateLimitScope });
      if (rateLimitResult) {
        return rateLimitResult;
      }
      return await authorizePasswordAuth({
        authPassword: auth.password,
        connectPassword: connectAuth.password,
        limiter,
        ip: subject,
        rateLimitScope,
        deferRateLimitFailure: params.deferRateLimitFailure,
        resetOnSuccess,
      });
    }
    return { ok: false, reason: result.reason };
  }

  if (auth.mode === "none") {
    if (
      ingressAttribution?.kind === "trusted-proxy" &&
      ingressAttribution.externalTailscaleExposure === "funnel"
    ) {
      return { ok: false, reason: "gateway_auth_required" };
    }
    const originResult = authorizeHttpBrowserOrigin({
      authSurface,
      browserOriginPolicy: params.browserOriginPolicy,
      isLocalClient: localDirect,
      reason: "origin_not_allowed",
    });
    if (originResult) {
      return originResult;
    }
    return { ok: true, method: "none" };
  }

  const canAttemptTailscaleHeaderAuth =
    allowTailscaleHeaderAuth &&
    auth.allowTailscale &&
    !localDirect &&
    ingressAttribution?.kind === "tailscale-serve" &&
    !explicitSharedSecretAuth;

  if (canAttemptTailscaleHeaderAuth) {
    const verifiedTailscaleUser = await ingressAttribution.verifyIdentity();
    if (verifiedTailscaleUser) {
      limiter?.reset(subject, rateLimitScope);
      return {
        ok: true,
        method: "tailscale",
        user: verifiedTailscaleUser.login,
        tailscaleIdentity: verifiedTailscaleUser,
      };
    }
  }

  const rateLimitResult = rejectIfRateLimited({ limiter, ip: subject, rateLimitScope });
  if (rateLimitResult) {
    return rateLimitResult;
  }

  if (auth.mode === "token") {
    return await authorizeTokenAuth({
      authToken: auth.token,
      connectToken: connectAuth?.token,
      limiter,
      ip: subject,
      rateLimitScope,
      deferRateLimitFailure: params.deferRateLimitFailure,
      resetOnSuccess,
    });
  }

  if (auth.mode === "password") {
    return await authorizePasswordAuth({
      authPassword: auth.password,
      connectPassword: connectAuth?.password,
      limiter,
      ip: subject,
      rateLimitScope,
      deferRateLimitFailure: params.deferRateLimitFailure,
      resetOnSuccess,
    });
  }

  await limiter?.recordFailureAndDelay(subject, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}

/** Authorize an HTTP gateway request with Tailscale forwarded-header auth disabled. */
export async function authorizeHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http",
  });
}

/** Authorize a read-only Control UI HTTP request, including verified Tailscale identity. */
export async function authorizeControlUiReadHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http-control-ui-read",
  });
}

/** Authorize a Control UI websocket request with the WS-specific auth surface. */
export async function authorizeWsControlUiGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "ws-control-ui",
  });
}
