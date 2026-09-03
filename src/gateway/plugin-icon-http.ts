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
import { parseControlUiResourcePath } from "./control-ui-contract.js";
import { respondNotFound as sendNotFound } from "./control-ui-http-utils.js";
import { sendMethodNotAllowed } from "./http-common.js";
import {
  createHttpImageRepresentation,
  resolveHttpImageMimeType,
  startsWithSvgRootElement,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";

const PLUGIN_ID_RE =
  /^(?:[a-z0-9][a-z0-9._-]{0,127}|@[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,127})$/iu;
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

type PluginIconCacheEntry = {
  expiresAt: number;
  promise: Promise<HttpImageRepresentation | null>;
};

let pluginIconCache = new Map<string, PluginIconCacheEntry>();
const pluginIconImageProcessor = createImageProcessor();

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

async function validateImageMime(body: Buffer, contentType: string): Promise<boolean> {
  if (contentType === SVG_MIME_TYPE) {
    const text = body.toString("utf8");
    return (
      !text.includes("\0") && !/<!doctype|<!entity/iu.test(text) && startsWithSvgRootElement(text)
    );
  }
  const detected = await fileTypeFromBuffer(body);
  return resolveHttpImageMimeType(detected?.mime) === contentType;
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
}): Promise<HttpImageRepresentation | null> {
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
      const contentType = resolveHttpImageMimeType(loaded.contentType);
      if (!contentType || !(await validateImageMime(loaded.buffer, contentType))) {
        return null;
      }
      if (contentType === SVG_MIME_TYPE || contentType === "image/x-icon") {
        return createHttpImageRepresentation(loaded.buffer, contentType);
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
      return createHttpImageRepresentation(normalized.data, "image/png");
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
  const pathname = req.url ? new URL(req.url, "http://localhost").pathname : undefined;
  const pluginRequest = parseControlUiResourcePath("pluginIcon", pathname, opts.basePath);
  const catalogRequest = parseControlUiResourcePath("catalogIcon", pathname, opts.basePath);
  const faviconRequest = parseControlUiResourcePath("linkFavicon", pathname, opts.basePath);
  if (!pluginRequest.matched && !catalogRequest.matched && !faviconRequest.matched) {
    return false;
  }
  const pluginId =
    pluginRequest.matched && pluginRequest.value && PLUGIN_ID_RE.test(pluginRequest.value)
      ? pluginRequest.value
      : null;
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
  const requestAuth = await authorizeControlUiReadRequestOrReply({
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

  sendHttpImageResponse({
    req,
    res,
    image: icon,
    filename: faviconHostname ? "link-favicon" : "plugin-icon",
  });
  return true;
}
