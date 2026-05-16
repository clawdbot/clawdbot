import {
  type DeviceAuthEntry,
  type DeviceAuthStore,
  normalizeDeviceAuthRole,
  normalizeDeviceAuthScopes,
} from "./device-auth.js";
export type { DeviceAuthEntry, DeviceAuthStore } from "./device-auth.js";

export type DeviceAuthStoreAdapter = {
  readStore: () => DeviceAuthStore | null;
  writeStore: (store: DeviceAuthStore) => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

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
