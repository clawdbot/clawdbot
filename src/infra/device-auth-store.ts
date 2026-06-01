import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import {
  clearDeviceAuthTokenFromStore,
  coerceDeviceAuthStore,
  type DeviceAuthEntry,
  type DeviceAuthStore,
  loadDeviceAuthTokenFromStore,
  storeDeviceAuthTokenInStore,
} from "../shared/device-auth-store.js";
import { privateFileStoreSync } from "./private-file-store.js";

const DEVICE_AUTH_FILE = "device-auth.json";

type StoreCacheEntry = { store: DeviceAuthStore | null; mtimeMs: number; size: number };
const storeReadCache = new Map<string, StoreCacheEntry>();

function storeCacheHit(
  cached: StoreCacheEntry | undefined,
  stat: { mtimeMs: number; size: number },
): boolean {
  return cached !== undefined && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size;
}

function resolveDeviceAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveStateDir(env), "identity", DEVICE_AUTH_FILE);
}

function readStore(filePath: string): DeviceAuthStore | null {
  try {
    let stat: fs.Stats | null = null;
    try {
      stat = fs.statSync(filePath);
    } catch {
      const cached = storeReadCache.get(filePath);
      if (cached?.mtimeMs === -1 && cached.size === -1) {
        return cached.store;
      }
      storeReadCache.set(filePath, { store: null, mtimeMs: -1, size: -1 });
      return null;
    }
    const cached = storeReadCache.get(filePath);
    if (cached !== undefined && storeCacheHit(cached, stat)) {
      // Device auth is read during gateway reconnects; cache by file metadata to avoid rereads.
      return cached.store;
    }
    const parsed = privateFileStoreSync(path.dirname(filePath)).readJsonIfExists(
      path.basename(filePath),
    );
    const store = coerceDeviceAuthStore(parsed);
    storeReadCache.set(filePath, { store, mtimeMs: stat.mtimeMs, size: stat.size });
    return store;
  } catch {
    return null;
  }
}

function writeStore(filePath: string, store: DeviceAuthStore): void {
  privateFileStoreSync(path.dirname(filePath)).writeJson(path.basename(filePath), store, {
    trailingNewline: true,
  });
  try {
    const stat = fs.statSync(filePath);
    storeReadCache.set(filePath, { store, mtimeMs: stat.mtimeMs, size: stat.size });
  } catch {
    storeReadCache.delete(filePath);
  }
}

/** Load a cached device-auth token from the configured OpenClaw state directory. */
export function loadDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry | null {
  const filePath = resolveDeviceAuthPath(params.env);
  return loadDeviceAuthTokenFromStore({
    adapter: { readStore: () => readStore(filePath), writeStore: (_store) => {} },
    deviceId: params.deviceId,
    role: params.role,
  });
}

/** Persist or replace one device-auth role token in the private state directory. */
export function storeDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  token: string;
  scopes?: string[];
  env?: NodeJS.ProcessEnv;
}): DeviceAuthEntry {
  const filePath = resolveDeviceAuthPath(params.env);
  return storeDeviceAuthTokenInStore({
    adapter: {
      readStore: () => readStore(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
    token: params.token,
    scopes: params.scopes,
  });
}

/** Remove one role token for the current gateway device from the private state directory. */
export function clearDeviceAuthToken(params: {
  deviceId: string;
  role: string;
  env?: NodeJS.ProcessEnv;
}): void {
  const filePath = resolveDeviceAuthPath(params.env);
  clearDeviceAuthTokenFromStore({
    adapter: {
      readStore: () => readStore(filePath),
      writeStore: (store) => writeStore(filePath, store),
    },
    deviceId: params.deviceId,
    role: params.role,
  });
}
