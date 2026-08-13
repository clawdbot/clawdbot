// Persistent dedupe helpers give plugins bounded replay protection across process restarts.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { resolveNonNegativeIntegerOption } from "../../packages/normalization-core/src/number-coercion.js";
import { createDedupeCache } from "../infra/dedupe.js";
import {
  createCorePluginStateSyncKeyedStore,
  createPluginStateSyncKeyedStore,
} from "../plugin-state/plugin-state-store.js";
import type { PluginStateSyncKeyedStore } from "../plugin-state/plugin-state-store.types.js";
import {
  createChannelReplayGuardWithDedupe,
  type ChannelReplayGuard,
  type ChannelReplayClaimHandle,
  type ChannelReplayGuardParams,
} from "./channel-replay-guard.js";
import type {
  ClaimableDedupe,
  ClaimableDedupeClaimResult,
  ClaimableDedupeOptions,
  PersistentDedupe,
  PersistentDedupeCheckOptions,
  PersistentDedupeLegacyPathOptions,
  PersistentDedupeOptions,
  PersistentDedupePluginStateOptions,
} from "./persistent-dedupe.types.js";

const LEGACY_PATH_OWNER_ID = "core:persistent-dedupe";
const DEFAULT_NAMESPACE_PREFIX = "persistent-dedupe";

export type { ChannelReplayClaimHandle };
export type {
  ClaimableDedupe,
  ClaimableDedupeClaimResult,
  ClaimableDedupeOptions,
  PersistentDedupe,
  PersistentDedupeCheckOptions,
  PersistentDedupeLegacyPathOptions,
  PersistentDedupeOptions,
  PersistentDedupePluginStateOptions,
} from "./persistent-dedupe.types.js";

export type PersistentDedupeEntry = {
  key: string;
  seenAt: number;
};

export type PersistentDedupeLegacyJsonMigrationResult = {
  imported: number;
  skippedExpired: number;
  skippedInvalid: number;
  skippedExisting: number;
  removed: boolean;
};

export type PersistentDedupeLegacyJsonMigrationOptions = PersistentDedupePluginStateOptions & {
  filePath: string;
  namespace: string;
  now?: number;
  removeFile?: boolean;
};

export type PersistentDedupeLegacyJsonImportEntry = {
  key: string;
  value: PersistentDedupeEntry;
  ttlMs?: number;
};

type PersistentDedupeLegacyJsonEntriesResult = {
  entries: PersistentDedupeLegacyJsonImportEntry[];
  skippedExpired: number;
  skippedInvalid: number;
};

function resolveNamespace(namespace?: string): string {
  return namespace?.trim() || "global";
}

function resolveScopedKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

function isRecentTimestamp(seenAt: number | undefined, ttlMs: number, now: number): boolean {
  return seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
}

function resolveEntrySeenAt(entry: PersistentDedupeEntry | undefined): number | undefined {
  return typeof entry?.seenAt === "number" && Number.isFinite(entry.seenAt)
    ? entry.seenAt
    : undefined;
}

