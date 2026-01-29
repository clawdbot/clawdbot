import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { GatewayAuthConfig, GatewayTailscaleMode } from "../config/config.js";
import { readTailscaleWhoisIdentity, type TailscaleWhoisIdentity } from "../infra/tailscale.js";
import { isTrustedProxyAddress, parseForwardedForClientIp, resolveGatewayClientIp } from "./net.js";
export type ResolvedGatewayAuthMode = "token" | "password";

export type ResolvedGatewayAuth = {
  mode: ResolvedGatewayAuthMode;
  token?: string;
  password?: string;
  allowTailscale: boolean;
};

export type GatewayAuthResult = {
  ok: boolean;
  method?: "token" | "password" | "tailscale" | "device-token";
  user?: string;
  reason?: string;
};

type ConnectAuth = {
  token?: string;
  password?: string;
};

type TailscaleUser = {
  login: string;
  name: string;
  profilePic?: string;
};

type TailscaleWhoisLookup = (ip: string) => Promise<TailscaleWhoisIdentity | null>;

export const DEFAULT_GATEWAY_AUTH_MIN_LENGTH = 24;

type AuthFailureState = {
  count: number;
  firstSeen: number;
  blockedUntil?: number;
};

const AUTH_FAILURE_WINDOW_MS = 60_000;
const AUTH_FAILURE_BLOCK_MS = 5 * 60_000;
const AUTH_FAILURE_LIMIT = 10;
const authFailuresByIp = new Map<string, AuthFailureState>();

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function isLoopbackAddress(ip: string | undefined): boolean {
  if (!ip) return false;
  if (ip === "127.0.0.1") return true;
  if (ip.startsWith("127.")) return true;
  if (ip === "::1") return true;
  if (ip.startsWith("::ffff:127.")) return true;
  return false;
}

function getHostName(hostHeader?: string): string {
  const host = (hostHeader ?? "").trim().toLowerCase();
  if (!host) return "";
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    if (end !== -1) return host.slice(1, end);
  }
  const [name] = host.split(":");
  return name ?? "";
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function resolveTailscaleClientIp(req?: IncomingMessage): string | undefined {
  if (!req) return undefined;
  const forwardedFor = headerValue(req.headers?.["x-forwarded-for"]);
  return forwardedFor ? parseForwardedForClientIp(forwardedFor) : undefined;
}

function resolveRequestClientIp(
  req?: IncomingMessage,
  trustedProxies?: string[],
): string | undefined {
  if (!req) return undefined;
  return resolveGatewayClientIp({
    remoteAddr: req.socket?.remoteAddress ?? "",
    forwardedFor: headerValue(req.headers?.["x-forwarded-for"]),
    realIp: headerValue(req.headers?.["x-real-ip"]),
    trustedProxies,
  });
}

export function isLocalDirectRequest(req?: IncomingMessage, trustedProxies?: string[]): boolean {
  if (!req) return false;
  const clientIp = resolveRequestClientIp(req, trustedProxies) ?? "";
  if (!isLoopbackAddress(clientIp)) return false;

  const host = getHostName(req.headers?.host);
  const hostIsLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  const hostIsTailscaleServe = host.endsWith(".ts.net");

  const hasForwarded = Boolean(
    req.headers?.["x-forwarded-for"] ||
    req.headers?.["x-real-ip"] ||
    req.headers?.["x-forwarded-host"],
  );

  const remoteIsTrustedProxy = isTrustedProxyAddress(req.socket?.remoteAddress, trustedProxies);
  return (hostIsLocal || hostIsTailscaleServe) && (!hasForwarded || remoteIsTrustedProxy);
}

function resolveAuthRateLimitKey(
  req?: IncomingMessage,
  trustedProxies?: string[],
): string | null {
  if (!req) return null;
  if (isLocalDirectRequest(req, trustedProxies)) return null;
  const clientIp = resolveRequestClientIp(req, trustedProxies);
  if (!clientIp || isLoopbackAddress(clientIp)) return null;
  return clientIp;
}

function isAuthRateLimited(key: string, now: number): boolean {
  const state = authFailuresByIp.get(key);
  if (!state) return false;
  if (state.blockedUntil && state.blockedUntil > now) return true;
  if (now - state.firstSeen > AUTH_FAILURE_WINDOW_MS) {
    authFailuresByIp.delete(key);
  }
  return false;
}

function recordAuthFailure(key: string, now: number): void {
  const state = authFailuresByIp.get(key);
  if (!state || now - state.firstSeen > AUTH_FAILURE_WINDOW_MS) {
    authFailuresByIp.set(key, { count: 1, firstSeen: now });
    return;
  }
  const nextCount = state.count + 1;
  const blockedUntil =
    nextCount >= AUTH_FAILURE_LIMIT ? now + AUTH_FAILURE_BLOCK_MS : state.blockedUntil;
  authFailuresByIp.set(key, { ...state, count: nextCount, blockedUntil });
}

function clearAuthFailures(key: string | null): void {
  if (!key) return;
  authFailuresByIp.delete(key);
}

