import type { IncomingMessage } from "node:http";
import type { GatewayAuthConfig, GatewayTrustedProxyConfig } from "../config/types.gateway.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import {
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
  type RateLimitCheckResult,
} from "./auth-rate-limit.js";
import { type ResolvedGatewayAuth } from "./auth-resolve.js";
import {
  isLoopbackAddress,
  resolveLocalInterfaceAddressMatch,
  resolveRequestClientIp,
  isTrustedProxyAddress,
  resolveClientIp,
} from "./net.js";
import { checkBrowserOrigin } from "./origin-check.js";
import { withSerializedRateLimitAttempt } from "./rate-limit-attempt-serialization.js";
export {
  resolveEffectiveSharedGatewayAuth,
  resolveGatewayAuth,
  type EffectiveSharedGatewayAuth,
  type ResolvedGatewayAuth,
  type ResolvedGatewayAuthMode,
  type ResolvedGatewayAuthModeSource,
} from "./auth-resolve.js";

const LEGACY_OPENCLAW_ENV_NOTE =
  " Legacy CLAWDBOT_* and MOLTBOT_* environment variables are ignored; use OPENCLAW_* names.";

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

export type GatewayAuthSurface = "http" | "ws-control-ui";

export type AuthorizeGatewayConnectParams = {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
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
  /** Trust X-Real-IP only when explicitly enabled. */
  allowRealIpFallback?: boolean;
  /** Optional browser-origin policy for trusted-proxy HTTP requests. */
  browserOriginPolicy?: {
    requestHost?: string;
    origin?: string;
    allowedOrigins?: string[];
    allowHostHeaderOriginFallback?: boolean;
  };
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

function hasExplicitSharedSecretAuth(connectAuth?: ConnectAuth | null): boolean {
  return Boolean(
    normalizeOptionalString(connectAuth?.token) || normalizeOptionalString(connectAuth?.password),
  );
}

function normalizeLogin(login: string): string {
  return normalizeLowercaseStringOrEmpty(login);
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

const TAILSCALE_TRUSTED_PROXIES = ["127.0.0.1", "::1"] as const;

function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) {
    return undefined;
  }
  return resolveClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    trustedProxies: [...TAILSCALE_TRUSTED_PROXIES],
  });
}

export function hasForwardedRequestHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  const headers = req.headers ?? {};

  return Boolean(
    headers.forwarded ||
    headers["x-real-ip"] ||
    Object.keys(headers).some((header) =>
      normalizeLowercaseStringOrEmpty(header).startsWith("x-forwarded-"),
    ),
  );
}

export function isLocalDirectRequest(
  req?: IncomingMessage,
  _trustedProxies?: string[],
  _allowRealIpFallback = false,
): boolean {
  if (!req) {
    return false;
  }
  if (!hasForwardedRequestHeaders(req)) {
    return isLoopbackAddress(req.socket?.remoteAddress);
  }
  return false;
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) {
    return null;
  }
  const login = normalizeOptionalString(req.headers["tailscale-user-login"]);
  if (!login) {
    return null;
  }
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = normalizeOptionalString(nameRaw) ?? login;
  return {
    login,
    name,
    profilePic: normalizeOptionalString(profilePic),
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) {
    return false;
  }
  return isLoopbackAddress(req.socket?.remoteAddress) && hasTailscaleProxyHeaders(req);
}

async function resolveVerifiedTailscaleUser(params: {
  req?: IncomingMessage;
  tailscaleWhois: TailscaleWhoisLookup;
}): Promise<{ ok: true; user: TailscaleUser } | { ok: false; reason: string }> {
  const { req, tailscaleWhois } = params;
  const tailscaleUser = getTailscaleUser(req);
  if (!tailscaleUser) {
    return { ok: false, reason: "tailscale_user_missing" };
  }
  if (!isTailscaleProxyRequest(req)) {
    return { ok: false, reason: "tailscale_proxy_missing" };
  }
  const clientIp = resolveTailscaleClientIp(req);
  if (!clientIp) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  const whois = await tailscaleWhois(clientIp);
  if (!whois?.login) {
    return { ok: false, reason: "tailscale_whois_failed" };
  }
  if (normalizeLogin(whois.login) !== normalizeLogin(tailscaleUser.login)) {
    return { ok: false, reason: "tailscale_user_mismatch" };
  }
  return {
    ok: true,
    user: {
      login: whois.login,
      name: whois.name ?? tailscaleUser.name,
      profilePic: tailscaleUser.profilePic,
    },
  };
}

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
  return authSurface === "ws-control-ui";
}

function authorizeTrustedProxyBrowserOrigin(params: {
  authSurface: GatewayAuthSurface;
  browserOriginPolicy?: AuthorizeGatewayConnectParams["browserOriginPolicy"];
}): { ok: false; reason: string } | null {
  if (params.authSurface !== "http") {
    return null;
  }

  const origin = params.browserOriginPolicy?.origin?.trim();
  if (!origin) {
    return null;
  }

  const originCheck = checkBrowserOrigin({
    requestHost: params.browserOriginPolicy?.requestHost,
    origin,
    allowedOrigins: params.browserOriginPolicy?.allowedOrigins,
    allowHostHeaderOriginFallback: params.browserOriginPolicy?.allowHostHeaderOriginFallback,
    isLocalClient: false,
  });
  if (originCheck.ok) {
    return null;
  }
  return { ok: false, reason: "trusted_proxy_origin_not_allowed" };
}

