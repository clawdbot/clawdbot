import fs from "node:fs";
import { normalizeSessionDeliveryFields } from "../../utils/delivery-context.shared.js";
import { getFileStatSnapshot } from "../cache-utils.js";
import {
  isSessionStoreCacheEnabled,
  readSessionStoreCache,
  setSerializedSessionStore,
  writeSessionStoreCache,
} from "./store-cache.js";
import { applySessionStoreMigrations } from "./store-migrations.js";
import { normalizeSessionRuntimeModelFields, type SessionEntry } from "./types.js";

export type LoadSessionStoreOptions = {
  skipCache?: boolean;
};

function isSessionStoreRecord(value: unknown): value is Record<string, SessionEntry> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizeSessionEntryDelivery(entry: SessionEntry): SessionEntry {
  const normalized = normalizeSessionDeliveryFields({
    channel: entry.channel,
    lastChannel: entry.lastChannel,
    lastTo: entry.lastTo,
    lastAccountId: entry.lastAccountId,
    lastThreadId: entry.lastThreadId ?? entry.deliveryContext?.threadId ?? entry.origin?.threadId,
    deliveryContext: entry.deliveryContext,
  });
  const nextDelivery = normalized.deliveryContext;
  const sameDelivery =
    (entry.deliveryContext?.channel ?? undefined) === nextDelivery?.channel &&
    (entry.deliveryContext?.to ?? undefined) === nextDelivery?.to &&
    (entry.deliveryContext?.accountId ?? undefined) === nextDelivery?.accountId &&
    (entry.deliveryContext?.threadId ?? undefined) === nextDelivery?.threadId;
  const sameLast =
    entry.lastChannel === normalized.lastChannel &&
    entry.lastTo === normalized.lastTo &&
    entry.lastAccountId === normalized.lastAccountId &&
    entry.lastThreadId === normalized.lastThreadId;
  if (sameDelivery && sameLast) {
    return entry;
  }
  return {
    ...entry,
    deliveryContext: nextDelivery,
    lastChannel: normalized.lastChannel,
    lastTo: normalized.lastTo,
    lastAccountId: normalized.lastAccountId,
    lastThreadId: normalized.lastThreadId,
  };
}

export function normalizeSessionStore(store: Record<string, SessionEntry>): void {
  for (const [key, entry] of Object.entries(store)) {
    if (!entry) {
      continue;
    }
    const normalized = normalizeSessionEntryDelivery(normalizeSessionRuntimeModelFields(entry));
    if (normalized !== entry) {
      store[key] = normalized;
    }
  }
}

export function loadSessionStore(
  storePath: string,
  opts: LoadSessionStoreOptions = {},
): Record<string, SessionEntry> {
  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    const currentFileStat = getFileStatSnapshot(storePath);
    const cached = readSessionStoreCache({
      storePath,
      mtimeMs: currentFileStat?.mtimeMs,
      sizeBytes: currentFileStat?.sizeBytes,
    });
    if (cached) {
      return cached;
    }
  }

  // Retry a few times on Windows because readers can briefly observe empty or
  // transiently invalid content while another process is swapping the file.
  let store: Record<string, SessionEntry> = {};
  let fileStat = getFileStatSnapshot(storePath);
  let mtimeMs = fileStat?.mtimeMs;
  let serializedFromDisk: string | undefined;
  const maxReadAttempts = process.platform === "win32" ? 3 : 1;
  const retryBuf = maxReadAttempts > 1 ? new Int32Array(new SharedArrayBuffer(4)) : undefined;
  for (let attempt = 0; attempt < maxReadAttempts; attempt += 1) {
    try {
      const raw = fs.readFileSync(storePath, "utf-8");
      if (raw.length === 0 && attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
      const parsed = JSON.parse(raw);
      if (isSessionStoreRecord(parsed)) {
        store = parsed;
        serializedFromDisk = raw;
      }
      fileStat = getFileStatSnapshot(storePath) ?? fileStat;
      mtimeMs = fileStat?.mtimeMs;
      break;
    } catch {
      if (attempt < maxReadAttempts - 1) {
        Atomics.wait(retryBuf!, 0, 0, 50);
        continue;
      }
    }
  }

  if (serializedFromDisk !== undefined) {
    setSerializedSessionStore(storePath, serializedFromDisk);
  } else {
    setSerializedSessionStore(storePath, undefined);
  }

  applySessionStoreMigrations(store);
  normalizeSessionStore(store);

  if (!opts.skipCache && isSessionStoreCacheEnabled()) {
    writeSessionStoreCache({
      storePath,
      store,
      mtimeMs,
      sizeBytes: fileStat?.sizeBytes,
      serialized: serializedFromDisk,
    });
  }

  return structuredClone(store);
}
