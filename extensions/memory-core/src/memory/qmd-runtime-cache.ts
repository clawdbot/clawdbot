// Memory Core QMD runtime cache helpers.
import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { memoryCoreWorkspaceEntryKey, openMemoryCoreStateStore } from "../dreaming-state.js";

const QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE = "qmd-runtime-cache.collection-validation";
const QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE =
  "qmd-runtime-cache.multi-collection-probe";
const QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_MAX_ENTRIES = 1_000;
const QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_MAX_ENTRIES = 1_000;
const QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_TTL_MS = 5 * 60_000;
const QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_TTL_MS = 10 * 60_000;

const QMD_RUNTIME_CACHE_ENTRY_VERSION = 1;

export type QmdRuntimeManagedCollection = {
  name: string;
  kind: "memory" | "custom" | "sessions";
  path: string;
  pattern: string;
};

type QmdRuntimeCacheContextBase = {
  workspaceDir: string;
  agentId: string;
  qmdCommand: string;
  qmdVersion?: string;
  qmdEnvironmentHash?: string;
  qmdIndexPath: string;
  searchMode: string;
};

export type QmdRuntimeCollectionValidationCacheContext = QmdRuntimeCacheContextBase & {
  collections: readonly QmdRuntimeManagedCollection[];
  sources: readonly string[];
};

export type QmdRuntimeMultiCollectionProbeCacheContext = QmdRuntimeCacheContextBase & {
  sources: readonly string[];
};

type QmdRuntimeCacheCollectionValidationEntry = {
  version: 1;
  createdAtMs: number;
  expiresAtMs: number;
  keyHash: string;
  validation: {
    ok: true;
    collectionConfigHash: string;
    collectionCount: number;
  };
};

type QmdRuntimeCacheMultiCollectionProbeEntry = {
  version: 1;
  createdAtMs: number;
  expiresAtMs: number;
  keyHash: string;
  multiCollectionProbe: {
    supported: boolean;
  };
};

type QmdRuntimeCacheResult<T> =
  | {
      state: "hit";
      value: T;
    }
  | { state: "miss" };

function normalizeText(value: string): string {
  return value.trim();
}

function normalizeCollection(collection: QmdRuntimeManagedCollection) {
  return {
    name: normalizeText(collection.name),
    kind: collection.kind,
    pathHash: normalizePathIdentity(collection.path),
    pattern: normalizeText(collection.pattern),
  };
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePathIdentity(value: string): string {
  const normalized =
    process.platform === "win32" ? normalizeText(value).toLowerCase() : normalizeText(value);
  return hashText(normalized);
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => normalizeText(value)).filter(Boolean))].toSorted();
}

function buildCollectionConfigHash(collections: readonly QmdRuntimeManagedCollection[]): string {
  const normalized = collections
    .map((collection) => ({
      ...normalizeCollection(collection),
    }))
    .toSorted(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.kind.localeCompare(right.kind) ||
        left.pathHash.localeCompare(right.pathHash) ||
        left.pattern.localeCompare(right.pattern),
    )
    .map((entry) => `${entry.name}|${entry.kind}|${entry.pathHash}|${entry.pattern}`)
    .join(";");
  return hashText(normalized);
}

function buildRuntimeCacheContextRecord(
  params: QmdRuntimeCacheContextBase & { sources: readonly string[] },
) {
  return {
    agentId: normalizeText(params.agentId),
    commandHash: hashText(normalizeText(params.qmdCommand)),
    environmentHash: normalizeText(params.qmdEnvironmentHash ?? ""),
    indexPathHash: normalizePathIdentity(params.qmdIndexPath),
    qmdVersion: normalizeText(params.qmdVersion ?? ""),
    searchMode: params.searchMode,
    sourceSet: sortedUnique(params.sources),
  };
}

function buildCollectionValidationCacheContextInput(
  params: QmdRuntimeCollectionValidationCacheContext,
): string {
  return JSON.stringify({
    ...buildRuntimeCacheContextRecord(params),
    collectionConfigHash: buildCollectionConfigHash(params.collections),
  });
}

