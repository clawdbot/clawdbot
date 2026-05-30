import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { loadJsonFile } from "openclaw/plugin-sdk/json-store";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  releaseFeishuMessageProcessing,
  tryBeginFeishuMessageProcessing,
} from "./processing-claims.js";
import { getFeishuRuntime } from "./runtime.js";

// Persistent TTL: 24 hours — survives restarts & WebSocket reconnects.
const DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
const MEMORY_MAX_SIZE = 1_000;
const STORE_MAX_ENTRIES = 10_000;
type FeishuDedupStoreEntry = {
  namespace: string;
  messageId: string;
  seenAt: number;
};

const memory = new Map<string, number>();
const importedLegacyNamespaces = new Set<string>();
const cachedDedupStores = new Map<string, PluginStateSyncKeyedStore<FeishuDedupStoreEntry>>();

type LegacyDedupeData = Record<string, number>;

function normalizeMessageId(messageId: string | undefined | null): string | null {
  const trimmed = messageId?.trim();
  return trimmed ? trimmed : null;
}

function normalizeNamespace(namespace?: string): string {
  return namespace?.trim() || "global";
}

function resolveLegacyStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return stateOverride;
  }
  if (env.VITEST || env.NODE_ENV === "test") {
    return path.join(os.tmpdir(), ["openclaw-vitest", String(process.pid)].join("-"));
  }
  return path.join(os.homedir(), ".openclaw");
}

function resolveLegacyNamespaceFilePath(namespace: string): string {
  const safe = namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(resolveLegacyStateDir(), "feishu", "dedup", `${safe}.json`);
}

function pluginStateNamespace(namespace: string): string {
  return `dedup.${namespace.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}

function openDedupStore(namespace: string): PluginStateSyncKeyedStore<FeishuDedupStoreEntry> {
  const stateNamespace = pluginStateNamespace(namespace);
  const cached = cachedDedupStores.get(stateNamespace);
  if (cached) {
    return cached;
  }
  const store = getFeishuRuntime().state.openSyncKeyedStore<FeishuDedupStoreEntry>({
    namespace: stateNamespace,
    maxEntries: STORE_MAX_ENTRIES,
    defaultTtlMs: DEDUP_TTL_MS,
  });
  cachedDedupStores.set(stateNamespace, store);
  return store;
}

function dedupeStoreKey(namespace: string, messageId: string): string {
  return createHash("sha256")
    .update(`${namespace}\0${messageId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function memoryKey(namespace: string, messageId: string): string {
  return `${namespace}\0${messageId}`;
}

function isRecent(seenAt: number | undefined, now = Date.now()): boolean {
  return typeof seenAt === "number" && Number.isFinite(seenAt) && now - seenAt < DEDUP_TTL_MS;
}

function pruneMemory(now = Date.now()): void {
  for (const [key, seenAt] of memory) {
    if (!isRecent(seenAt, now)) {
      memory.delete(key);
    }
  }
  if (memory.size <= MEMORY_MAX_SIZE) {
    return;
  }
  const toRemove = Array.from(memory.entries())
    .toSorted(([, left], [, right]) => left - right)
    .slice(0, memory.size - MEMORY_MAX_SIZE);
  for (const [key] of toRemove) {
    memory.delete(key);
  }
}

function remember(namespace: string, messageId: string, seenAt = Date.now()): void {
  memory.set(memoryKey(namespace, messageId), seenAt);
  pruneMemory(seenAt);
}

function hasMemory(namespace: string, messageId: string, now = Date.now()): boolean {
  const key = memoryKey(namespace, messageId);
  const seenAt = memory.get(key);
  if (isRecent(seenAt, now)) {
    return true;
  }
  memory.delete(key);
  return false;
}

function sanitizeLegacyDedupeData(value: unknown): LegacyDedupeData {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const out: LegacyDedupeData = {};
  for (const [key, seenAt] of Object.entries(value as Record<string, unknown>)) {
    if (typeof seenAt === "number" && Number.isFinite(seenAt) && seenAt > 0) {
      out[key] = seenAt;
    }
  }
  return out;
}

function importLegacyDedupNamespace(
  namespace: string,
  now = Date.now(),
  log?: (...args: unknown[]) => void,
): void {
  if (importedLegacyNamespaces.has(namespace)) {
    return;
  }

  try {
    const data = sanitizeLegacyDedupeData(loadJsonFile(resolveLegacyNamespaceFilePath(namespace)));
    const store = openDedupStore(namespace);
    for (const [messageId, seenAt] of Object.entries(data)) {
      if (!isRecent(seenAt, now)) {
        continue;
      }
      const key = dedupeStoreKey(namespace, messageId);
      if (store.lookup(key) != null) {
        continue;
      }
      store.register(
        key,
        { namespace, messageId, seenAt },
        { ttlMs: Math.max(1, DEDUP_TTL_MS - (now - seenAt)) },
      );
    }
    importedLegacyNamespaces.add(namespace);
  } catch (error) {
    importedLegacyNamespaces.delete(namespace);
    log?.(`feishu-dedup: legacy state import failed: ${String(error)}`);
  }
}

export { releaseFeishuMessageProcessing, tryBeginFeishuMessageProcessing };

export async function claimUnprocessedFeishuMessage(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
}): Promise<"claimed" | "duplicate" | "inflight" | "invalid"> {
  const { messageId, namespace = "global", log } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return "invalid";
  }
  if (await hasProcessedFeishuMessage(normalizedMessageId, namespace, log)) {
    return "duplicate";
  }
  if (!tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return "inflight";
  }
  return "claimed";
}

