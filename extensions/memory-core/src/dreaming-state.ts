// Memory Core dreaming state lives in SQLite-backed plugin state.
import { createHash } from "node:crypto";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
export const DREAMING_DAILY_INGESTION_NAMESPACE = "dreaming-daily-ingestion";
export const DREAMING_SESSION_INGESTION_FILES_NAMESPACE = "dreaming-session-ingestion-files";
export const DREAMING_SESSION_INGESTION_SEEN_NAMESPACE = "dreaming-session-ingestion-seen";
export const SESSION_BACKFILL_REWIND_NAMESPACE = "session-backfill-rewind";
export const DREAMING_MEMORY_BACKUP_NAMESPACE = "dreaming-memory-backups";
export const SHORT_TERM_RECALL_NAMESPACE = "short-term-recall";
export const SHORT_TERM_PHASE_SIGNAL_NAMESPACE = "short-term-phase-signals";
export const SHORT_TERM_META_NAMESPACE = "short-term-meta";
export const SHORT_TERM_LOCK_NAMESPACE = "short-term-locks";

// Namespace capacity for Dreaming workspace-keyed plugin-state rows.
// At this cap the keyed store evicts oldest created_at first; see skip path
// below for the intentional no-refresh retention policy under capacity pressure.
const DREAMING_WORKSPACE_STATE_MAX_ENTRIES = 50_000;
export const SHORT_TERM_LOCK_MAX_ENTRIES = 4_096;
export const SESSION_SEEN_HASHES_PER_CHUNK = 512;

export type MemoryCoreOpenKeyedStore = <T>(
  options: OpenKeyedStoreOptions,
) => PluginStateKeyedStore<T>;

type WorkspaceValue<T> = {
  version: 1;
  workspaceKey: string;
  workspaceDir: string;
  key: string;
  value: T;
};

type MemoryCoreWorkspaceEntry<T> = { key: string; value: T };

type MemoryCoreWorkspaceParams = {
  namespace: string;
  workspaceDir: string;
};

type WriteMemoryCoreWorkspaceEntriesParams<T> = MemoryCoreWorkspaceParams & {
  entries: Array<MemoryCoreWorkspaceEntry<T>>;
};

type WriteMemoryCoreWorkspaceEntryParams<T> = MemoryCoreWorkspaceParams &
  MemoryCoreWorkspaceEntry<T>;

let configuredOpenKeyedStore: MemoryCoreOpenKeyedStore | undefined;

export function configureMemoryCoreDreamingState(openKeyedStore: MemoryCoreOpenKeyedStore): void {
  configuredOpenKeyedStore = openKeyedStore;
}

export function openMemoryCoreStateStore<T>(
  options: OpenKeyedStoreOptions,
): PluginStateKeyedStore<T> {
  if (!configuredOpenKeyedStore) {
    throw new Error("memory-core dreaming SQLite state store is not configured");
  }
  return configuredOpenKeyedStore<T>(options);
}

export function normalizeMemoryCoreWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function memoryCoreWorkspaceStateKey(workspaceDir: string): string {
  return createHash("sha256").update(normalizeMemoryCoreWorkspaceKey(workspaceDir)).digest("hex");
}

function memoryCoreWorkspaceEntryKey(workspaceDir: string, logicalKey: string): string {
  const workspaceKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const itemKey = createHash("sha256").update(logicalKey).digest("hex");
  return `${workspaceKey}:${itemKey}`;
}

export function memoryCoreStateReference(namespace: string, workspaceDir: string): string {
  return `plugin-state:${MEMORY_CORE_PLUGIN_ID}/${namespace}/${memoryCoreWorkspaceStateKey(workspaceDir)}`;
}

function openWorkspaceStore<T>(namespace: string): PluginStateKeyedStore<WorkspaceValue<T>> {
  return openMemoryCoreStateStore<WorkspaceValue<T>>({
    namespace,
    maxEntries: DREAMING_WORKSPACE_STATE_MAX_ENTRIES,
  });
}

// Caller owns typed decoding for values read from plugin state.
export function readMemoryCoreWorkspaceEntries<T>(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<T>>>;
export async function readMemoryCoreWorkspaceEntries(
  params: MemoryCoreWorkspaceParams,
): Promise<Array<MemoryCoreWorkspaceEntry<unknown>>> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const prefix = `${workspaceKey}:`;
  const entries = await openWorkspaceStore<unknown>(params.namespace).entries();
  return entries
    .filter((entry) => entry.key.startsWith(prefix) && entry.value.workspaceKey === workspaceKey)
    .map((entry) => ({ key: entry.value.key, value: entry.value.value }));
}