function buildMultiCollectionProbeCacheContextInput(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
): string {
  return JSON.stringify(buildRuntimeCacheContextRecord(params));
}

function buildQmdCollectionValidationCacheContextHash(
  params: QmdRuntimeCollectionValidationCacheContext,
): string {
  return hashText(buildCollectionValidationCacheContextInput(params));
}

function buildQmdMultiCollectionProbeCacheContextHash(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
): string {
  return hashText(buildMultiCollectionProbeCacheContextInput(params));
}

function collectionValidationStore(): PluginStateKeyedStore<QmdRuntimeCacheCollectionValidationEntry> {
  return openMemoryCoreStateStore<QmdRuntimeCacheCollectionValidationEntry>({
    namespace: QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE,
    maxEntries: QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_MAX_ENTRIES,
  });
}

function multiCollectionProbeStore(): PluginStateKeyedStore<QmdRuntimeCacheMultiCollectionProbeEntry> {
  return openMemoryCoreStateStore<QmdRuntimeCacheMultiCollectionProbeEntry>({
    namespace: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
    maxEntries: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_MAX_ENTRIES,
  });
}

function collectionValidationEntryKey(params: QmdRuntimeCollectionValidationCacheContext): string {
  return memoryCoreWorkspaceEntryKey(
    params.workspaceDir,
    `qmd-runtime-cache.collection-validation:${buildQmdCollectionValidationCacheContextHash(params)}`,
  );
}

function multiCollectionProbeEntryKey(params: QmdRuntimeMultiCollectionProbeCacheContext): string {
  return memoryCoreWorkspaceEntryKey(
    params.workspaceDir,
    `qmd-runtime-cache.multi-collection-probe:${buildQmdMultiCollectionProbeCacheContextHash(params)}`,
  );
}

type QmdRuntimeCacheEnvelope = {
  record: Record<string, unknown>;
  createdAtMs: number;
  expiresAtMs: number;
  keyHash: string;
};

/** Validates the shared cache-entry envelope: version, expiry window, and key hash. */
function normalizeCacheEntryEnvelope(
  value: unknown,
  nowMs: number,
  expectedKeyHash: string,
): QmdRuntimeCacheEnvelope | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== QMD_RUNTIME_CACHE_ENTRY_VERSION) {
    return undefined;
  }

  const createdAtMs =
    typeof record.createdAtMs === "number"
      ? Math.max(0, Math.floor(record.createdAtMs))
      : Number.NaN;
  const expiresAtMs =
    typeof record.expiresAtMs === "number"
      ? Math.max(0, Math.floor(record.expiresAtMs))
      : Number.NaN;
  if (
    !Number.isFinite(createdAtMs) ||
    !Number.isFinite(expiresAtMs) ||
    !Number.isFinite(nowMs) ||
    nowMs >= expiresAtMs
  ) {
    return undefined;
  }

  const keyHash = normalizeText(typeof record.keyHash === "string" ? record.keyHash : "");
  if (keyHash !== expectedKeyHash) {
    return undefined;
  }

  return { record, createdAtMs, expiresAtMs, keyHash };
}

function normalizeCollectionValidationEntry(
  value: unknown,
  nowMs: number,
  expectedKeyHash: string,
): QmdRuntimeCacheCollectionValidationEntry | undefined {
  const envelope = normalizeCacheEntryEnvelope(value, nowMs, expectedKeyHash);
  if (!envelope) {
    return undefined;
  }
  const { record, createdAtMs, expiresAtMs, keyHash } = envelope;

  const validation = record.validation;
  if (typeof validation !== "object" || validation === null) {
    return undefined;
  }
  const validationRecord = validation as Record<string, unknown>;
  if (validationRecord.ok !== true) {
    return undefined;
  }
  if (typeof validationRecord.collectionConfigHash !== "string") {
    return undefined;
  }
  if (typeof validationRecord.collectionCount !== "number") {
    return undefined;
  }

  return {
    version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
    createdAtMs,
    expiresAtMs,
    keyHash,
    validation: {
      ok: true,
      collectionConfigHash: normalizeText(validationRecord.collectionConfigHash),
      collectionCount: Math.max(0, Math.floor(validationRecord.collectionCount)),
    },
  };
}