export async function finalizeFeishuMessageProcessing(params: {
  messageId: string | undefined | null;
  namespace?: string;
  log?: (...args: unknown[]) => void;
  claimHeld?: boolean;
}): Promise<boolean> {
  const { messageId, namespace = "global", log, claimHeld = false } = params;
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  if (!claimHeld && !tryBeginFeishuMessageProcessing(normalizedMessageId, namespace)) {
    return false;
  }
  if (!(await tryRecordMessagePersistent(normalizedMessageId, namespace, log))) {
    releaseFeishuMessageProcessing(normalizedMessageId, namespace);
    return false;
  }
  return true;
}

export async function recordProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  return await tryRecordMessagePersistent(normalizedMessageId, namespace, log);
}

export async function forgetProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  memory.delete(memoryKey(normalizedNamespace, normalizedMessageId));
  const key = dedupeStoreKey(normalizedNamespace, normalizedMessageId);
  try {
    return openDedupStore(normalizedNamespace).delete(key);
  } catch (error) {
    log?.(`feishu-dedup: persistent delete failed: ${String(error)}`);
    return false;
  }
}

export async function hasProcessedFeishuMessage(
  messageId: string | undefined | null,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  return hasRecordedMessagePersistent(normalizedMessageId, namespace, log);
}

export async function tryRecordMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return true;
  }
  const now = Date.now();
  importLegacyDedupNamespace(normalizedNamespace, now, log);
  if (hasMemory(normalizedNamespace, normalizedMessageId, now)) {
    return false;
  }
  const key = dedupeStoreKey(normalizedNamespace, normalizedMessageId);
  try {
    const store = openDedupStore(normalizedNamespace);
    const existing = store.lookup(key);
    const existingSeenAt = existing?.seenAt;
    if (isRecent(existingSeenAt, now)) {
      remember(normalizedNamespace, normalizedMessageId, existingSeenAt);
      return false;
    }
    const recorded = store.registerIfAbsent(
      key,
      {
        namespace: normalizedNamespace,
        messageId: normalizedMessageId,
        seenAt: now,
      },
      { ttlMs: DEDUP_TTL_MS },
    );
    if (!recorded) {
      const current = store.lookup(key);
      const currentSeenAt = current?.seenAt;
      if (isRecent(currentSeenAt, now)) {
        remember(normalizedNamespace, normalizedMessageId, currentSeenAt);
        return false;
      }
      store.register(
        key,
        {
          namespace: normalizedNamespace,
          messageId: normalizedMessageId,
          seenAt: now,
        },
        { ttlMs: DEDUP_TTL_MS },
      );
    }
    remember(normalizedNamespace, normalizedMessageId, now);
    return true;
  } catch (error) {
    log?.(`feishu-dedup: persistent state error, falling back to memory: ${String(error)}`);
    remember(normalizedNamespace, normalizedMessageId, now);
    return true;
  }
}

async function hasRecordedMessagePersistent(
  messageId: string,
  namespace = "global",
  log?: (...args: unknown[]) => void,
): Promise<boolean> {
  const normalizedNamespace = normalizeNamespace(namespace);
  const normalizedMessageId = normalizeMessageId(messageId);
  if (!normalizedMessageId) {
    return false;
  }
  const now = Date.now();
  importLegacyDedupNamespace(normalizedNamespace, now, log);
  if (hasMemory(normalizedNamespace, normalizedMessageId, now)) {
    return true;
  }
  try {
    const store = openDedupStore(normalizedNamespace);
    const existing = store.lookup(dedupeStoreKey(normalizedNamespace, normalizedMessageId));
    const existingSeenAt = existing?.seenAt;
    if (!isRecent(existingSeenAt, now)) {
      return false;
    }
    remember(normalizedNamespace, normalizedMessageId, existingSeenAt);
    return true;
  } catch (error) {
    log?.(`feishu-dedup: persistent peek failed: ${String(error)}`);
    return hasMemory(normalizedNamespace, normalizedMessageId, now);
  }
}

export async function warmupDedupFromDisk(
  namespace: string,
  log?: (...args: unknown[]) => void,
): Promise<number> {
  const normalizedNamespace = normalizeNamespace(namespace);
  try {
    let loaded = 0;
    const now = Date.now();
    importLegacyDedupNamespace(normalizedNamespace, now, log);
    for (const entry of openDedupStore(normalizedNamespace).entries()) {
      if (entry.value.namespace !== normalizedNamespace || !isRecent(entry.value.seenAt, now)) {
        continue;
      }
      remember(normalizedNamespace, entry.value.messageId, entry.value.seenAt);
      loaded++;
    }
    return loaded;
  } catch (error) {
    log?.(`feishu-dedup: warmup persistent state error: ${String(error)}`);
    return 0;
  }
}

export const testingHooks = {
  resetFeishuDedupForTests() {
    memory.clear();
    importedLegacyNamespaces.clear();
    for (const store of cachedDedupStores.values()) {
      store.clear();
    }
    cachedDedupStores.clear();
  },
  resetFeishuDedupMemoryForTests() {
    memory.clear();
  },
};