function resolveUnknownEntrySeenAt(value: unknown): number | undefined {
  if (!value || typeof value !== "object" || !("seenAt" in value)) {
    return undefined;
  }
  return typeof value.seenAt === "number" && Number.isFinite(value.seenAt)
    ? value.seenAt
    : undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function resolveEntryKey(key: string): string {
  return `k.${shortHash(key)}`;
}

export function createPersistentDedupeImportEntry(params: {
  key: string;
  seenAt: number;
  ttlMs?: number;
}): PersistentDedupeLegacyJsonImportEntry {
  return {
    key: resolveEntryKey(params.key),
    value: { key: params.key, seenAt: params.seenAt },
    ...(params.ttlMs != null ? { ttlMs: params.ttlMs } : {}),
  };
}

function resolveRemainingTtlMs(
  seenAt: number,
  ttlMs: number,
  now: number,
): { ttlMs: number } | undefined | null {
  if (ttlMs <= 0) {
    return undefined;
  }
  const remaining = ttlMs - (now - seenAt);
  return remaining > 0 ? { ttlMs: Math.max(1, Math.floor(remaining)) } : null;
}

function normalizeNamespacePrefix(value: string | undefined): string {
  const normalized = (value ?? DEFAULT_NAMESPACE_PREFIX)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  return normalized || DEFAULT_NAMESPACE_PREFIX;
}

function resolveStateNamespace(prefix: string, namespace: string): string {
  return `${prefix}.${shortHash(namespace)}`;
}

export function resolvePersistentDedupePluginStateNamespace(options: {
  namespace: string;
  namespacePrefix?: string;
}): string {
  return resolveStateNamespace(
    normalizeNamespacePrefix(options.namespacePrefix),
    resolveNamespace(options.namespace),
  );
}

function hasPluginStateOptions(
  options: ClaimableDedupeOptions | PersistentDedupeOptions,
): options is PersistentDedupePluginStateOptions {
  return typeof options.pluginId === "string";
}

function hasLegacyPathOptions(
  options: ClaimableDedupeOptions | PersistentDedupeOptions,
): options is PersistentDedupeLegacyPathOptions {
  return typeof options.resolveFilePath === "function";
}

function resolveStateMaxEntries(options: PersistentDedupeOptions): number {
  const maxEntries = hasPluginStateOptions(options)
    ? options.stateMaxEntries
    : options.fileMaxEntries;
  return Math.max(1, resolveNonNegativeIntegerOption(maxEntries, 1));
}

function resolvePersistentStoreCacheKey(pluginId: string, namespace: string): string {
  return `${pluginId}\0${namespace}`;
}

function createPersistentStoreResolver(
  options: PersistentDedupeOptions,
): (namespace: string) => PluginStateSyncKeyedStore<PersistentDedupeEntry> {
  const maxEntries = resolveStateMaxEntries(options);
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const defaultTtlMs = ttlMs > 0 ? ttlMs : undefined;
  const stores = new Map<string, PluginStateSyncKeyedStore<PersistentDedupeEntry>>();

  if (hasPluginStateOptions(options)) {
    const pluginId = options.pluginId;
    const prefix = normalizeNamespacePrefix(options.namespacePrefix);
    return (namespace) => {
      const stateNamespace = resolveStateNamespace(prefix, namespace);
      const cacheKey = resolvePersistentStoreCacheKey(pluginId, stateNamespace);
      const existing = stores.get(cacheKey);
      if (existing) {
        return existing;
      }
      const store = createPluginStateSyncKeyedStore<PersistentDedupeEntry>(pluginId, {
        namespace: stateNamespace,
        maxEntries,
        ...(defaultTtlMs != null ? { defaultTtlMs } : {}),
        ...(options.env ? { env: options.env } : {}),
      });
      stores.set(cacheKey, store);
      return store;
    };
  }

  const prefix = normalizeNamespacePrefix("legacy-path");
  return (namespace) => {
    const legacyPath = options.resolveFilePath(namespace);
    const stateNamespace = resolveStateNamespace(prefix, legacyPath);
    const cacheKey = resolvePersistentStoreCacheKey(LEGACY_PATH_OWNER_ID, stateNamespace);
    const existing = stores.get(cacheKey);
    if (existing) {
      return existing;
    }
    const store = createCorePluginStateSyncKeyedStore<PersistentDedupeEntry>({
      ownerId: LEGACY_PATH_OWNER_ID,
      namespace: stateNamespace,
      maxEntries,
      ...(defaultTtlMs != null ? { defaultTtlMs } : {}),
      ...(options.env ? { env: options.env } : {}),
    });
    stores.set(cacheKey, store);
    return store;
  };
}

function parseLegacyDedupeData(raw: string): {
  data: Record<string, number>;
  invalidCount: number;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { data: {}, invalidCount: 0 };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { data: {}, invalidCount: 0 };
  }
  const data: Record<string, number> = {};
  let invalidCount = 0;
  for (const [key, seenAt] of Object.entries(parsed)) {
    if (typeof seenAt === "number" && Number.isFinite(seenAt) && seenAt > 0) {
      data[key] = seenAt;
    } else {
      invalidCount++;
    }
  }
  return { data, invalidCount };
}

