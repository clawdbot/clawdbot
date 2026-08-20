// Diffs plugin module implements http behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackHost } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createAuthRateLimiter, type AuthRateLimiter } from "openclaw/plugin-sdk/webhook-ingress";
import type { PluginLogger } from "../api.js";
import { resolveRequestClientIp } from "../runtime-api.js";
import type { DiffArtifactStore } from "./store.js";
import { DIFF_ARTIFACT_ID_PATTERN, DIFF_ARTIFACT_TOKEN_PATTERN } from "./types.js";
import { VIEWER_ASSET_PREFIX, VIEWER_RUNTIME_PATH, getServedViewerAsset } from "./viewer-assets.js";

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
const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function createDiffsHttpHandler(params: {
  store: DiffArtifactStore;
  logger?: PluginLogger;
  allowRemoteViewer?: boolean;
  trustedProxies?: readonly string[];
  allowRealIpFallback?: boolean;
  resolveAccessConfig?: () => {
    allowRemoteViewer?: boolean;
    trustedProxies?: readonly string[];
    allowRealIpFallback?: boolean;
  };
}) {
  const viewerFailureLimiter = createAuthRateLimiter({
    maxAttempts: VIEWER_MAX_FAILURES_PER_WINDOW,
    windowMs: VIEWER_FAILURE_WINDOW_MS,
    lockoutMs: VIEWER_LOCKOUT_MS,
    exemptLoopback: false,
    pruneIntervalMs: 0,
    maxEntries: VIEWER_LIMITER_MAX_KEYS,
  });

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

    const accessConfig = params.resolveAccessConfig?.() ?? {
      allowRemoteViewer: params.allowRemoteViewer,
      trustedProxies: params.trustedProxies,
      allowRealIpFallback: params.allowRealIpFallback,
    };
    const access = resolveViewerAccess(req, {
      trustedProxies: accessConfig.trustedProxies,
      allowRealIpFallback: accessConfig.allowRealIpFallback,
    });
    if (!access.localRequest && accessConfig.allowRemoteViewer !== true) {
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

    try {
      // Authorization and payload read share one SQLite row snapshot. Keeping
      // them together prevents a replacement between token check and response.
      const viewer = await params.store.readAuthorizedViewer(id, token);
      if (!viewer) {
        recordRemoteFailure(viewerFailureLimiter, access);
        respondText(res, 404, "Diff not found or expired");
        return true;
      }
      resetRemoteFailures(viewerFailureLimiter, access);
      res.statusCode = 200;
      setSharedHeaders(res, "text/html; charset=utf-8");
      res.setHeader("content-security-policy", VIEWER_CONTENT_SECURITY_POLICY);
      res.setHeader("content-length", String(viewer.html.byteLength));
      if (req.method === "HEAD") {
        res.end();
      } else {
        res.end(Buffer.from(viewer.html));
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
    setSharedHeaders(
      res,
      asset.contentType,
      pathname === VIEWER_RUNTIME_PATH ? IMMUTABLE_ASSET_CACHE_CONTROL : undefined,
    );
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

function setSharedHeaders(
  res: ServerResponse,
  contentType: string,
  cacheControl = "no-store, max-age=0",
): void {
  res.setHeader("cache-control", cacheControl);
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
  return isLoopbackHost(clientIp);
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
  limiter: AuthRateLimiter,
  access: { remoteKey: string; localRequest: boolean },
): void {
  if (!access.localRequest) {
    limiter.recordFailure(access.remoteKey);
  }
}

function resetRemoteFailures(
  limiter: AuthRateLimiter,
  access: { remoteKey: string; localRequest: boolean },
): void {
  if (!access.localRequest) {
    limiter.reset(access.remoteKey);
  }
}
