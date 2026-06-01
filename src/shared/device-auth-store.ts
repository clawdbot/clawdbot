import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "./device-auth.js";
export type { DeviceAuthEntry, DeviceAuthStore } from "./device-auth.js";

/** Storage seam used by shared device-auth helpers and filesystem-backed infra wrappers. */
export type DeviceAuthStoreAdapter = {
  readStore: () => DeviceAuthStore | null;
  writeStore: (store: DeviceAuthStore) => void;
};

function coerceDeviceAuthEntry(role: string, value: unknown): DeviceAuthEntry | null {
  if (!isRecord(value) || typeof value.token !== "string") {
    return null;
  }
  const updatedAtMs =
    typeof value.updatedAtMs === "number" && Number.isFinite(value.updatedAtMs)
      ? value.updatedAtMs
      : 0;
  return {
    token: value.token,
    role,
    scopes: normalizeDeviceAuthScopes(Array.isArray(value.scopes) ? value.scopes : undefined),
    updatedAtMs,
  };
}

function copyCanonicalDeviceAuthTokens(
  tokens: Record<string, unknown>,
): Record<string, DeviceAuthEntry> {
  const out: Record<string, DeviceAuthEntry> = {};
  for (const [rawRole, value] of Object.entries(tokens)) {
    const role = normalizeDeviceAuthRole(rawRole);
    if (!role) {
      continue;
    }
    const entry = coerceDeviceAuthEntry(role, value);
    if (entry) {
      out[role] = entry;
    }
  }
  return out;
}

/** Coerces raw persisted device-auth JSON into the current canonical store shape. */
export function coerceDeviceAuthStore(value: unknown): DeviceAuthStore | null {
  if (!isRecord(value) || value.version !== 1 || typeof value.deviceId !== "string") {
    return null;
  }
  if (!isRecord(value.tokens)) {
    return null;
  }
  return {
    version: 1,
    deviceId: value.deviceId,
    tokens: copyCanonicalDeviceAuthTokens(value.tokens),
  };
}

/** Load one normalized role token, ignoring stores bound to a different gateway device id. */
export function loadDeviceAuthTokenFromStore(params: {
  adapter: DeviceAuthStoreAdapter;
  deviceId: string;
  role: string;
}): DeviceAuthEntry | null {
  const store = params.adapter.readStore();
  if (!store || store.deviceId !== params.deviceId) {
    return null;
  }
  const role = normalizeDeviceAuthRole(params.role);
  return coerceDeviceAuthEntry(role, store.tokens[role]);
}

/** Store one role token while preserving canonical tokens for the same gateway device id. */
export function storeDeviceAuthTokenInStore(params: {
  adapter: DeviceAuthStoreAdapter;
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
}): DeviceAuthEntry {
  const role = normalizeDeviceAuthRole(params.role);
  const existing = params.adapter.readStore();
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: params.deviceId,
    tokens:
      // Device-auth stores are scoped to one gateway device id; never merge stale
      // tokens copied from another gateway identity.
      existing && existing.deviceId === params.deviceId && existing.tokens
        ? copyCanonicalDeviceAuthTokens(existing.tokens)
        : {},
  };
  const entry: DeviceAuthEntry = {
    token: params.token,
    role,
    scopes: normalizeDeviceAuthScopes(params.scopes),
    updatedAtMs: Date.now(),
  };
  next.tokens[role] = entry;
  params.adapter.writeStore(next);
  return entry;
}

/** Clear one normalized role token without rewriting missing or wrong-device stores. */
export function clearDeviceAuthTokenFromStore(params: {
  adapter: DeviceAuthStoreAdapter;
  deviceId: string;
  role: string;
}): void {
  const store = params.adapter.readStore();
  if (!store || store.deviceId !== params.deviceId) {
    return;
  }
  const role = normalizeDeviceAuthRole(params.role);
  if (!store.tokens[role]) {
    return;
  }
  const next: DeviceAuthStore = {
    version: 1,
    deviceId: store.deviceId,
    tokens: copyCanonicalDeviceAuthTokens(store.tokens),
  };
  delete next.tokens[role];
  params.adapter.writeStore(next);
}