async function readPersistentDedupeLegacyJsonFileEntries(options: {
  filePath: string;
  ttlMs: number;
  now?: number;
}): Promise<PersistentDedupeLegacyJsonEntriesResult> {
  const raw = await fs.readFile(options.filePath, "utf8");
  const { data, invalidCount } = parseLegacyDedupeData(raw);
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const now = options.now ?? Date.now();
  const entries: PersistentDedupeLegacyJsonImportEntry[] = [];
  let skippedExpired = 0;

  for (const [key, seenAt] of Object.entries(data)) {
    const ttlOption = resolveRemainingTtlMs(seenAt, ttlMs, now);
    if (ttlOption === null) {
      skippedExpired++;
      continue;
    }
    entries.push(createPersistentDedupeImportEntry({ key, seenAt, ...ttlOption }));
  }

  return { entries, skippedExpired, skippedInvalid: invalidCount };
}

export async function listPersistentDedupeLegacyJsonFileEntries(options: {
  filePath: string;
  ttlMs: number;
  now?: number;
}): Promise<PersistentDedupeLegacyJsonImportEntry[]> {
  return (await readPersistentDedupeLegacyJsonFileEntries(options)).entries;
}

export function shouldReplacePersistentDedupeEntry(params: {
  existingValue: unknown;
  incomingValue: unknown;
}): boolean {
  const incomingSeenAt = resolveUnknownEntrySeenAt(params.incomingValue);
  return (
    incomingSeenAt != null &&
    incomingSeenAt > (resolveUnknownEntrySeenAt(params.existingValue) ?? 0)
  );
}

/** Import one retired JSON dedupe cache file into plugin-state SQLite during doctor repair. */
export async function migratePersistentDedupeLegacyJsonFile(
  options: PersistentDedupeLegacyJsonMigrationOptions,
): Promise<PersistentDedupeLegacyJsonMigrationResult> {
  const legacy = await readPersistentDedupeLegacyJsonFileEntries(options);
  const store = createPersistentStoreResolver(options)(resolveNamespace(options.namespace));
  const result: PersistentDedupeLegacyJsonMigrationResult = {
    imported: 0,
    skippedExpired: legacy.skippedExpired,
    skippedInvalid: legacy.skippedInvalid,
    skippedExisting: 0,
    removed: false,
  };

  for (const entry of legacy.entries) {
    const changed = store.update?.(
      entry.key,
      (current) => {
        const currentSeenAt = resolveEntrySeenAt(current);
        if (currentSeenAt != null && currentSeenAt >= entry.value.seenAt) {
          return undefined;
        }
        return entry.value;
      },
      entry.ttlMs != null ? { ttlMs: entry.ttlMs } : undefined,
    );
    if (changed) {
      result.imported++;
    } else {
      result.skippedExisting++;
    }
  }

  if (options.removeFile !== false) {
    await fs.rm(options.filePath, { force: true });
    result.removed = true;
  }
  return result;
}

