import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Message } from "grammy/types";
import type {
  ClaimableDedupe,
  ClaimableDedupeClaimResult,
} from "openclaw/plugin-sdk/persistent-dedupe";
import type {
  PluginStateKeyedStore,
  PluginStateSyncKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getOptionalTelegramRuntime } from "./runtime.js";

const TELEGRAM_MESSAGE_DISPATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE = "telegram.message-dispatch-dedupe";
export const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES = 4_096;
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOGICAL_MAX_ENTRIES = 50_000;
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_BUCKET_COUNT = 256;
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_BUCKET_MAX_KEYS = 256;
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOCK_TTL_MS = 30_000;
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOCK_RETRY_MS = 10;
const TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOCK_ATTEMPTS = 50;

export type TelegramMessageDispatchReplayGuard = ClaimableDedupe;
type TelegramMessageDispatchDedupeRecord = {
  scopeKey: string;
  namespace: string;
  bucketId: string;
  entries: Record<string, number>;
};

type TelegramMessageDispatchDedupeStore =
  | PluginStateKeyedStore<TelegramMessageDispatchDedupeRecord>
  | PluginStateSyncKeyedStore<TelegramMessageDispatchDedupeRecord>;

type PendingClaim = {
  promise: Promise<boolean>;
  resolve: (result: boolean) => void;
  reject: (error: unknown) => void;
};

type MemoryCommittedClaim = {
  namespace: string;
  expiresAt: number;
};

let dispatchDedupeStoreForTest: TelegramMessageDispatchDedupeStore | undefined;

export type TelegramMessageDispatchClaim =
  | { kind: "claimed"; key: string }
  | { kind: "duplicate" }
  | { kind: "invalid" };

function openDispatchDedupeStore(): TelegramMessageDispatchDedupeStore | undefined {
  if (dispatchDedupeStoreForTest) {
    return dispatchDedupeStoreForTest;
  }
  return getOptionalTelegramRuntime()?.state.openKeyedStore<TelegramMessageDispatchDedupeRecord>({
    namespace: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_NAMESPACE,
    maxEntries: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_MAX_ENTRIES,
  });
}

function resolveDispatchScopeKey(storePath: string): string {
  return createHash("sha256").update(storePath, "utf8").digest("hex").slice(0, 24);
}

