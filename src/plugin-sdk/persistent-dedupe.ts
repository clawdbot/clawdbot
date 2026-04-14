import { createDedupeCache } from "../infra/dedupe.js";
import type { FileLockOptions } from "./file-lock.js";
import { withFileLock } from "./file-lock.js";
import { readJsonFileWithFallback, writeJsonFileAtomically } from "./json-store.js";

type PersistentDedupeData = Record<string, number>;

export type PersistentDedupeOptions = {
  ttlMs: number;
  memoryMaxSize: number;
  fileMaxEntries: number;
  resolveFilePath: (namespace: string) => string;
  lockOptions?: Partial<FileLockOptions>;
  onDiskError?: (error: unknown) => void;
};

export type PersistentDedupeCheckOptions = {
  namespace?: string;
  now?: number;
  onDiskError?: (error: unknown) => void;
};

export type PersistentDedupe = {
  checkAndRecord: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
  memorySize: () => number;
};

export type ClaimableDedupeClaimResult =
  | { kind: "claimed" }
  | { kind: "duplicate" }
  | { kind: "inflight"; pending: Promise<boolean> };

export type ClaimableDedupeOptions =
  | {
      ttlMs: number;
      memoryMaxSize: number;
      resolveFilePath: (namespace: string) => string;
      fileMaxEntries: number;
      lockOptions?: Partial<FileLockOptions>;
      onDiskError?: (error: unknown) => void;
    }
  | {
      ttlMs: number;
      memoryMaxSize: number;
      resolveFilePath?: undefined;
      fileMaxEntries?: undefined;
      lockOptions?: undefined;
      onDiskError?: undefined;
    };

export type ClaimableDedupe = {
  claim: (
    key: string,
    options?: PersistentDedupeCheckOptions,
  ) => Promise<ClaimableDedupeClaimResult>;
  commit: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  release: (
    key: string,
    options?: {
      namespace?: string;
      error?: unknown;
    },
  ) => void;
  hasRecent: (key: string, options?: PersistentDedupeCheckOptions) => Promise<boolean>;
  warmup: (namespace?: string, onError?: (error: unknown) => void) => Promise<number>;
  clearMemory: () => void;
  memorySize: () => number;
};

const DEFAULT_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

function mergeLockOptions(overrides?: Partial<FileLockOptions>): FileLockOptions {
  return {
    stale: overrides?.stale ?? DEFAULT_LOCK_OPTIONS.stale,
    retries: {
      retries: overrides?.retries?.retries ?? DEFAULT_LOCK_OPTIONS.retries.retries,
      factor: overrides?.retries?.factor ?? DEFAULT_LOCK_OPTIONS.retries.factor,
      minTimeout: overrides?.retries?.minTimeout ?? DEFAULT_LOCK_OPTIONS.retries.minTimeout,
      maxTimeout: overrides?.retries?.maxTimeout ?? DEFAULT_LOCK_OPTIONS.retries.maxTimeout,
      randomize: overrides?.retries?.randomize ?? DEFAULT_LOCK_OPTIONS.retries.randomize,
    },
  };
}

function sanitizeData(value: unknown): PersistentDedupeData {
  if (!value || typeof value !== "object") {
    return {};
  }
  const out: PersistentDedupeData = {};
  for (const [key, ts] of Object.entries(value as Record<string, unknown>)) {
    if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
      out[key] = ts;
    }
  }
  return out;
}

function pruneData(
  data: PersistentDedupeData,
  now: number,
  ttlMs: number,
  maxEntries: number,
): void {
  if (ttlMs > 0) {
    for (const [key, ts] of Object.entries(data)) {
      if (now - ts >= ttlMs) {
        delete data[key];
      }
    }
  }

  const keys = Object.keys(data);
  if (keys.length <= maxEntries) {
    return;
  }

  keys
    .toSorted((a, b) => data[a] - data[b])
    .slice(0, keys.length - maxEntries)
    .forEach((key) => {
      delete data[key];
    });
}