/** Create a dedupe helper that combines in-memory fast checks with SQLite-backed state. */
export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const memoryMaxSize = resolveNonNegativeIntegerOption(options.memoryMaxSize, 0);
  const getStore = createPersistentStoreResolver(options);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const inflight = new Map<string, Promise<boolean>>();

  async function checkAndRecordInner(
    key: string,
    namespace: string,
    scopedKey: string,
    now: number,
    onDiskError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (memory.check(scopedKey, now)) {
      return false;
    }

    try {
      const entryKey = resolveEntryKey(key);
      const store = getStore(namespace);
      let duplicateSeenAt: number | undefined;
      store.update?.(
        entryKey,
        (entry) => {
          const seenAt = resolveEntrySeenAt(entry);
          if (isRecentTimestamp(seenAt, ttlMs, now)) {
            duplicateSeenAt = seenAt;
            return undefined;
          }
          return { key, seenAt: now };
        },
        ttlMs > 0 ? { ttlMs } : undefined,
      );
      if (duplicateSeenAt != null) {
        memory.check(scopedKey, duplicateSeenAt);
        return false;
      }
      memory.check(scopedKey, now);
      return true;
    } catch (error) {
      onDiskError?.(error);
      memory.check(scopedKey, now);
      return true;
    }
  }

  async function hasRecentInner(
    key: string,
    namespace: string,
    scopedKey: string,
    now: number,
    onDiskError?: (error: unknown) => void,
  ): Promise<boolean> {
    if (memory.peek(scopedKey, now)) {
      return true;
    }

    try {
      const seenAt = resolveEntrySeenAt(getStore(namespace).lookup(resolveEntryKey(key)));
      if (!isRecentTimestamp(seenAt, ttlMs, now)) {
        return false;
      }
      memory.check(scopedKey, seenAt);
      return true;
    } catch (error) {
      onDiskError?.(error);
      return memory.peek(scopedKey, now);
    }
  }

  async function warmup(namespace = "global", onError?: (error: unknown) => void): Promise<number> {
    const now = Date.now();
    try {
      let loaded = 0;
      for (const entry of getStore(resolveNamespace(namespace)).entries()) {
        const ts = resolveEntrySeenAt(entry.value);
        if (ts == null) {
          continue;
        }
        if (ttlMs > 0 && now - ts >= ttlMs) {
          continue;
        }
        const scopedKey = `${resolveNamespace(namespace)}:${entry.value.key}`;
        memory.check(scopedKey, ts);
        loaded++;
      }
      return loaded;
    } catch (error) {
      onError?.(error);
      return 0;
    }
  }

  async function checkAndRecord(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return true;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    if (inflight.has(scopedKey)) {
      return false;
    }

    const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
    const now = dedupeOptions?.now ?? Date.now();
    const work = checkAndRecordInner(trimmed, namespace, scopedKey, now, onDiskError);
    inflight.set(scopedKey, work);
    try {
      return await work;
    } finally {
      inflight.delete(scopedKey);
    }
  }

  async function hasRecent(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const onDiskError = dedupeOptions?.onDiskError ?? options.onDiskError;
    const now = dedupeOptions?.now ?? Date.now();
    return hasRecentInner(trimmed, namespace, scopedKey, now, onDiskError);
  }

  async function forget(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    memory.delete(scopedKey);

    try {
      return getStore(namespace).delete(resolveEntryKey(trimmed));
    } catch (error) {
      (dedupeOptions?.onDiskError ?? options.onDiskError)?.(error);
      return false;
    }
  }

  return {
    checkAndRecord,
    hasRecent,
    forget,
    warmup,
    clearMemory: () => memory.clear(),
    memorySize: () => memory.size(),
  };
}

function createReleasedClaimError(scopedKey: string): Error {
  return new Error(`claim released before commit: ${scopedKey}`);
}

type ClaimLoopInflight = { kind: "inflight"; pending: Promise<boolean> };
type ClaimLoopSettled = { kind: "claimed" } | { kind: "duplicate" } | { kind: "invalid" };

/** Resolve a claim, waiting on an active owner and retrying only when its release allows it. */
export async function runClaimableDedupeClaimLoop<TClaim extends ClaimLoopSettled>(
  claimNext: () => Promise<TClaim | ClaimLoopInflight>,
  retryAfterRejection: (error: unknown, rejectionCount: number) => boolean,
): Promise<TClaim | { kind: "duplicate" }> {
  let rejectionCount = 0;
  while (true) {
    const claim = await claimNext();
    if (claim.kind !== "inflight") {
      return claim;
    }
    try {
      await claim.pending;
      return { kind: "duplicate" };
    } catch (error) {
      if (!retryAfterRejection(error, ++rejectionCount)) {
        return { kind: "duplicate" };
      }
    }
  }
}

