import type { IncomingMessage, ServerResponse } from "node:http";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { PluginLogger } from "../api.js";
import { resolveRequestClientIp } from "../runtime-api.js";
import type { DiffArtifactStore } from "./store.js";
import { DIFF_ARTIFACT_ID_PATTERN, DIFF_ARTIFACT_TOKEN_PATTERN } from "./types.js";
import { VIEWER_ASSET_PREFIX, getServedViewerAsset } from "./viewer-assets.js";

const VIEW_PREFIX = "/plugins/diffs/view/";
const VIEWER_MAX_FAILURES_PER_WINDOW = 40;
const VIEWER_FAILURE_WINDOW_MS = 60_000;
const VIEWER_LOCKOUT_MS = 60_000;
const VIEWER_LIMITER_MAX_KEYS = 2_048;
const VIEWER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  "object-src 'none'",
].join("; ");

export function createDiffsHttpHandler(params: {
  store: DiffArtifactStore;
  logger?: PluginLogger;
  allowRemoteViewer?: boolean;
  trustedProxies?: readonly string[];
  allowRealIpFallback?: boolean;
}) {
  const viewerFailureLimiter = new ViewerFailureLimiter();

  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed) {
      return false;
    }

    if (parsed.pathname.startsWith(VIEWER_ASSET_PREFIX)) {
      return await serveAsset(req, res, parsed.pathname, params.logger);
    }

    if (!parsed.pathname.startsWith(VIEW_PREFIX)) {
      return false;
    }

    const access = resolveViewerAccess(req, {
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
    });
    if (!access.localRequest && params.allowRemoteViewer !== true) {
      respondText(res, 404, "Diff not found");
      return true;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      respondText(res, 405, "Method not allowed");
      return true;
    }

    if (!access.localRequest) {
      const throttled = viewerFailureLimiter.check(access.remoteKey);
      if (!throttled.allowed) {
        res.statusCode = 429;
        setSharedHeaders(res, "text/plain; charset=utf-8");
        res.setHeader("Retry-After", String(Math.max(1, Math.ceil(throttled.retryAfterMs / 1000))));
        res.end("Too Many Requests");
        return true;
      }
    }

    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const id = pathParts[3];
    const token = pathParts[4];
    if (
      !id ||
      !token ||
      !DIFF_ARTIFACT_ID_PATTERN.test(id) ||
      !DIFF_ARTIFACT_TOKEN_PATTERN.test(token)
    ) {
      recordRemoteFailure(viewerFailureLimiter, access);
      respondText(res, 404, "Diff not found");
      return true;
    }

    const artifact = await params.store.getArtifact(id, token);
    if (!artifact) {
      recordRemoteFailure(viewerFailureLimiter, access);
      respondText(res, 404, "Diff not found or expired");
      return true;
    }

    try {
      const html = await params.store.readHtml(id);
      resetRemoteFailures(viewerFailureLimiter, access);
      res.statusCode = 200;
      setSharedHeaders(res, "text/html; charset=utf-8");
      res.setHeader("content-security-policy", VIEWER_CONTENT_SECURITY_POLICY);
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(html);
      }
      return true;
    } catch (error) {
      recordRemoteFailure(viewerFailureLimiter, access);
      params.logger?.warn(`Failed to serve diff artifact ${id}: ${String(error)}`);
      respondText(res, 500, "Failed to load diff");
      return true;
    }
  };
}

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

async function serveAsset(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  logger?: PluginLogger,
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") {
    respondText(res, 405, "Method not allowed");
    return true;
  }

  try {
    const asset = await getServedViewerAsset(pathname);
    if (!asset) {
      respondText(res, 404, "Asset not found");
      return true;
    }

    res.statusCode = 200;
    setSharedHeaders(res, asset.contentType);
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(asset.body);
    }
    return true;
  } catch (error) {
    logger?.warn(`Failed to serve diffs asset ${pathname}: ${String(error)}`);
    respondText(res, 500, "Failed to load asset");
    return true;
  }
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  setSharedHeaders(res, "text/plain; charset=utf-8");
  res.end(body);
}

function setSharedHeaders(res: ServerResponse, contentType: string): void {
  res.setHeader("cache-control", "no-store, max-age=0");
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}

