// Authenticated same-origin proxy for Gateway-owned Control UI icons.
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { fileTypeFromBuffer } from "file-type";
import pLimit from "p-limit";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { normalizeHostname } from "../infra/net/hostname.js";
import { isBlockedHostnameOrIp } from "../infra/net/ssrf.js";
import { readRemoteMediaBuffer } from "../media/fetch.js";
import {
  createImageProcessor,
  MAX_IMAGE_INPUT_PIXELS,
  readImageMetadataFromHeader,
} from "../media/image-ops.js";
import {
  resolveManagedPluginIconUrl,
  resolveManagedSetupCatalogIconUrl,
} from "../plugins/management-service.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import {
  CONTROL_UI_CATALOG_ICON_PATH_PREFIX,
  CONTROL_UI_LINK_FAVICON_PATH_PREFIX,
  CONTROL_UI_PLUGIN_ICON_PATH_PREFIX,
} from "./control-ui-contract.js";
import { respondNotFound as sendNotFound } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed } from "./http-common.js";
import { authorizeGatewayHttpRequestOrReply } from "./http-utils.js";

const PLUGIN_ID_RE =
  /^(?:[a-z0-9][a-z0-9._-]{0,127}|@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127})$/iu;
const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/svg+xml",
  "image/webp",
  "image/x-icon",
]);
const SVG_MIME_TYPE = "image/svg+xml";
const PLUGIN_ICON_CACHE_MAX_ENTRIES = 128;
export const LINK_FAVICON_MAX_BYTES = 64 * 1024;
const LINK_FAVICON_NEGATIVE_CACHE_TTL_MS = 5 * 60 * 1000;
const LINK_FAVICON_MAX_OUTSTANDING_FETCHES = 32;
const linkFaviconFetchLimit = pLimit(4);

export const PLUGIN_ICON_MAX_BYTES = 256 * 1024;
export const PLUGIN_ICON_MAX_REDIRECTS = 3;
export const PLUGIN_ICON_REQUEST_TIMEOUT_MS = 5_000;
export const PLUGIN_ICON_CACHE_TTL_MS = 60 * 60 * 1000;

type PluginIconPayload = {
  body: Buffer;
  contentType: string;
};

type PluginIconCacheEntry = {
  expiresAt: number;
  promise: Promise<PluginIconPayload | null>;
};

let pluginIconCache = new Map<string, PluginIconCacheEntry>();
const pluginIconImageProcessor = createImageProcessor();

function normalizeBasePath(basePath?: string): string {
  const trimmed = basePath?.trim() ?? "";
  if (!trimmed || trimmed === "/") {
    return "";
  }
  const withLeadingSlash = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeadingSlash.replace(/\/+$/u, "");
}

export function resolvePluginIconRoutePrefix(basePath?: string): string {
  return `${normalizeBasePath(basePath)}${CONTROL_UI_PLUGIN_ICON_PATH_PREFIX}/`;
}

type IconRequestPathResolution = { matched: false } | { matched: true; value: string | null };

function parseIconRequestPath(
  urlRaw: string | undefined,
  prefix: string,
  isValid: (value: string) => boolean = Boolean,
): IconRequestPathResolution {
  if (!urlRaw) {
    return { matched: false };
  }
  const pathname = new URL(urlRaw, "http://localhost").pathname;
  if (!pathname.startsWith(prefix)) {
    return { matched: false };
  }
  const encodedValue = pathname.slice(prefix.length);
  if (!encodedValue || encodedValue.includes("/")) {
    return { matched: true, value: null };
  }
  try {
    const value = decodeURIComponent(encodedValue);
    return { matched: true, value: isValid(value) ? value : null };
  } catch {
    return { matched: true, value: null };
  }
}

function parsePluginIconRequest(
  urlRaw: string | undefined,
  basePath?: string,
): IconRequestPathResolution {
  return parseIconRequestPath(urlRaw, resolvePluginIconRoutePrefix(basePath), (value) =>
    PLUGIN_ID_RE.test(value),
  );
}

function parseCatalogIconRequest(
  urlRaw: string | undefined,
  basePath?: string,
): IconRequestPathResolution {
  const prefix = `${normalizeBasePath(basePath)}${CONTROL_UI_CATALOG_ICON_PATH_PREFIX}/`;
  return parseIconRequestPath(urlRaw, prefix);
}