/** Create a claim/commit/release dedupe guard backed by memory and optional persistent storage. */
export function createClaimableDedupe(
  options: ClaimableDedupeOptions,
): ClaimableDedupe & Required<Pick<ClaimableDedupe, "forget">> {
  const ttlMs = resolveNonNegativeIntegerOption(options.ttlMs, 0);
  const memoryMaxSize = resolveNonNegativeIntegerOption(options.memoryMaxSize, 0);
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  let persistent: PersistentDedupe | null = null;
  if (hasPluginStateOptions(options)) {
    persistent = createPersistentDedupe({
      ttlMs,
      memoryMaxSize,
      pluginId: options.pluginId,
      stateMaxEntries: Math.max(1, resolveNonNegativeIntegerOption(options.stateMaxEntries, 1)),
      ...(options.namespacePrefix ? { namespacePrefix: options.namespacePrefix } : {}),
      ...(options.env ? { env: options.env } : {}),
      ...(options.onDiskError ? { onDiskError: options.onDiskError } : {}),
    });
  } else if (hasLegacyPathOptions(options)) {
    persistent = createPersistentDedupe({
      ttlMs,
      memoryMaxSize,
      fileMaxEntries: Math.max(1, resolveNonNegativeIntegerOption(options.fileMaxEntries, 1)),
      resolveFilePath: options.resolveFilePath,
      ...(options.env ? { env: options.env } : {}),
      ...(options.lockOptions ? { lockOptions: options.lockOptions } : {}),
      ...(options.onDiskError ? { onDiskError: options.onDiskError } : {}),
    });
  }

  const inflight = new Map<
    string,
    {
      promise: Promise<boolean>;
      resolve: (result: boolean) => void;
      reject: (error: unknown) => void;
    }
  >();

  async function hasRecent(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    if (persistent) {
      return persistent.hasRecent(trimmed, dedupeOptions);
    }
    return memory.peek(scopedKey, dedupeOptions?.now);
  }

  async function forget(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return false;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const claimValue = inflight.get(scopedKey);
    claimValue?.reject(createReleasedClaimError(scopedKey));
    inflight.delete(scopedKey);
    if (persistent) {
      return persistent.forget(trimmed, dedupeOptions);
    }
    memory.delete(scopedKey);
    return true;
  }

  async function claim(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<ClaimableDedupeClaimResult> {
    const trimmed = key.trim();
    if (!trimmed) {
      return { kind: "claimed" };
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const existing = inflight.get(scopedKey);
    if (existing) {
      return { kind: "inflight", pending: existing.promise };
    }

    let resolve!: (result: boolean) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    void promise.catch(() => {});
    inflight.set(scopedKey, { promise, resolve, reject });
    try {
      if (await hasRecent(trimmed, dedupeOptions)) {
        resolve(false);
        inflight.delete(scopedKey);
        return { kind: "duplicate" };
      }
      return { kind: "claimed" };
    } catch (error) {
      reject(error);
      inflight.delete(scopedKey);
      throw error;
    }
  }

  async function commit(
    key: string,
    dedupeOptions?: PersistentDedupeCheckOptions,
  ): Promise<boolean> {
    const trimmed = key.trim();
    if (!trimmed) {
      return true;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const claimValue = inflight.get(scopedKey);
    try {
      const recorded = persistent
        ? await persistent.checkAndRecord(trimmed, dedupeOptions)
        : !memory.check(scopedKey, dedupeOptions?.now);
      claimValue?.resolve(recorded);
      return recorded;
    } catch (error) {
      claimValue?.reject(error);
      throw error;
    } finally {
      inflight.delete(scopedKey);
    }
  }

  function release(
    key: string,
    dedupeOptions?: {
      namespace?: string;
      error?: unknown;
    },
  ): void {
    const trimmed = key.trim();
    if (!trimmed) {
      return;
    }
    const namespace = resolveNamespace(dedupeOptions?.namespace);
    const scopedKey = resolveScopedKey(namespace, trimmed);
    const claimLocal = inflight.get(scopedKey);
    if (!claimLocal) {
      return;
    }
    claimLocal.reject(dedupeOptions?.error ?? createReleasedClaimError(scopedKey));
    inflight.delete(scopedKey);
  }

  return {
    claim,
    commit,
    release,
    hasRecent,
    forget,
    warmup: persistent?.warmup ?? (async () => 0),
    clearMemory: () => {
      persistent?.clearMemory();
      memory.clear();
    },
    memorySize: () => persistent?.memorySize() ?? memory.size(),
  };
}

/**
 * Create an event-keyed replay guard whose claims own their settlement handles.
 *
 * Layering contract vs the durable ingress drain (`src/channels/message/ingress-queue.ts`):
 * the drain already rejects duplicate event ids durably — `complete()` tombstones the row
 * and enqueue is `ON CONFLICT DO NOTHING` for the tombstone retention window. A replay
 * guard on a drained channel is justified only when its identity or retention exceeds the
 * queue's: a *logical* message key that differs from the transport delivery id (Telegram:
 * `chat_id:message_id` vs `update_id` — debounce/media-group merges can re-surface a
 * constituent message under a fresh update_id only the guard sees), or a window longer
 * than the channel's tombstone retention. If the guard key would equal the drain event_id
 * and retention fits the tombstone window, delete the guard when adopting the drain.
 */
export function createChannelReplayGuard<TEvent>(
  params: ChannelReplayGuardParams<TEvent>,
): ChannelReplayGuard<TEvent> {
  return createChannelReplayGuardWithDedupe(params, createClaimableDedupe(params.dedupe));
}