function dedupeEntryKey(scopeKey: string, namespace: string, key: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${namespace}\0${key}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function dedupeBucketId(key: string): string {
  const bucketIndex =
    Number.parseInt(createHash("sha256").update(key, "utf8").digest("hex").slice(0, 8), 16) %
    TELEGRAM_MESSAGE_DISPATCH_DEDUPE_BUCKET_COUNT;
  return bucketIndex.toString(16).padStart(2, "0");
}

function dedupeBucketEntryKey(scopeKey: string, namespace: string, bucketId: string): string {
  return createHash("sha256")
    .update(`${scopeKey}\0${namespace}\0${bucketId}`, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function dedupeLegacyBucketEntryKey(params: {
  scopeKey: string;
  namespace: string;
  bucketId: string;
  sourcePath: string;
}): string {
  const sourceKey = createHash("sha256")
    .update(params.sourcePath, "utf8")
    .digest("hex")
    .slice(0, 12);
  return dedupeBucketEntryKey(params.scopeKey, params.namespace, `${params.bucketId}:${sourceKey}`);
}

function dedupeBucketLockKey(bucketKey: string): string {
  return `${bucketKey}:lock`;
}

async function sleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function pruneDedupeBucketEntries(entries: Record<string, number>, now: number): void {
  for (const [key, timestamp] of Object.entries(entries)) {
    if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) {
      delete entries[key];
      continue;
    }
    if (now - timestamp >= TELEGRAM_MESSAGE_DISPATCH_TTL_MS) {
      delete entries[key];
    }
  }
  const keys = Object.keys(entries);
  if (keys.length <= TELEGRAM_MESSAGE_DISPATCH_DEDUPE_BUCKET_MAX_KEYS) {
    return;
  }
  for (const key of keys
    .toSorted((left, right) => entries[left] - entries[right])
    .slice(0, keys.length - TELEGRAM_MESSAGE_DISPATCH_DEDUPE_BUCKET_MAX_KEYS)) {
    delete entries[key];
  }
}

function createDedupeBucketRecord(params: {
  scopeKey: string;
  namespace: string;
  bucketId: string;
  entries?: Record<string, number>;
}): TelegramMessageDispatchDedupeRecord {
  return {
    scopeKey: params.scopeKey,
    namespace: params.namespace,
    bucketId: params.bucketId,
    entries: { ...params.entries },
  };
}

function normalizeDedupeBucketRecord(
  value: TelegramMessageDispatchDedupeRecord | undefined,
  params: {
    scopeKey: string;
    namespace: string;
    bucketId: string;
    now: number;
  },
): TelegramMessageDispatchDedupeRecord {
  const entries =
    value?.scopeKey === params.scopeKey &&
    value.namespace === params.namespace &&
    value.bucketId === params.bucketId &&
    value.entries &&
    typeof value.entries === "object"
      ? { ...value.entries }
      : {};
  pruneDedupeBucketEntries(entries, params.now);
  return createDedupeBucketRecord({
    scopeKey: params.scopeKey,
    namespace: params.namespace,
    bucketId: params.bucketId,
    entries,
  });
}

async function lookupDedupeBucketContains(params: {
  store: TelegramMessageDispatchDedupeStore;
  scopeKey: string;
  namespace: string;
  bucketId: string;
  bucketKey: string;
  key: string;
  now: number;
}): Promise<boolean> {
  const bucket = normalizeDedupeBucketRecord(await params.store.lookup(params.bucketKey), params);
  if (bucket.entries[params.key] !== undefined) {
    return true;
  }
  for (const entry of await params.store.entries()) {
    if (
      entry.key === params.bucketKey ||
      entry.value.scopeKey !== params.scopeKey ||
      entry.value.namespace !== params.namespace ||
      entry.value.bucketId !== params.bucketId
    ) {
      continue;
    }
    const legacyBucket = normalizeDedupeBucketRecord(entry.value, params);
    if (legacyBucket.entries[params.key] !== undefined) {
      return true;
    }
  }
  return false;
}

function sanitizeFileSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function resolveTelegramMessageDispatchLegacyPath(params: {
  storePath: string;
  namespace: string;
}): string {
  return path.join(
    path.dirname(params.storePath),
    `${path.basename(params.storePath)}.telegram-message-dispatch-${sanitizeFileSegment(
      params.namespace,
    )}.json`,
  );
}

export function buildTelegramMessageDispatchReplayKey(msg: Message): string | null {
  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  if (chatId == null || typeof messageId !== "number" || messageId <= 0) {
    return null;
  }
  return JSON.stringify(["message", String(chatId), messageId]);
}

export function createTelegramMessageDispatchReplayGuard(params: {
  storePath: string;
  onDiskError?: (error: unknown) => void;
}): TelegramMessageDispatchReplayGuard {
  const scopeKey = resolveDispatchScopeKey(params.storePath);
  const onStateError = params.onDiskError;
  let store: TelegramMessageDispatchDedupeStore | undefined;
  const inflight = new Map<string, PendingClaim>();
  const committedInMemory = new Map<string, MemoryCommittedClaim>();
  const bucketWriteQueue = new Map<string, Promise<void>>();

  function getStore(): TelegramMessageDispatchDedupeStore | undefined {
    if (store) {
      return store;
    }
    try {
      store = openDispatchDedupeStore();
      return store;
    } catch (error) {
      onStateError?.(error);
      return undefined;
    }
  }

  function pruneCommittedInMemory(now = Date.now()) {
    for (const [entryKey, entry] of committedInMemory) {
      if (
        entry.expiresAt <= now ||
        committedInMemory.size > TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOGICAL_MAX_ENTRIES
      ) {
        committedInMemory.delete(entryKey);
      }
    }
  }

  function rememberCommittedInMemory(entryKey: string, namespace: string, now: number) {
    committedInMemory.set(entryKey, {
      namespace,
      expiresAt: now + TELEGRAM_MESSAGE_DISPATCH_TTL_MS,
    });
    pruneCommittedInMemory(now);
  }

  function hasCommittedInMemory(entryKey: string, now = Date.now()): boolean {
    const entry = committedInMemory.get(entryKey);
    if (!entry) {
      return false;
    }
    if (entry.expiresAt <= now) {
      committedInMemory.delete(entryKey);
      return false;
    }
    return true;
  }

  function rememberPendingClaim(entryKey: string): PendingClaim {
    let resolve!: (result: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    const pending = { promise, resolve, reject };
    inflight.set(entryKey, pending);
    return pending;
  }

  function enqueueBucketWrite<T>(bucketKey: string, write: () => Promise<T>): Promise<T> {
    const previous = bucketWriteQueue.get(bucketKey) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(write);
    const queued = next.then(
      () => undefined,
      () => undefined,
    );
    bucketWriteQueue.set(bucketKey, queued);
    void queued.finally(() => {
      if (bucketWriteQueue.get(bucketKey) === queued) {
        bucketWriteQueue.delete(bucketKey);
      }
    });
    return next;
  }

  async function withBucketLock<T>(paramsLocal: {
    store: TelegramMessageDispatchDedupeStore;
    namespace: string;
    bucketId: string;
    bucketKey: string;
    write: () => Promise<T>;
  }): Promise<T> {
    const lockKey = dedupeBucketLockKey(paramsLocal.bucketKey);
    const lockValue = createDedupeBucketRecord({
      scopeKey,
      namespace: `${paramsLocal.namespace}:lock`,
      bucketId: paramsLocal.bucketId,
    });
    let locked = false;
    for (let attempt = 0; attempt < TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOCK_ATTEMPTS; attempt += 1) {
      if (
        await paramsLocal.store.registerIfAbsent(lockKey, lockValue, {
          ttlMs: TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOCK_TTL_MS,
        })
      ) {
        locked = true;
        break;
      }
      await sleep(TELEGRAM_MESSAGE_DISPATCH_DEDUPE_LOCK_RETRY_MS);
    }
    if (!locked) {
      throw new Error(
        `timed out acquiring Telegram dispatch dedupe bucket lock: ${paramsLocal.bucketId}`,
      );
    }
    try {
      return await paramsLocal.write();
    } finally {
      await paramsLocal.store.delete(lockKey);
    }
  }

  return {
    async claim(key, options): Promise<ClaimableDedupeClaimResult> {
      const namespace = options?.namespace?.trim() || "global";
      const entryKey = dedupeEntryKey(scopeKey, namespace, key);
      const bucketId = dedupeBucketId(key);
      const bucketKey = dedupeBucketEntryKey(scopeKey, namespace, bucketId);
      if (hasCommittedInMemory(entryKey)) {
        return { kind: "duplicate" };
      }
      const existing = inflight.get(entryKey);
      if (existing) {
        return { kind: "inflight", pending: existing.promise };
      }
      const pending = rememberPendingClaim(entryKey);
      const storeEntry = getStore();
      if (!storeEntry) {
        return { kind: "claimed" };
      }
      try {
        if (
          await lookupDedupeBucketContains({
            store: storeEntry,
            scopeKey,
            namespace,
            bucketId,
            bucketKey,
            key,
            now: Date.now(),
          })
        ) {
          pending.resolve(false);
          inflight.delete(entryKey);
          return { kind: "duplicate" };
        }
        return { kind: "claimed" };
      } catch (error) {
        onStateError?.(error);
        return { kind: "claimed" };
      }
    },
    async commit(key, options) {
      const namespace = options?.namespace?.trim() || "global";
      const now = options?.now ?? Date.now();
      const entryKey = dedupeEntryKey(scopeKey, namespace, key);
      const bucketId = dedupeBucketId(key);
      const bucketKey = dedupeBucketEntryKey(scopeKey, namespace, bucketId);
      const storeResult = getStore();
      if (!storeResult) {
        rememberCommittedInMemory(entryKey, namespace, now);
        inflight.get(entryKey)?.resolve(true);
        inflight.delete(entryKey);
        return false;
      }
      try {
        await enqueueBucketWrite(bucketKey, async () => {
          await withBucketLock({
            store: storeResult,
            namespace,
            bucketId,
            bucketKey,
            write: async () => {
              const bucket = normalizeDedupeBucketRecord(await storeResult.lookup(bucketKey), {
                scopeKey,
                namespace,
                bucketId,
                now,
              });
              bucket.entries[key] = now;
              pruneDedupeBucketEntries(bucket.entries, now);
              await storeResult.register(bucketKey, bucket, {
                ttlMs: TELEGRAM_MESSAGE_DISPATCH_TTL_MS,
              });
            },
          });
        });
        rememberCommittedInMemory(entryKey, namespace, now);
        inflight.get(entryKey)?.resolve(true);
        return true;
      } catch (error) {
        rememberCommittedInMemory(entryKey, namespace, now);
        inflight.get(entryKey)?.resolve(true);
        onStateError?.(error);
        return false;
      } finally {
        inflight.delete(entryKey);
      }
    },
    release(key, options) {
      const namespace = options?.namespace?.trim() || "global";
      const entryKey = dedupeEntryKey(scopeKey, namespace, key);
      const pending = inflight.get(entryKey);
      if (pending) {
        pending.reject(options?.error ?? new Error(`claim released before commit: ${namespace}`));
        inflight.delete(entryKey);
      }
    },
    async hasRecent(key, options) {
      const namespace = options?.namespace?.trim() || "global";
      const entryKey = dedupeEntryKey(scopeKey, namespace, key);
      const bucketId = dedupeBucketId(key);
      const bucketKey = dedupeBucketEntryKey(scopeKey, namespace, bucketId);
      if (hasCommittedInMemory(entryKey)) {
        return true;
      }
      const storeValue = getStore();
      if (!storeValue) {
        return false;
      }
      try {
        return await lookupDedupeBucketContains({
          store: storeValue,
          scopeKey,
          namespace,
          bucketId,
          bucketKey,
          key,
          now: Date.now(),
        });
      } catch (error) {
        onStateError?.(error);
        return false;
      }
    },
    async warmup(namespace = "global") {
      pruneCommittedInMemory();
      const memoryCount = [...committedInMemory.values()].filter(
        (entry) => entry.namespace === namespace,
      ).length;
      const storeLocal = getStore();
      if (!storeLocal) {
        return memoryCount;
      }
      try {
        const now = Date.now();
        const persistedCount = (await storeLocal.entries())
          .filter(
            (entry) => entry.value.scopeKey === scopeKey && entry.value.namespace === namespace,
          )
          .reduce((count, entry) => {
            const bucket = normalizeDedupeBucketRecord(entry.value, {
              scopeKey,
              namespace,
              bucketId: entry.value.bucketId,
              now,
            });
            return count + Object.keys(bucket.entries).length;
          }, 0);
        return persistedCount + memoryCount;
      } catch (error) {
        onStateError?.(error);
        return memoryCount;
      }
    },
    clearMemory() {
      inflight.clear();
      committedInMemory.clear();
    },
    memorySize() {
      pruneCommittedInMemory();
      return inflight.size + committedInMemory.size;
    },
  };
}

export async function claimTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  msg: Message;
}): Promise<TelegramMessageDispatchClaim> {
  const key = buildTelegramMessageDispatchReplayKey(params.msg);
  if (!key) {
    return { kind: "invalid" };
  }

  let releaseRetries = 0;
  while (true) {
    const claim = await params.guard.claim(key, { namespace: params.accountId });
    if (claim.kind === "claimed") {
      return { kind: "claimed", key };
    }
    if (claim.kind === "duplicate") {
      return { kind: "duplicate" };
    }
    try {
      await claim.pending;
      return { kind: "duplicate" };
    } catch {
      releaseRetries += 1;
      if (releaseRetries > 1) {
        return { kind: "duplicate" };
      }
    }
  }
}

function normalizeReplayKeys(keys?: readonly string[]): string[] {
  return uniqueStrings(normalizeStringEntries(keys ?? []));
}

export async function commitTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  keys?: readonly string[];
}): Promise<void> {
  const keys = normalizeReplayKeys(params.keys);
  await Promise.all(keys.map((key) => params.guard.commit(key, { namespace: params.accountId })));
}