function resolveNamespace(namespace?: string): string {
  return namespace?.trim() || "global";
}

function resolveScopedKey(namespace: string, key: string): string {
  return `${namespace}:${key}`;
}

function isRecentTimestamp(seenAt: number | undefined, ttlMs: number, now: number): boolean {
  return seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
}

/** Create a dedupe helper that combines in-memory fast checks with a lock-protected disk store. */
export function createPersistentDedupe(options: PersistentDedupeOptions): PersistentDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const fileMaxEntries = Math.max(1, Math.floor(options.fileMaxEntries));
  const lockOptions = mergeLockOptions(options.lockOptions);
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

    const path = options.resolveFilePath(namespace);
    try {
      const duplicate = await withFileLock(path, lockOptions, async () => {
        const { value } = await readJsonFileWithFallback<PersistentDedupeData>(path, {});
        const data = sanitizeData(value);
        const seenAt = data[key];
        const isRecent = seenAt != null && (ttlMs <= 0 || now - seenAt < ttlMs);
        if (isRecent) {
          return true;
        }
        data[key] = now;
        pruneData(data, now, ttlMs, fileMaxEntries);
        await writeJsonFileAtomically(path, data);
        return false;
      });
      return !duplicate;
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

    const path = options.resolveFilePath(namespace);
    try {
      const { value } = await readJsonFileWithFallback<PersistentDedupeData>(path, {});
      const data = sanitizeData(value);
      const seenAt = data[key];
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
    const filePath = options.resolveFilePath(namespace);
    const now = Date.now();
    try {
      const { value } = await readJsonFileWithFallback<PersistentDedupeData>(filePath, {});
      const data = sanitizeData(value);
      let loaded = 0;
      for (const [key, ts] of Object.entries(data)) {
        if (ttlMs > 0 && now - ts >= ttlMs) {
          continue;
        }
        const scopedKey = `${namespace}:${key}`;
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

  return {
    checkAndRecord,
    hasRecent,
    warmup,
    clearMemory: () => memory.clear(),
    memorySize: () => memory.size(),
  };
}

function createReleasedClaimError(scopedKey: string): Error {
  return new Error(`claim released before commit: ${scopedKey}`);
}

/** Create a claim/commit/release dedupe guard backed by memory and optional persistent storage. */
export function createClaimableDedupe(options: ClaimableDedupeOptions): ClaimableDedupe {
  const ttlMs = Math.max(0, Math.floor(options.ttlMs));
  const memoryMaxSize = Math.max(0, Math.floor(options.memoryMaxSize));
  const memory = createDedupeCache({ ttlMs, maxSize: memoryMaxSize });
  const persistent =
    options.resolveFilePath != null
      ? createPersistentDedupe({
          ttlMs,
          memoryMaxSize,
          fileMaxEntries: Math.max(1, Math.floor(options.fileMaxEntries)),
          resolveFilePath: options.resolveFilePath,
          lockOptions: options.lockOptions,
          onDiskError: options.onDiskError,
        })
      : null;

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
    const claim = inflight.get(scopedKey);
    try {
      const recorded = persistent
        ? await persistent.checkAndRecord(trimmed, dedupeOptions)
        : !memory.check(scopedKey, dedupeOptions?.now);
      claim?.resolve(recorded);
      return recorded;
    } catch (error) {
      claim?.reject(error);
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
    const claim = inflight.get(scopedKey);
    if (!claim) {
      return;
    }
    claim.reject(dedupeOptions?.error ?? createReleasedClaimError(scopedKey));
    inflight.delete(scopedKey);
  }

  return {
    claim,
    commit,
    release,
    hasRecent,
    warmup: persistent?.warmup ?? (async () => 0),
    clearMemory: () => {
      persistent?.clearMemory();
      memory.clear();
    },
    memorySize: () => persistent?.memorySize() ?? memory.size(),
  };
}
