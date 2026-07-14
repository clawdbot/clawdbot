// Capability-token helpers for plugin-hosted node surfaces.
import { randomBytes } from "node:crypto";
import {
  asDateTimestampMs,
  asPositiveSafeInteger,
  isFutureDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "@openclaw/normalization-core/number-coercion";
import { safeEqualSecret } from "../security/secret-equal.js";

/** Path marker used to scope plugin-hosted node URLs with one-time capabilities. */
export const PLUGIN_NODE_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const PLUGIN_NODE_CAPABILITY_QUERY_PARAM = "oc_cap";
/** Default lifetime for plugin-node capability tokens. */
export const DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS = 10 * 60_000;

/** Declared plugin surface that may receive scoped node capabilities. */
export type PluginNodeCapabilitySurface = {
  surface: string;
  ttlMs?: number;
  scopeKey?: string;
};

/** Client-side storage for surface URLs and minted plugin-node capabilities. */
export type PluginNodeCapabilityClient = {
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, { capability: string; expiresAtMs: number }>;
};

/** Index surfaces by normalized surface id, keeping the strictest TTL per surface. */
export function indexPluginNodeCapabilitySurfaces(
  surfaces: readonly PluginNodeCapabilitySurface[],
): Record<string, PluginNodeCapabilitySurface> {
  const indexed: Record<string, PluginNodeCapabilitySurface> = {};
  for (const entry of surfaces) {
    const surface = normalizeSurface(entry.surface);
    if (!surface) {
      continue;
    }
    const existing = indexed[surface];
    const next = { ...entry, surface };
    if (
      !existing ||
      resolvePluginNodeCapabilityTtlMs(next) < resolvePluginNodeCapabilityTtlMs(existing)
    ) {
      indexed[surface] = next;
    }
  }
  return indexed;
}

/** Parsed URL details after extracting path/query capability tokens. */
export type NormalizedPluginNodeCapabilityUrl = {
  pathname: string;
  capability?: string;
  rewrittenUrl?: string;
  scopedPath: boolean;
  malformedScopedPath: boolean;
};

function normalizeCapability(raw: string | null | undefined) {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeSurface(raw: string | undefined) {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

function resolvePluginNodeCapabilityStorageKey(surface: PluginNodeCapabilitySurface) {
  const normalizedSurface = normalizeSurface(surface.surface);
  if (!normalizedSurface) {
    return undefined;
  }
  const scopeKey = surface.scopeKey?.trim();
  return scopeKey ? `${normalizedSurface}\0${scopeKey}` : normalizedSurface;
}

/** Resolve a positive TTL for a plugin-node capability surface. */
export function resolvePluginNodeCapabilityTtlMs(surface: PluginNodeCapabilitySurface) {
  return asPositiveSafeInteger(surface.ttlMs) ?? DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;
}

/** Resolve the expiration timestamp for a capability minted against a surface. */
export function resolvePluginNodeCapabilityExpiresAtMs(
  surface: PluginNodeCapabilitySurface,
  nowMs: number = Date.now(),
): number | undefined {
  return resolveExpiresAtMsFromDurationMs(resolvePluginNodeCapabilityTtlMs(surface), { nowMs });
}

/** Mint an opaque capability token for plugin-node surface access. */
export function mintPluginNodeCapabilityToken(): string {
  return randomBytes(18).toString("base64url");
}

/** Append a capability path segment to a plugin host URL. */
export function buildPluginNodeCapabilityScopedHostUrl(
  baseUrl: string,
  capability: string,
): string | undefined {
  const normalizedCapability = normalizeCapability(capability);
  if (!normalizedCapability) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`;
    url.pathname = `${trimmedPath}${prefix}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Replace the capability segment in an already scoped host URL. */
function replacePluginNodeCapabilityInScopedHostUrl(
  scopedUrl: string,
  capability: string,
): string | undefined {
  const normalizedCapability = normalizeCapability(capability);
  if (!normalizedCapability) {
    return undefined;
  }
  try {
    const url = new URL(scopedUrl);
    const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/`;
    const markerStart = url.pathname.indexOf(prefix);
    if (markerStart < 0) {
      return buildPluginNodeCapabilityScopedHostUrl(scopedUrl, normalizedCapability);
    }
    const capabilityStart = markerStart + prefix.length;
    const nextSlashIndex = url.pathname.indexOf("/", capabilityStart);
    const capabilityEnd = nextSlashIndex >= 0 ? nextSlashIndex : url.pathname.length;
    if (capabilityEnd <= capabilityStart) {
      return undefined;
    }
    url.pathname =
      url.pathname.slice(0, capabilityStart) +
      encodeURIComponent(normalizedCapability) +
      url.pathname.slice(capabilityEnd);
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

/** Parse and rewrite scoped capability URLs into canonical paths plus query tokens. */
export function normalizePluginNodeCapabilityScopedUrl(
  rawUrl: string,
): NormalizedPluginNodeCapabilityUrl {
  let url: URL;
  try {
    url = new URL(rawUrl, "http://localhost");
  } catch {
    return {
      pathname: "/",
      scopedPath: false,
      malformedScopedPath: true,
    };
  }
  const prefix = `${PLUGIN_NODE_CAPABILITY_PATH_PREFIX}/`;
  let scopedPath = false;
  let malformedScopedPath = false;
  let capabilityFromPath: string | undefined;
  let rewrittenUrl: string | undefined;

  if (url.pathname.startsWith(prefix)) {
    scopedPath = true;
    const remainder = url.pathname.slice(prefix.length);
    const slashIndex = remainder.indexOf("/");
    if (slashIndex <= 0) {
      malformedScopedPath = true;
    } else {
      const encodedCapability = remainder.slice(0, slashIndex);
      const canonicalPath = remainder.slice(slashIndex) || "/";
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(encodedCapability);
      } catch {
        malformedScopedPath = true;
      }
      capabilityFromPath = normalizeCapability(decoded);
      if (!capabilityFromPath || !canonicalPath.startsWith("/")) {
        malformedScopedPath = true;
      } else {
        url.pathname = canonicalPath;
        // The path is the minted node URL. A copied stale query must never
        // override the capability the current scoped path authorizes.
        url.searchParams.set(PLUGIN_NODE_CAPABILITY_QUERY_PARAM, capabilityFromPath);
        rewrittenUrl = `${url.pathname}${url.search}`;
      }
    }
  }

  const capability =
    capabilityFromPath ??
    normalizeCapability(url.searchParams.get(PLUGIN_NODE_CAPABILITY_QUERY_PARAM));
  return {
    pathname: url.pathname,
    capability,
    rewrittenUrl,
    scopedPath,
    malformedScopedPath,
  };
}

/** Store a minted capability on a client under the surface/scope storage key. */
export function setClientPluginNodeCapability(params: {
  client: PluginNodeCapabilityClient;
  surface: PluginNodeCapabilitySurface;
  capability: string;
  expiresAtMs: number;
}) {
  const surface = normalizeSurface(params.surface.surface);
  const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
  const expiresAtMs = asDateTimestampMs(params.expiresAtMs);
  if (!surface || !storageKey || expiresAtMs === undefined) {
    return;
  }
  params.client.pluginNodeCapabilities ??= {};
  params.client.pluginNodeCapabilities[storageKey] = {
    capability: params.capability,
    expiresAtMs,
  };
}

export function refreshClientPluginNodeCapability(params: {
  client: PluginNodeCapabilityClient;
  surface: PluginNodeCapabilitySurface;
  nowMs?: number;
}):
  | {
      surface: string;
      capability: string;
      expiresAtMs: number;
      scopedUrl: string;
    }
  | undefined {
  const surface = normalizeSurface(params.surface.surface);
  if (!surface) {
    return undefined;
  }
  const existingUrl = params.client.pluginSurfaceUrls?.[surface];
  if (!existingUrl) {
    return undefined;
  }
  const capabilitySurface = params.client.pluginNodeCapabilitySurfaces?.[surface] ?? params.surface;
  const capability = mintPluginNodeCapabilityToken();
  const nowMs = params.nowMs ?? Date.now();
  const expiresAtMs = resolvePluginNodeCapabilityExpiresAtMs(capabilitySurface, nowMs);
  if (expiresAtMs === undefined) {
    return undefined;
  }
  const scopedUrl = replacePluginNodeCapabilityInScopedHostUrl(existingUrl, capability);
  if (!scopedUrl) {
    return undefined;
  }
  params.client.pluginSurfaceUrls ??= {};
  params.client.pluginSurfaceUrls[surface] = scopedUrl;
  setClientPluginNodeCapability({
    client: params.client,
    surface: capabilitySurface,
    capability,
    expiresAtMs,
  });
  return {
    surface,
    capability,
    expiresAtMs,
    scopedUrl,
  };
}

export function hasAuthorizedPluginNodeCapability(params: {
  clients: Iterable<PluginNodeCapabilityClient>;
  surface: PluginNodeCapabilitySurface;
  capability: string;
  nowMs?: number;
}) {
  const surface = normalizeSurface(params.surface.surface);
  const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
  if (!surface || !storageKey) {
    return false;
  }
  const nowMs = params.nowMs ?? Date.now();
  const nextExpiresAtMs = resolvePluginNodeCapabilityExpiresAtMs(params.surface, nowMs);
  if (nextExpiresAtMs === undefined) {
    return false;
  }
  for (const client of params.clients) {
    const entry = client.pluginNodeCapabilities?.[storageKey];
    if (!entry || !isFutureDateTimestampMs(entry.expiresAtMs, { nowMs })) {
      continue;
    }
    if (safeEqualSecret(entry.capability, params.capability)) {
      entry.expiresAtMs = nextExpiresAtMs;
      return true;
    }
  }
  return false;
}