function normalizeRemoteClientKey(remoteAddress: string | undefined): string {
  const normalized = normalizeLowercaseStringOrEmpty(remoteAddress);
  if (!normalized) {
    return "unknown";
  }
  return normalized.startsWith("::ffff:") ? normalized.slice("::ffff:".length) : normalized;
}

function isLoopbackClientIp(clientIp: string): boolean {
  return clientIp === "127.0.0.1" || clientIp === "::1";
}

function hasProxyForwardingHints(req: IncomingMessage): boolean {
  const headers = req.headers ?? {};
  return Boolean(
    headers["x-forwarded-for"] ||
    headers["x-real-ip"] ||
    headers.forwarded ||
    headers["x-forwarded-host"] ||
    headers["x-forwarded-proto"],
  );
}

function resolveViewerAccess(
  req: IncomingMessage,
  params: {
    trustedProxies?: readonly string[];
    allowRealIpFallback?: boolean;
  },
): {
  remoteKey: string;
  localRequest: boolean;
} {
  const proxyHintsPresent = hasProxyForwardingHints(req);
  const clientIp =
    proxyHintsPresent || (params.trustedProxies?.length ?? 0) > 0
      ? // Reuse gateway proxy trust rules and fail closed when a trusted proxy hop
        // does not provide usable client-origin headers.
        resolveRequestClientIp(
          req,
          params.trustedProxies ? [...params.trustedProxies] : undefined,
          params.allowRealIpFallback === true,
        )
      : req.socket?.remoteAddress;
  const remoteKey = normalizeRemoteClientKey(clientIp ?? req.socket?.remoteAddress);
  const localRequest =
    !proxyHintsPresent && typeof clientIp === "string" && isLoopbackClientIp(remoteKey);
  return { remoteKey, localRequest };
}

function recordRemoteFailure(
  limiter: ViewerFailureLimiter,
  access: { remoteKey: string; localRequest: boolean },
): void {
  if (!access.localRequest) {
    limiter.recordFailure(access.remoteKey);
  }
}

function resetRemoteFailures(
  limiter: ViewerFailureLimiter,
  access: { remoteKey: string; localRequest: boolean },
): void {
  if (!access.localRequest) {
    limiter.reset(access.remoteKey);
  }
}

type RateLimitCheckResult = {
  allowed: boolean;
  retryAfterMs: number;
};

type ViewerFailureState = {
  windowStartMs: number;
  failures: number;
  lockUntilMs: number;
};

class ViewerFailureLimiter {
  private readonly failures = new Map<string, ViewerFailureState>();

  check(key: string): RateLimitCheckResult {
    this.prune();
    const state = this.failures.get(key);
    if (!state) {
      return { allowed: true, retryAfterMs: 0 };
    }
    const now = Date.now();
    if (state.lockUntilMs > now) {
      return { allowed: false, retryAfterMs: state.lockUntilMs - now };
    }
    if (now - state.windowStartMs >= VIEWER_FAILURE_WINDOW_MS) {
      this.failures.delete(key);
      return { allowed: true, retryAfterMs: 0 };
    }
    return { allowed: true, retryAfterMs: 0 };
  }

  recordFailure(key: string): void {
    this.prune();
    const now = Date.now();
    const current = this.failures.get(key);
    const next =
      !current || now - current.windowStartMs >= VIEWER_FAILURE_WINDOW_MS
        ? {
            windowStartMs: now,
            failures: 1,
            lockUntilMs: 0,
          }
        : {
            ...current,
            failures: current.failures + 1,
          };
    if (next.failures >= VIEWER_MAX_FAILURES_PER_WINDOW) {
      next.lockUntilMs = now + VIEWER_LOCKOUT_MS;
    }
    this.failures.set(key, next);
  }

  reset(key: string): void {
    this.failures.delete(key);
  }

  private prune(): void {
    if (this.failures.size < VIEWER_LIMITER_MAX_KEYS) {
      return;
    }
    const now = Date.now();
    for (const [key, state] of this.failures) {
      if (state.lockUntilMs <= now && now - state.windowStartMs >= VIEWER_FAILURE_WINDOW_MS) {
        this.failures.delete(key);
      }
      if (this.failures.size < VIEWER_LIMITER_MAX_KEYS) {
        return;
      }
    }
    if (this.failures.size >= VIEWER_LIMITER_MAX_KEYS) {
      this.failures.clear();
    }
  }
}