function shouldRecordAuthFailure(reason: string | undefined): boolean {
  return (
    reason === "token_missing" ||
    reason === "token_mismatch" ||
    reason === "password_missing" ||
    reason === "password_mismatch" ||
    reason === "tailscale_user_missing" ||
    reason === "tailscale_proxy_missing" ||
    reason === "tailscale_whois_failed" ||
    reason === "tailscale_user_mismatch"
  );
}

function getTailscaleUser(req?: IncomingMessage): TailscaleUser | null {
  if (!req) return null;
  const login = req.headers["tailscale-user-login"];
  if (typeof login !== "string" || !login.trim()) return null;
  const nameRaw = req.headers["tailscale-user-name"];
  const profilePic = req.headers["tailscale-user-profile-pic"];
  const name = typeof nameRaw === "string" && nameRaw.trim() ? nameRaw.trim() : login.trim();
  return {
    login: login.trim(),
    name,
    profilePic: typeof profilePic === "string" && profilePic.trim() ? profilePic.trim() : undefined,
  };
}

function hasTailscaleProxyHeaders(req?: IncomingMessage): boolean {
  if (!req) return false;
  return Boolean(
    req.headers["x-forwarded-for"] &&
    req.headers["x-forwarded-proto"] &&
    req.headers["x-forwarded-host"],
  );
}

function isTailscaleProxyRequest(req?: IncomingMessage): boolean {
  if (!req) return false;
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

export function resolveGatewayAuth(params: {
  authConfig?: GatewayAuthConfig | null;
  env?: NodeJS.ProcessEnv;
  tailscaleMode?: GatewayTailscaleMode;
}): ResolvedGatewayAuth {
  const authConfig = params.authConfig ?? {};
  const env = params.env ?? process.env;
  const token = authConfig.token ?? env.CLAWDBOT_GATEWAY_TOKEN ?? undefined;
  const password = authConfig.password ?? env.CLAWDBOT_GATEWAY_PASSWORD ?? undefined;
  const mode: ResolvedGatewayAuth["mode"] = authConfig.mode ?? (password ? "password" : "token");
  const allowTailscale =
    authConfig.allowTailscale ?? (params.tailscaleMode === "serve" && mode !== "password");
  return {
    mode,
    token,
    password,
    allowTailscale,
  };
}

export function assertGatewayAuthConfigured(auth: ResolvedGatewayAuth): void {
  if (auth.mode === "token" && !auth.token) {
    if (auth.allowTailscale) return;
    throw new Error(
      "gateway auth mode is token, but no token was configured (set gateway.auth.token or CLAWDBOT_GATEWAY_TOKEN)",
    );
  }
  if (auth.mode === "password" && !auth.password) {
    throw new Error("gateway auth mode is password, but no password was configured");
  }
}

export async function authorizeGatewayConnect(params: {
  auth: ResolvedGatewayAuth;
  connectAuth?: ConnectAuth | null;
  req?: IncomingMessage;
  trustedProxies?: string[];
  tailscaleWhois?: TailscaleWhoisLookup;
}): Promise<GatewayAuthResult> {
  const { auth, connectAuth, req, trustedProxies } = params;
  const tailscaleWhois = params.tailscaleWhois ?? readTailscaleWhoisIdentity;
  const localDirect = isLocalDirectRequest(req, trustedProxies);
  const now = Date.now();
  const rateLimitKey = resolveAuthRateLimitKey(req, trustedProxies);
  if (rateLimitKey && isAuthRateLimited(rateLimitKey, now)) {
    return { ok: false, reason: "rate_limited" };
  }
  const fail = (reason: GatewayAuthResult["reason"]) => {
    if (rateLimitKey && shouldRecordAuthFailure(reason)) {
      recordAuthFailure(rateLimitKey, now);
    }
    return { ok: false, reason };
  };

  if (auth.allowTailscale && !localDirect) {
    const tailscaleCheck = await resolveVerifiedTailscaleUser({
      req,
      tailscaleWhois,
    });
    if (tailscaleCheck.ok) {
      clearAuthFailures(rateLimitKey);
      return {
        ok: true,
        method: "tailscale",
        user: tailscaleCheck.user.login,
      };
    }
    return fail(tailscaleCheck.reason);
  }

  if (auth.mode === "token") {
    if (!auth.token) {
      return fail("token_missing_config");
    }
    if (!connectAuth?.token) {
      return fail("token_missing");
    }
    if (!safeEqual(connectAuth.token, auth.token)) {
      return fail("token_mismatch");
    }
    clearAuthFailures(rateLimitKey);
    return { ok: true, method: "token" };
  }

  if (auth.mode === "password") {
    const password = connectAuth?.password;
    if (!auth.password) {
      return fail("password_missing_config");
    }
    if (!password) {
      return fail("password_missing");
    }
    if (!safeEqual(password, auth.password)) {
      return fail("password_mismatch");
    }
    clearAuthFailures(rateLimitKey);
    return { ok: true, method: "password" };
  }

  return fail("unauthorized");
}
