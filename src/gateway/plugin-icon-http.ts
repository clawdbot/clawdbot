// Authenticated same-origin proxy for plugin manifest/catalog icons.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileTypeFromBuffer } from "file-type";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
  CONTROL_UI_PLUGIN_ICON_PATH_PREFIX,
} from "./control-ui-contract.js";
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
]);
const SVG_MIME_TYPE = "image/svg+xml";
const PLUGIN_ICON_CACHE_MAX_ENTRIES = 128;

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

function parsePluginIconRequest(urlRaw: string | undefined, basePath?: string): string | null {
  if (!urlRaw) {
    return null;
  }
  const pathname = new URL(urlRaw, "http://localhost").pathname;
  const prefix = resolvePluginIconRoutePrefix(basePath);
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const encodedPluginId = pathname.slice(prefix.length);
  if (!encodedPluginId || encodedPluginId.includes("/")) {
    return null;
  }
  try {
    const pluginId = decodeURIComponent(encodedPluginId);
    return PLUGIN_ID_RE.test(pluginId) ? pluginId : null;
  } catch {
    return null;
  }
}

function parseCatalogIconRequest(urlRaw: string | undefined, basePath?: string): string | null {
  if (!urlRaw) {
    return null;
  }
  const pathname = new URL(urlRaw, "http://localhost").pathname;
  const prefix = `${normalizeBasePath(basePath)}${CONTROL_UI_CATALOG_ICON_PATH_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const encodedIconUrl = pathname.slice(prefix.length);
  if (!encodedIconUrl || encodedIconUrl.includes("/")) {
    return null;
  }
  try {
    return decodeURIComponent(encodedIconUrl) || null;
  } catch {
    return null;
  }
}

function normalizeMimeType(contentType: string | undefined): string | undefined {
  return contentType?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
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
  while (cache.size > PLUGIN_ICON_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) {
      break;
    }
    cache.delete(oldest.value);
  }
  return entry;
}

async function loadCatalogIcon(params: {
  cacheScope: string;
  iconUrl: string;
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

  const pending = (async () => {
    try {
      // readRemoteMediaBuffer uses fetchWithSsrFGuard; every redirect is
      // re-resolved and revalidated before its response body is accepted.
      const loaded = await readRemoteMediaBuffer({
        url: parsed.href,
        maxBytes: PLUGIN_ICON_MAX_BYTES,
        maxRedirects: PLUGIN_ICON_MAX_REDIRECTS,
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
      if (normalized.data.byteLength > PLUGIN_ICON_MAX_BYTES) {
        return null;
      }
      return {
        body: normalized.data,
        contentType: "image/png",
      };
    } catch {
      return null;
    }
  })();
  const entry = rememberIcon(pluginIconCache, cacheKey, {
    expiresAt: now + PLUGIN_ICON_CACHE_TTL_MS,
    promise: pending,
  });
  const result = await pending;
  if (!result && pluginIconCache.get(cacheKey) === entry) {
    pluginIconCache.delete(cacheKey);
  }
  return result;
}

function sendNotFound(res: ServerResponse): void {
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end("Not Found");
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
  const pluginId = parsePluginIconRequest(req.url, opts.basePath);
  const catalogIconUrl = parseCatalogIconRequest(req.url, opts.basePath);
  if (!pluginId && !catalogIconUrl) {
    return false;
  }
  if (req.method !== "GET") {
    sendMethodNotAllowed(res, "GET");
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
      : undefined;
  if (!iconUrl) {
    sendNotFound(res);
    return true;
  }
  const icon = await loadCatalogIcon({
    cacheScope: pluginId ? `plugin:${pluginId}` : "catalog",
    iconUrl,
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
  res.setHeader("content-disposition", 'attachment; filename="plugin-icon"');
  res.end(icon.body);
  return true;
}