function normalizeLinkFaviconHostname(value: string): string | null {
  if (value.length > 253) {
    return null;
  }
  const normalized = normalizeHostname(value);
  if (!normalized || isIP(normalized) !== 0 || isBlockedHostnameOrIp(normalized)) {
    return null;
  }
  try {
    const parsed = new URL(`https://${normalized}/`);
    return parsed.hostname === normalized ? normalized : null;
  } catch {
    return null;
  }
}

function parseLinkFaviconRequest(
  urlRaw: string | undefined,
  basePath?: string,
): IconRequestPathResolution {
  const prefix = `${normalizeBasePath(basePath)}${CONTROL_UI_LINK_FAVICON_PATH_PREFIX}/`;
  return parseIconRequestPath(
    urlRaw,
    prefix,
    (value) => normalizeLinkFaviconHostname(value) !== null,
  );
}

function normalizeMimeType(contentType: string | undefined): string | undefined {
  const normalized = contentType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
  return normalized === "image/vnd.microsoft.icon" ? "image/x-icon" : normalized;
}

async function validateImageMime(body: Buffer, contentType: string): Promise<boolean> {
  if (contentType === SVG_MIME_TYPE) {
    const text = body.toString("utf8");
    return (
      !text.includes("\0") &&
      !/<!doctype|<!entity/iu.test(text) &&
      /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(text)
    );
  }
  const detected = await fileTypeFromBuffer(body);
  return normalizeMimeType(detected?.mime) === contentType;
}

function rememberIcon(
  cache: Map<string, PluginIconCacheEntry>,
  cacheKey: string,
  entry: PluginIconCacheEntry,
): PluginIconCacheEntry {
  cache.delete(cacheKey);
  cache.set(cacheKey, entry);
  pruneMapToMaxSize(cache, PLUGIN_ICON_CACHE_MAX_ENTRIES);
  return entry;
}

async function loadCatalogIcon(params: {
  cacheScope: string;
  iconUrl: string;
  maxBytes?: number;
  requireHttps?: boolean;
  retainFailureForMs?: number;
  limitConcurrency?: boolean;
}): Promise<PluginIconPayload | null> {
  let parsed: URL;
  try {
    parsed = new URL(params.iconUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    !parsed.hostname ||
    parsed.hash
  ) {
    return null;
  }

  const cacheKey = `${params.cacheScope}\0${parsed.href}`;
  const now = Date.now();
  const cached = pluginIconCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    pluginIconCache.delete(cacheKey);
    pluginIconCache.set(cacheKey, cached);
    return await cached.promise;
  }
  if (cached) {
    pluginIconCache.delete(cacheKey);
  }

  const load = async () => {
    try {
      // readRemoteMediaBuffer uses fetchWithSsrFGuard; every redirect is
      // re-resolved and revalidated before its response body is accepted.
      const loaded = await readRemoteMediaBuffer({
        url: parsed.href,
        maxBytes: params.maxBytes ?? PLUGIN_ICON_MAX_BYTES,
        maxRedirects: PLUGIN_ICON_MAX_REDIRECTS,
        requireHttps: params.requireHttps,
        timeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
        responseHeaderTimeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
        readIdleTimeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
        requestInit: {
          headers: {
            Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml",
          },
        },
      });
      const contentType = normalizeMimeType(loaded.contentType);
      if (
        !contentType ||
        !ALLOWED_IMAGE_MIME_TYPES.has(contentType) ||
        !(await validateImageMime(loaded.buffer, contentType))
      ) {
        return null;
      }
      if (contentType === SVG_MIME_TYPE) {
        return { body: loaded.buffer, contentType };
      }
      if (contentType === "image/x-icon") {
        return { body: loaded.buffer, contentType };
      }
      const metadata = readImageMetadataFromHeader(loaded.buffer);
      if (
        !metadata ||
        !Number.isInteger(metadata.width) ||
        !Number.isInteger(metadata.height) ||
        metadata.width <= 0 ||
        metadata.height <= 0 ||
        metadata.width > MAX_IMAGE_INPUT_PIXELS / metadata.height
      ) {
        return null;
      }
      const normalized = await pluginIconImageProcessor.encode(loaded.buffer, {
        format: "png",
        compressionLevel: 9,
        resize: {
          fit: "inside",
          maxSide: 256,
          enlarge: false,
        },
      });
      if (normalized.data.byteLength > (params.maxBytes ?? PLUGIN_ICON_MAX_BYTES)) {
        return null;
      }
      return {
        body: normalized.data,
        contentType: "image/png",
      };
    } catch {
      return null;
    }
  };
  if (
    params.limitConcurrency &&
    linkFaviconFetchLimit.activeCount + linkFaviconFetchLimit.pendingCount >=
      LINK_FAVICON_MAX_OUTSTANDING_FETCHES
  ) {
    return null;
  }
  const pending = params.limitConcurrency ? linkFaviconFetchLimit(load) : load();
  const entry = rememberIcon(pluginIconCache, cacheKey, {
    expiresAt: now + PLUGIN_ICON_CACHE_TTL_MS,
    promise: pending,
  });
  const result = await pending;
  if (!result && pluginIconCache.get(cacheKey) === entry) {
    if (params.retainFailureForMs) {
      entry.expiresAt = Date.now() + params.retainFailureForMs;
    } else {
      pluginIconCache.delete(cacheKey);
    }
  }
  return result;
}