export function releaseTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  keys?: readonly string[];
  error?: unknown;
}): void {
  const keys = normalizeReplayKeys(params.keys);
  for (const key of keys) {
    params.guard.release(key, { namespace: params.accountId, error: params.error });
  }
}

export function setTelegramMessageDispatchDedupeStoreForTest(
  store: TelegramMessageDispatchDedupeStore | undefined,
): void {
  dispatchDedupeStoreForTest = store;
}

export function listTelegramLegacyMessageDispatchDedupeEntries(params: {
  storePath: string;
  namespace: string;
  persistedPath?: string;
}): Array<{ key: string; value: TelegramMessageDispatchDedupeRecord; ttlMs?: number }> {
  const filePath = params.persistedPath ?? resolveTelegramMessageDispatchLegacyPath(params);
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const now = Date.now();
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") {
    return [];
  }
  const scopeKey = resolveDispatchScopeKey(params.storePath);
  const buckets = new Map<string, { value: TelegramMessageDispatchDedupeRecord; ttlMs: number }>();
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      continue;
    }
    const ttlMs = TELEGRAM_MESSAGE_DISPATCH_TTL_MS - Math.max(0, now - value);
    if (ttlMs <= 0) {
      continue;
    }
    const bucketId = dedupeBucketId(key);
    const bucketKey = dedupeLegacyBucketEntryKey({
      scopeKey,
      namespace: params.namespace,
      bucketId,
      sourcePath: filePath,
    });
    const bucket = buckets.get(bucketKey) ?? {
      value: createDedupeBucketRecord({
        scopeKey,
        namespace: params.namespace,
        bucketId,
      }),
      ttlMs: 0,
    };
    bucket.value.entries[key] = value;
    bucket.ttlMs = Math.max(bucket.ttlMs, ttlMs);
    buckets.set(bucketKey, bucket);
  }
  return [...buckets.entries()].map(([key, bucket]) => ({
    key,
    value: bucket.value,
    ttlMs: bucket.ttlMs,
  }));
}
