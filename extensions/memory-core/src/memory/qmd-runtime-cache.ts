// Memory Core QMD runtime cache helpers.
import { createHash } from "node:crypto";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { memoryCoreWorkspaceEntryKey, openMemoryCoreStateStore } from "../dreaming-state.js";

const QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE = "qmd-runtime-cache.collection-validation";
const QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE =
  "qmd-runtime-cache.multi-collection-probe";
const QMD_RUNTIME_CACHE_MAX_ENTRIES = 1_000;
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

type QmdRuntimeCacheEntryBase = {
  version: 1;
  createdAtMs: number;
  expiresAtMs: number;
  keyHash: string;
};

type QmdRuntimeCacheCollectionValidationEntry = QmdRuntimeCacheEntryBase & {
  validation: {
    ok: true;
    collectionConfigHash: string;
    collectionCount: number;
  };
};

type QmdRuntimeCacheMultiCollectionProbeEntry = QmdRuntimeCacheEntryBase & {
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
      name: normalizeText(collection.name),
      kind: collection.kind,
      pathHash: normalizePathIdentity(collection.path),
      pattern: normalizeText(collection.pattern),
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

function buildQmdCollectionValidationCacheContextHash(
  params: QmdRuntimeCollectionValidationCacheContext,
): string {
  return hashText(
    JSON.stringify({
      ...buildRuntimeCacheContextRecord(params),
      collectionConfigHash: buildCollectionConfigHash(params.collections),
    }),
  );
}

function buildQmdMultiCollectionProbeCacheContextHash(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
): string {
  return hashText(JSON.stringify(buildRuntimeCacheContextRecord(params)));
}

function resolveQmdRuntimeCache<T extends QmdRuntimeCacheEntryBase>(
  workspaceDir: string,
  namespace: string,
  keyHash: string,
): { key: string; store: PluginStateKeyedStore<T> } {
  return {
    key: memoryCoreWorkspaceEntryKey(workspaceDir, `${namespace}:${keyHash}`),
    store: openMemoryCoreStateStore<T>({ namespace, maxEntries: QMD_RUNTIME_CACHE_MAX_ENTRIES }),
  };
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
  const record = asOptionalRecord(value);
  if (!record || record.version !== QMD_RUNTIME_CACHE_ENTRY_VERSION) {
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

  const validation = asOptionalRecord(record.validation);
  if (
    !validation ||
    validation.ok !== true ||
    typeof validation.collectionConfigHash !== "string" ||
    typeof validation.collectionCount !== "number"
  ) {
    return undefined;
  }

  return {
    version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
    createdAtMs,
    expiresAtMs,
    keyHash,
    validation: {
      ok: true,
      collectionConfigHash: normalizeText(validation.collectionConfigHash),
      collectionCount: Math.max(0, Math.floor(validation.collectionCount)),
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

  const probe = asOptionalRecord(record.multiCollectionProbe);
  if (!probe || typeof probe.supported !== "boolean") {
    return undefined;
  }

  return {
    version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
    createdAtMs,
    expiresAtMs,
    keyHash,
    multiCollectionProbe: {
      supported: probe.supported,
    },
  };
}

async function readQmdRuntimeCache<T extends QmdRuntimeCacheEntryBase>(params: {
  workspaceDir: string;
  namespace: string;
  keyHash: string;
  nowMs: number;
  normalize: (value: unknown, nowMs: number, keyHash: string) => T | undefined;
}): Promise<QmdRuntimeCacheResult<T>> {
  try {
    const { store, key } = resolveQmdRuntimeCache<T>(
      params.workspaceDir,
      params.namespace,
      params.keyHash,
    );
    const raw = await store.lookup(key);
    const validated = raw && params.normalize(raw, params.nowMs, params.keyHash);
    return validated ? { state: "hit", value: validated } : { state: "miss" };
  } catch {
    return { state: "miss" };
  }
}

async function writeQmdRuntimeCache<T extends QmdRuntimeCacheEntryBase>(params: {
  workspaceDir: string;
  namespace: string;
  keyHash: string;
  nowMs: number;
  ttlMs: number;
  payload: Omit<T, keyof QmdRuntimeCacheEntryBase>;
}): Promise<boolean> {
  try {
    const { store, key } = resolveQmdRuntimeCache<T>(
      params.workspaceDir,
      params.namespace,
      params.keyHash,
    );
    const createdAtMs = Math.max(0, Math.floor(params.nowMs));
    await store.register(
      key,
      {
        version: QMD_RUNTIME_CACHE_ENTRY_VERSION,
        createdAtMs,
        expiresAtMs: createdAtMs + params.ttlMs,
        keyHash: params.keyHash,
        ...params.payload,
      } as T,
      { ttlMs: params.ttlMs },
    );
    return true;
  } catch {
    return false;
  }
}

export async function readQmdCollectionValidationCache(
  params: QmdRuntimeCollectionValidationCacheContext,
  nowMs = Date.now(),
): Promise<QmdRuntimeCacheResult<QmdRuntimeCacheCollectionValidationEntry>> {
  return await readQmdRuntimeCache({
    workspaceDir: params.workspaceDir,
    namespace: QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE,
    keyHash: buildQmdCollectionValidationCacheContextHash(params),
    nowMs,
    normalize: normalizeCollectionValidationEntry,
  });
}

export async function writeQmdCollectionValidationCache(
  params: QmdRuntimeCollectionValidationCacheContext,
  nowMs = Date.now(),
): Promise<boolean> {
  return await writeQmdRuntimeCache<QmdRuntimeCacheCollectionValidationEntry>({
    workspaceDir: params.workspaceDir,
    namespace: QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_NAMESPACE,
    keyHash: buildQmdCollectionValidationCacheContextHash(params),
    nowMs,
    ttlMs: QMD_RUNTIME_CACHE_COLLECTION_VALIDATION_TTL_MS,
    payload: {
      validation: {
        ok: true,
        collectionConfigHash: buildCollectionConfigHash(params.collections),
        collectionCount: params.collections.length,
      },
    },
  });
}

export async function readQmdMultiCollectionProbeCache(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
  nowMs = Date.now(),
): Promise<QmdRuntimeCacheResult<QmdRuntimeCacheMultiCollectionProbeEntry>> {
  return await readQmdRuntimeCache({
    workspaceDir: params.workspaceDir,
    namespace: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
    keyHash: buildQmdMultiCollectionProbeCacheContextHash(params),
    nowMs,
    normalize: normalizeMultiCollectionProbeEntry,
  });
}

export async function writeQmdMultiCollectionProbeCache(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
  supported: boolean,
  nowMs = Date.now(),
): Promise<boolean> {
  return await writeQmdRuntimeCache<QmdRuntimeCacheMultiCollectionProbeEntry>({
    workspaceDir: params.workspaceDir,
    namespace: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
    keyHash: buildQmdMultiCollectionProbeCacheContextHash(params),
    nowMs,
    ttlMs: QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_TTL_MS,
    payload: { multiCollectionProbe: { supported } },
  });
}

export async function clearQmdMultiCollectionProbeCache(
  params: QmdRuntimeMultiCollectionProbeCacheContext,
): Promise<void> {
  try {
    const { store, key } = resolveQmdRuntimeCache<QmdRuntimeCacheMultiCollectionProbeEntry>(
      params.workspaceDir,
      QMD_RUNTIME_CACHE_MULTI_COLLECTION_PROBE_NAMESPACE,
      buildQmdMultiCollectionProbeCacheContextHash(params),
    );
    await store.delete(key);
  } catch {
    // fail open
  }
}
