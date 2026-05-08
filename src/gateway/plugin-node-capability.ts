import { randomBytes } from "node:crypto";
import { safeEqualSecret } from "../security/secret-equal.js";

export const PLUGIN_NODE_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const PLUGIN_NODE_CAPABILITY_QUERY_PARAM = "oc_cap";
export const DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS = 10 * 60_000;

export type PluginNodeCapabilitySurface = {
  surface: string;
  ttlMs?: number;
  scopeKey?: string;
};

export type PluginNodeCapabilityClient = {
  pluginSurfaceUrls?: Record<string, string>;
  pluginNodeCapabilitySurfaces?: Record<string, PluginNodeCapabilitySurface>;
  pluginNodeCapabilities?: Record<string, { capability: string; expiresAtMs: number }>;
};

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

export function resolvePluginNodeCapabilityTtlMs(surface: PluginNodeCapabilitySurface) {
  return surface.ttlMs && surface.ttlMs > 0 ? surface.ttlMs : DEFAULT_PLUGIN_NODE_CAPABILITY_TTL_MS;
}

export function mintPluginNodeCapabilityToken(): string {
  return randomBytes(18).toString("base64url");
}

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

export function replacePluginNodeCapabilityInScopedHostUrl(
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

export function normalizePluginNodeCapabilityScopedUrl(
  rawUrl: string,
): NormalizedPluginNodeCapabilityUrl {
  const url = new URL(rawUrl, "http://localhost");
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
        if (!url.searchParams.has(PLUGIN_NODE_CAPABILITY_QUERY_PARAM)) {
          url.searchParams.set(PLUGIN_NODE_CAPABILITY_QUERY_PARAM, capabilityFromPath);
        }
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

export function setClientPluginNodeCapability(params: {
  client: PluginNodeCapabilityClient;
  surface: PluginNodeCapabilitySurface;
  capability: string;
  expiresAtMs: number;
}) {
  const surface = normalizeSurface(params.surface.surface);
  const storageKey = resolvePluginNodeCapabilityStorageKey(params.surface);
  if (!surface || !storageKey) {
    return;
  }
  params.client.pluginNodeCapabilities ??= {};
  params.client.pluginNodeCapabilities[storageKey] = {
    capability: params.capability,
    expiresAtMs: params.expiresAtMs,
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
  const expiresAtMs = nowMs + resolvePluginNodeCapabilityTtlMs(capabilitySurface);
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
  const ttlMs = resolvePluginNodeCapabilityTtlMs(params.surface);
  for (const client of params.clients) {
    const entry = client.pluginNodeCapabilities?.[storageKey];
    if (!entry || entry.expiresAtMs <= nowMs) {
      continue;
    }
    if (safeEqualSecret(entry.capability, params.capability)) {
      entry.expiresAtMs = nowMs + ttlMs;
      return true;
    }
  }
  return false;
}
