import { gatewayCredentialScope } from "@openclaw/gateway-client/browser";
import { safeParseJson } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getSafeLocalStorage } from "../local-storage.ts";

export const GATEWAY_REGISTRY_STORAGE_KEY = "openclaw.control.gateway-registry.v1";

export type GatewayProfile = {
  id: string;
  name: string;
  url: string;
};

export type GatewayRegistry = {
  gateways: GatewayProfile[];
  activeGatewayId: string | null;
};

type PersistedGatewayRegistry = {
  gateways?: unknown;
  activeGatewayId?: unknown;
};

const MAX_GATEWAY_NAME_LENGTH = 80;
export const GATEWAY_REGISTRY_MAX_PROFILES = 20;

export class GatewayRegistryPersistenceError extends Error {
  constructor() {
    super("Gateway registry could not be persisted");
    this.name = "GatewayRegistryPersistenceError";
  }
}

function defaultGatewayName(url: string): string {
  try {
    return new URL(url).hostname || "Gateway";
  } catch {
    return "Gateway";
  }
}

function normalizeGatewayName(name: unknown, url: string): string {
  const normalized = normalizeOptionalString(name)?.slice(0, MAX_GATEWAY_NAME_LENGTH);
  return normalized || defaultGatewayName(url);
}

/** Normalize a user-entered Gateway WebSocket URL without retaining fragments. */
export function normalizeGatewayUrl(value: unknown): string | null {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return null;
  }
  try {
    const parsed = new URL(raw, globalThis.location?.href);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      return null;
    }
    const pathname = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/u, "");
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

export function gatewayProfileId(url: string): string {
  return gatewayCredentialScope(url);
}

export function createGatewayProfile(input: {
  name?: unknown;
  url: unknown;
}): GatewayProfile | null {
  const url = normalizeGatewayUrl(input.url);
  if (!url) {
    return null;
  }
  return {
    id: gatewayProfileId(url),
    name: normalizeGatewayName(input.name, url),
    url,
  };
}

function normalizePersistedGateway(value: unknown): GatewayProfile | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as { name?: unknown; url?: unknown; gatewayUrl?: unknown };
  return createGatewayProfile({ name: record.name, url: record.url ?? record.gatewayUrl });
}

function deduplicateGateways(gateways: GatewayProfile[]): GatewayProfile[] {
  const seen = new Set<string>();
  return gateways.filter((gateway) => {
    if (seen.has(gateway.id)) {
      return false;
    }
    seen.add(gateway.id);
    return true;
  });
}

function fallbackGatewayProfile(url: string, name?: unknown): GatewayProfile | null {
  return createGatewayProfile({ url, name });
}

function readStoredRegistry(): GatewayRegistry | null {
  try {
    const raw = getSafeLocalStorage()?.getItem(GATEWAY_REGISTRY_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = safeParseJson(raw) as PersistedGatewayRegistry | undefined;
    if (!parsed || !Array.isArray(parsed.gateways)) {
      return null;
    }
    const gateways = deduplicateGateways(
      parsed.gateways
        .map(normalizePersistedGateway)
        .filter((value): value is GatewayProfile => value !== null),
    ).slice(0, GATEWAY_REGISTRY_MAX_PROFILES);
    const activeGatewayId =
      typeof parsed.activeGatewayId === "string" &&
      gateways.some((gateway) => gateway.id === parsed.activeGatewayId)
        ? parsed.activeGatewayId
        : (gateways[0]?.id ?? null);
    return { gateways, activeGatewayId };
  } catch {
    return null;
  }
}

function normalizedRegistry(registry: GatewayRegistry): GatewayRegistry {
  const gateways = deduplicateGateways(
    registry.gateways
      .map((gateway) => normalizePersistedGateway(gateway))
      .filter((value): value is GatewayProfile => value !== null),
  ).slice(0, GATEWAY_REGISTRY_MAX_PROFILES);
  return {
    gateways,
    activeGatewayId:
      registry.activeGatewayId &&
      gateways.some((gateway) => gateway.id === registry.activeGatewayId)
        ? registry.activeGatewayId
        : (gateways[0]?.id ?? null),
  };
}

export function loadGatewayRegistry(fallback?: { url: string; name?: unknown }): GatewayRegistry {
  const stored = readStoredRegistry();
  const fallbackProfile = fallbackGatewayProfile(fallback?.url ?? "", fallback?.name);
  if (!stored) {
    return fallbackProfile
      ? { gateways: [fallbackProfile], activeGatewayId: fallbackProfile.id }
      : { gateways: [], activeGatewayId: null };
  }
  if (!fallbackProfile || stored.gateways.some((gateway) => gateway.id === fallbackProfile.id)) {
    return stored;
  }
  return {
    gateways: [...stored.gateways, fallbackProfile].slice(0, GATEWAY_REGISTRY_MAX_PROFILES),
    activeGatewayId: stored.activeGatewayId,
  };
}

/** Load the shared profile list while marking the gateway serving this view active. */
export function loadGatewayRegistryForGateway(url: string): GatewayRegistry {
  const registry = loadGatewayRegistry({ url });
  const activeGatewayId = gatewayProfileId(url);
  return registry.gateways.some((gateway) => gateway.id === activeGatewayId)
    ? { ...registry, activeGatewayId }
    : registry;
}

export function saveGatewayRegistry(registry: GatewayRegistry): GatewayRegistry {
  const normalized = normalizedRegistry(registry);
  const serialized = JSON.stringify(normalized);
  try {
    const storage = getSafeLocalStorage();
    if (!storage) {
      throw new GatewayRegistryPersistenceError();
    }
    storage.setItem(GATEWAY_REGISTRY_STORAGE_KEY, serialized);
    if (storage.getItem(GATEWAY_REGISTRY_STORAGE_KEY) !== serialized) {
      throw new GatewayRegistryPersistenceError();
    }
  } catch {
    throw new GatewayRegistryPersistenceError();
  }
  return normalized;
}

export function upsertGatewayProfile(
  profile: GatewayProfile,
  options: { select?: boolean } = {},
): GatewayRegistry {
  const current = loadGatewayRegistry(profile);
  const existing = current.gateways.some((gateway) => gateway.id === profile.id);
  if (!existing && current.gateways.length >= GATEWAY_REGISTRY_MAX_PROFILES) {
    return current;
  }
  const gateways = existing
    ? current.gateways.map((gateway) => (gateway.id === profile.id ? profile : gateway))
    : [...current.gateways, profile];
  return saveGatewayRegistry({
    gateways,
    activeGatewayId: options.select ? profile.id : current.activeGatewayId,
  });
}

export function selectGatewayProfile(id: string, fallback?: { url: string }): GatewayRegistry {
  const current = loadGatewayRegistry(fallback);
  if (!current.gateways.some((gateway) => gateway.id === id)) {
    return current;
  }
  return saveGatewayRegistry({ ...current, activeGatewayId: id });
}

export function removeGatewayProfile(id: string, fallback?: { url: string }): GatewayRegistry {
  const current = loadGatewayRegistry(fallback);
  const gateways = current.gateways.filter((gateway) => gateway.id !== id);
  return saveGatewayRegistry({
    gateways,
    activeGatewayId:
      current.activeGatewayId === id ? (gateways[0]?.id ?? null) : current.activeGatewayId,
  });
}