function authorizeTokenAuth(params: {
  authToken?: string;
  connectToken?: string;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
}): GatewayAuthResult {
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
    params.limiter?.recordFailure(params.ip, params.rateLimitScope);
    return { ok: false, reason: "token_mismatch" };
  }
  params.limiter?.reset(params.ip, params.rateLimitScope);
  return { ok: true, method: "token" };
}

function authorizePasswordAuth(params: {
  authPassword?: string;
  connectPassword?: string;
  limiter?: AuthRateLimiter;
  ip?: string;
  rateLimitScope: string;
}): GatewayAuthResult {
  if (!params.authPassword) {
    return { ok: false, reason: "password_missing_config" };
  }
  if (!params.connectPassword) {
    // Same as token_missing — don't penalize absent credentials.
    return { ok: false, reason: "password_missing" };
  }
  if (!safeEqualSecret(params.connectPassword, params.authPassword)) {
    params.limiter?.recordFailure(params.ip, params.rateLimitScope);
    return { ok: false, reason: "password_mismatch" };
  }
  params.limiter?.reset(params.ip, params.rateLimitScope);
  return { ok: true, method: "password" };
}

export async function authorizeGatewayConnect(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, req, trustedProxies } = params;
  const authSurface = params.authSurface ?? "http";
  const limiter = params.rateLimiter;
  const ip =
    params.clientIp ??
    resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ??
    req?.socket?.remoteAddress;
  const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
  const localDirect = isLocalDirectRequest(
    req,
    trustedProxies,
    params.allowRealIpFallback === true,
  );

  // Keep the limiter strict on the async Tailscale branch by serializing
  // attempts for the same {scope, ip} key across the pre-check and failure write.
  if (
    limiter &&
    shouldAllowTailscaleHeaderAuth(authSurface) &&
    auth.allowTailscale &&
    !localDirect
  ) {
    return await withSerializedRateLimitAttempt({
      ip,
      scope: rateLimitScope,
      run: async () => await authorizeGatewayConnectCore(params),
    });
  }

  return await authorizeGatewayConnectCore(params);
}

async function authorizeGatewayConnectCore(
  params: AuthorizeGatewayConnectParams,
): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const authSurface = params.authSurface ?? "http";
  const allowTailscaleHeaderAuth = shouldAllowTailscaleHeaderAuth(authSurface);
  const limiter = params.rateLimiter;
  const ip =
    params.clientIp ??
    resolveRequestClientIp(req, trustedProxies, params.allowRealIpFallback === true) ??
    req?.socket?.remoteAddress;
  const rateLimitScope = params.rateLimitScope ?? AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET;
  const localDirect = isLocalDirectRequest(
    req,
    trustedProxies,
    params.allowRealIpFallback === true,
  );

  if (auth.mode === "trusted-proxy") {
    // Same-host reverse proxies may forward identity headers without a full
    // forwarded chain; keep those on the trusted-proxy path so allowUsers and
    // requiredHeaders still apply.
    if (!auth.trustedProxy) {
      return { ok: false, reason: "trusted_proxy_config_missing" };
    }
    if (!trustedProxies || trustedProxies.length === 0) {
      return { ok: false, reason: "trusted_proxy_no_proxies_configured" };
    }

    const result = authorizeTrustedProxy({
      req,
      trustedProxies,
      trustedProxyConfig: auth.trustedProxy,
    });

    if ("user" in result) {
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
      if (limiter) {
        const rlCheck: RateLimitCheckResult = limiter.check(ip, rateLimitScope);
        if (!rlCheck.allowed) {
          return {
            ok: false,
            reason: "rate_limited",
            rateLimited: true,
            retryAfterMs: rlCheck.retryAfterMs,
          };
        }
      }
      return authorizePasswordAuth({
        authPassword: auth.password,
        connectPassword: connectAuth.password,
        limiter,
        ip,
        rateLimitScope,
      });
    }
    return { ok: false, reason: result.reason };
  }

  if (auth.mode === "none") {
    return { ok: true, method: "none" };
  }

  if (limiter) {
    const rlCheck: RateLimitCheckResult = limiter.check(ip, rateLimitScope);
    if (!rlCheck.allowed) {
      return {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: rlCheck.retryAfterMs,
      };
    }
  }

  if (
    allowTailscaleHeaderAuth &&
    auth.allowTailscale &&
    !localDirect &&
    !hasExplicitSharedSecretAuth(connectAuth)
  ) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      limiter?.reset(ip, rateLimitScope);
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
  }

  if (auth.mode === "token") {
    return authorizeTokenAuth({
      authToken: auth.token,
      connectToken: connectAuth?.token,
      limiter,
      ip,
      rateLimitScope,
    });
  }

  if (auth.mode === "password") {
    return authorizePasswordAuth({
      authPassword: auth.password,
      connectPassword: connectAuth?.password,
      limiter,
      ip,
      rateLimitScope,
    });
  }

  limiter?.recordFailure(ip, rateLimitScope);
  return { ok: false, reason: "unauthorized" };
}

export async function authorizeHttpGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "http",
  });
}

export async function authorizeWsControlUiGatewayConnect(
  params: Omit<AuthorizeGatewayConnectParams, "authSurface">,
): Promise<GatewayAuthResult> {
  return authorizeGatewayConnect({
    ...params,
    authSurface: "ws-control-ui",
  });
}