// Caller owns typed encoding for values written to plugin state.
// Skip register() when the canonical workspace value is unchanged so Dreaming
// does not rewrite every row (and stall the gateway) on a no-op second pass.
//
// Capacity retention policy (explicit): skipping register() also skips the
// keyed store's created_at refresh. Under DREAMING_WORKSPACE_STATE_MAX_ENTRIES
// pressure the store evicts oldest created_at first, so stable/unchanged rows
// age toward eviction instead of being retained via rewrite-based recency.
// Write-amplification reduction takes precedence over refresh-based retention.
//
// When a register can trigger capacity eviction, a previously skipped equal
// desired row may disappear mid-pass. After any write, reread authoritative
// state and restore missing/changed desired rows. True no-op passes stay at
// zero register() calls.
export function writeMemoryCoreWorkspaceEntries<T>(
  params: WriteMemoryCoreWorkspaceEntriesParams<T>,
): Promise<void>;
export async function writeMemoryCoreWorkspaceEntries(
  params: WriteMemoryCoreWorkspaceEntriesParams<unknown>,
): Promise<void> {
  const store = openWorkspaceStore<unknown>(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const workspaceDir = path.resolve(params.workspaceDir);
  const prefix = `${workspaceKey}:`;
  const existingByKey = new Map(
    (await store.entries())
      .filter((entry) => entry.key.startsWith(prefix))
      .map((entry) => [entry.key, entry.value] as const),
  );
  // Final desired set is last-write-wins over the input batch so duplicate
  // logical keys reconcile to the same value the sequential pass ends on.
  const desiredByStateKey = new Map<string, WorkspaceValue<unknown>>();
  let wrote = false;
  for (const entry of params.entries) {
    const stateKey = memoryCoreWorkspaceEntryKey(params.workspaceDir, entry.key);
    const nextValue: WorkspaceValue<unknown> = {
      version: 1,
      workspaceKey,
      workspaceDir,
      key: entry.key,
      value: entry.value,
    };
    desiredByStateKey.set(stateKey, nextValue);
    const current = existingByKey.get(stateKey);
    if (current !== undefined && isDeepStrictEqual(current, nextValue)) {
      continue;
    }
    await store.register(stateKey, nextValue);
    wrote = true;
    // Keep comparisons in write order so duplicate logical keys preserve the
    // keyed store's sequential last-write-wins behavior.
    existingByKey.set(stateKey, nextValue);
  }
  for (const stateKey of existingByKey.keys()) {
    if (!desiredByStateKey.has(stateKey)) {
      await store.delete(stateKey);
    }
  }
  // Only reconcile after real writes. A pure equal pass must not touch the store.
  if (wrote) {
    await reconcileDesiredWorkspaceEntries({
      store,
      prefix,
      desiredByStateKey,
    });
  }
}

async function reconcileDesiredWorkspaceEntries(params: {
  store: PluginStateKeyedStore<WorkspaceValue<unknown>>;
  prefix: string;
  desiredByStateKey: Map<string, WorkspaceValue<unknown>>;
}): Promise<void> {
  // Each capacity register can re-evict another desired row. Bound rounds by
  // unique desired size so we cannot thrash forever when desired > maxEntries.
  const maxRounds = Math.max(1, params.desiredByStateKey.size);
  for (let round = 0; round < maxRounds; round += 1) {
    const liveByKey = new Map(
      (await params.store.entries())
        .filter((entry) => entry.key.startsWith(params.prefix))
        .map((entry) => [entry.key, entry.value] as const),
    );
    const missing: Array<[string, WorkspaceValue<unknown>]> = [];
    for (const [stateKey, nextValue] of params.desiredByStateKey) {
      const current = liveByKey.get(stateKey);
      if (current !== undefined && isDeepStrictEqual(current, nextValue)) {
        continue;
      }
      missing.push([stateKey, nextValue]);
    }
    if (missing.length === 0) {
      return;
    }
    for (const [stateKey, nextValue] of missing) {
      await params.store.register(stateKey, nextValue);
    }
  }
}

// Caller owns typed encoding for values written to plugin state.
export function writeMemoryCoreWorkspaceEntry<T>(
  params: WriteMemoryCoreWorkspaceEntryParams<T>,
): Promise<void>;
export async function writeMemoryCoreWorkspaceEntry(
  params: WriteMemoryCoreWorkspaceEntryParams<unknown>,
): Promise<void> {
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  await openWorkspaceStore<unknown>(params.namespace).register(
    memoryCoreWorkspaceEntryKey(params.workspaceDir, params.key),
    {
      version: 1,
      workspaceKey,
      workspaceDir: path.resolve(params.workspaceDir),
      key: params.key,
      value: params.value,
    },
  );
}

export async function clearMemoryCoreWorkspaceNamespace(params: {
  namespace: string;
  workspaceDir: string;
}): Promise<void> {
  const store = openWorkspaceStore(params.namespace);
  const workspaceKey = memoryCoreWorkspaceStateKey(params.workspaceDir);
  const prefix = `${workspaceKey}:`;
  for (const entry of await store.entries()) {
    if (entry.key.startsWith(prefix)) {
      await store.delete(entry.key);
    }
  }
}

export async function deleteMemoryCoreWorkspaceEntry(params: {
  namespace: string;
  workspaceDir: string;
  key: string;
}): Promise<void> {
  await openWorkspaceStore(params.namespace).delete(
    memoryCoreWorkspaceEntryKey(params.workspaceDir, params.key),
  );
}