function normalizeMultiCollectionProbeEntry(
  value: unknown,
  nowMs: number,
  expectedKeyHash: string,
): QmdRuntimeCacheMultiCollectionProbeEntry | undefined {
  const envelope = normalizeCacheEntryEnvelope(value, nowMs, expectedKeyHash);
  if (!envelope) {
    return undefined;
  }
  const { record, createdAtMs, expiresAtMs, keyHash } = envelope;

  const probe = record.multiCollectionProbe;
  if (typeof probe !== "object" || probe === null) {
    return undefined;
  }
  const probeRecord = probe as Record<string, unknown>;
  if (typeof probeRecord.supported !== "boolean") {
    return undefined;
  }

  return {
    version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
    createdAtMs,
    expiresAtMs,
    keyHash,
    multiCollectionProbe: {
      supported: probeRecord.supported,
    },
  };
}

export async function readQmdCollectionValidationCache(
  params: QmdRuntimeCollectionValidationCacheContext,
  nowMs = Date.now(),
): Promise<QmdRuntimeCacheResult<QmdRuntimeCacheCollectionValidationEntry>> {
  try {
    const store = collectionValidationStore();
    const key = collectionValidationEntryKey(params);
    const expectedKeyHash = buildQmdCollectionValidationCacheContextHash(params);
    const raw = await store.lookup(key);
    if (!raw) {
      return { state: "miss" };
    }
    const validated = normalizeCollectionValidationEntry(raw, nowMs, expectedKeyHash);
    return validated ? { state: "hit", value: validated } : { state: "miss" };
  } catch {
    return { state: "miss" };
  }
}

export async function writeQmdCollectionValidationCache(
  params: QmdRuntimeCollectionValidationCacheContext,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    const key = collectionValidationEntryKey(params);
    const keyHash = buildQmdCollectionValidationCacheContextHash(params);
    const collectionConfigHash = buildCollectionConfigHash(params.collections);
    const createdAtMs = Math.max(0, Math.floor(nowMs));
    const ttlMs = QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_TTL_MS;
    const store = collectionValidationStore();
    await store.register(
      key,
      {
        version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
        keyHash,
        validation: {
          ok: true,
          collectionConfigHash,
          collectionCount: params.collections.length,
        },
      },
      { ttlMs },
    );
    return true;
  } catch {
    return false;
  }
}

export async function readQmdMultiCollectionProbeCache(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
  nowMs = Date.now(),
): Promise<QmdRuntimeCacheResult<QmdRuntimeCacheMultiCollectionProbeEntry>> {
  try {
    const store = multiCollectionProbeStore();
    const key = multiCollectionProbeEntryKey(params);
    const expectedKeyHash = buildQmdMultiCollectionProbeCacheContextHash(params);
    const raw = await store.lookup(key);
    if (!raw) {
      return { state: "miss" };
    }
    const validated = normalizeMultiCollectionProbeEntry(raw, nowMs, expectedKeyHash);
    return validated ? { state: "hit", value: validated } : { state: "miss" };
  } catch {
    return { state: "miss" };
  }
}

export async function writeQmdMultiCollectionProbeCache(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
  supported: boolean,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    const key = multiCollectionProbeEntryKey(params);
    const keyHash = buildQmdMultiCollectionProbeCacheContextHash(params);
    const createdAtMs = Math.max(0, Math.floor(nowMs));
    const ttlMs = QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_TTL_MS;
    const store = multiCollectionProbeStore();
    await store.register(
      key,
      {
        version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
        createdAtMs,
        expiresAtMs: createdAtMs + ttlMs,
        keyHash,
        multiCollectionProbe: {
          supported,
        },
      },
      { ttlMs },
    );
    return true;
  } catch {
    return false;
  }
}

export async function clearQmdMultiCollectionProbeCache(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
): Promise<void> {
  try {
    const store = multiCollectionProbeStore();
    await store.delete(multiCollectionProbeEntryKey(params));
  } catch {
    // fail open
  }
}