export function clearPluginIconCacheForTest(): void {
  pluginIconCache = new Map();
}

export async function handlePluginIconHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    config: OpenClawConfig;
    basePath?: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const pluginRequest = parsePluginIconRequest(req.url, opts.basePath);
  const catalogRequest = parseCatalogIconRequest(req.url, opts.basePath);
  const faviconRequest = parseLinkFaviconRequest(req.url, opts.basePath);
  if (!pluginRequest.matched && !catalogRequest.matched && !faviconRequest.matched) {
    return false;
  }
  const pluginId = pluginRequest.matched ? pluginRequest.value : null;
  const catalogIconUrl = catalogRequest.matched ? catalogRequest.value : null;
  const faviconHostname = faviconRequest.matched
    ? faviconRequest.value
      ? normalizeLinkFaviconHostname(faviconRequest.value)
      : null
    : null;
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }

  if (
    faviconRequest.matched &&
    opts.config.gateway?.controlUi?.automaticallyFetchFavicons === false
  ) {
    sendNotFound(res);
    return true;
  }

  const iconUrl = pluginId
    ? await resolveManagedPluginIconUrl({
        config: opts.config,
        pluginId,
      })
    : catalogIconUrl
      ? resolveManagedSetupCatalogIconUrl({
          config: opts.config,
          iconUrl: catalogIconUrl,
        })
      : faviconHostname
        ? // The route accepts a hostname, never a caller-controlled URL. Keep
          // path and scheme fixed so only the strict fetch guard owns redirects.
          `https://${faviconHostname}/favicon.ico`
        : undefined;
  if (!iconUrl) {
    sendNotFound(res);
    return true;
  }
  const icon = await loadCatalogIcon({
    cacheScope: pluginId ? `plugin:${pluginId}` : faviconHostname ? "favicon" : "catalog",
    iconUrl,
    ...(faviconHostname
      ? {
          maxBytes: LINK_FAVICON_MAX_BYTES,
          requireHttps: true,
          retainFailureForMs: LINK_FAVICON_NEGATIVE_CACHE_TTL_MS,
          limitConcurrency: true,
        }
      : {}),
  });
  if (!icon) {
    sendNotFound(res);
    return true;
  }

  res.statusCode = 200;
  res.setHeader("content-type", icon.contentType);
  res.setHeader("content-length", String(icon.body.byteLength));
  res.setHeader("cache-control", "private, max-age=3600");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("x-content-type-options", "nosniff");
  // The UI fetches these bytes and renders only a validated image blob. Making
  // every response a sandboxed attachment prevents direct same-origin navigation.
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
  );
  res.setHeader(
    "content-disposition",
    `attachment; filename="${faviconHostname ? "link-favicon" : "plugin-icon"}"`,
  );
  // HEAD uses the same authenticated, cached representation; only its body is omitted.
  res.end(method === "HEAD" ? undefined : icon.body);
  return true;
}
