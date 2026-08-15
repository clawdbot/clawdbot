// Memory Wiki plugin module implements legacy source-sync ownership key migration (#118370).
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { resolveUnsafeLocalPagePath } from "./source-path-shared.js";
import {
  createMemoryWikiSourceSyncStateStore,
  isPluginStateLimitExceeded,
  isScopedImportedSourceSyncKey,
  type MemoryWikiImportedSourceStateEntry,
  MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
  MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
  type MemoryWikiSourceSyncStateRecord,
  normalizeSourceSyncState,
  pruneImportedSourceEntries,
  readMemoryWikiSourceSyncState,
  resolveStateEntryKey,
  resolveVaultRootKey,
  scopeImportedSourceSyncKey,
  writeMemoryWikiSourceSyncState,
} from "./source-sync-state.js";

type LegacyImportedSourceSyncRow = {
  storeKey: string;
  syncKey: string;
  entry: MemoryWikiImportedSourceStateEntry;
};

async function listLegacyImportedSourceSyncRows(params: {
  vaultRoot: string;
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
}): Promise<{ legacyRows: LegacyImportedSourceSyncRow[]; retainedKeys: string[] }> {
  const raw = params.openKeyedStore<MemoryWikiSourceSyncStateRecord>({
    namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
    maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  const vaultRootKey = resolveVaultRootKey(params.vaultRoot);
  const legacyRows: LegacyImportedSourceSyncRow[] = [];
  const retainedKeys: string[] = [];
  for (const row of await raw.entries()) {
    const value = row.value;
    if (
      value.vaultRootKey !== vaultRootKey ||
      typeof value.syncKey !== "string" ||
      isScopedImportedSourceSyncKey(value.syncKey)
    ) {
      continue;
    }
    const normalized = normalizeSourceSyncState({
      version: 1,
      entries: { [value.syncKey]: value },
    });
    const entry = normalized.entries[value.syncKey];
    if (!entry) {
      // Unknown shapes stay untouched: no runtime version can read them, and
      // deleting them is a data call the operator should see in warnings first.
      retainedKeys.push(value.syncKey);
      continue;
    }
    legacyRows.push({ storeKey: row.key, syncKey: value.syncKey, entry });
  }
  return { legacyRows, retainedKeys };
}

// Counts every unscoped row for the vault, including unknown shapes that stay
// retained. Runtime reads hide these rows, but they still occupy reject-new
// namespace capacity, so migration preflights must account for them.
export async function countLegacyImportedSourceSyncRows(params: {
  vaultRoot: string;
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
}): Promise<number> {
  const { legacyRows, retainedKeys } = await listLegacyImportedSourceSyncRows(params);
  return legacyRows.length + retainedKeys.length;
}

type LegacyImportedSourceSyncMigrationResult = {
  translatedCount: number;
  prunedCount: number;
  retainedKeys: string[];
  // Legacy rows restored after a racing writer claimed the freed slot
  // mid-rekey; the next doctor run retries them. Only reachable on hosts
  // without atomic rekey support, where a full namespace cannot hold the
  // temporary register-first replacement.
  capacityRetainedKeys: string[];
};

export function translateLegacyImportedSourceSyncKey(params: {
  entry: MemoryWikiImportedSourceStateEntry;
  syncKey: string;
  unsafeLocalConfiguredRoots: readonly string[];
}): string | undefined {
  if (params.entry.group === "bridge") {
    // Legacy rows carry no workspace binding, so they cannot be re-keyed to
    // the page binding here. The translated row keeps the page owned until the
    // next bridge sync re-owns it under the binding key; the shared-page prune
    // guard then retires this row without deleting the page.
    return scopeImportedSourceSyncKey("bridge", params.syncKey);
  }
  // The translated row must own the page the legacy row recorded: when nested
  // roots both contain the source, only the root whose page identity matches
  // the recorded page is the original binding. Anything else is a root move
  // and must go through the stale salvage path instead.
  const root = params.unsafeLocalConfiguredRoots.find(
    (candidate) =>
      isPathInside(candidate, params.entry.sourcePath) &&
      resolveUnsafeLocalPagePath({
        configuredPath: candidate,
        absolutePath: params.entry.sourcePath,
      }).pagePath === params.entry.pagePath,
  );
  return root
    ? scopeImportedSourceSyncKey("unsafe-local", `${root}\0${params.entry.sourcePath}`)
    : undefined;
}

export async function pruneLegacyImportedSourceRows(params: {
  vaultRoot: string;
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  rows: ReadonlyArray<{
    syncKey: string;
    entry: MemoryWikiImportedSourceStateEntry;
  }>;
}): Promise<number> {
  if (params.rows.length === 0) {
    return 0;
  }
  const store = createMemoryWikiSourceSyncStateStore(params.openKeyedStore);
  const state = await readMemoryWikiSourceSyncState(params.vaultRoot, store);
  for (const row of params.rows) {
    state.entries[row.syncKey] = row.entry;
  }
  // Keep every live scoped row; only the injected stale legacy rows prune.
  const activeKeys = new Set(
    Object.keys(state.entries).filter((key) => isScopedImportedSourceSyncKey(key)),
  );
  let prunedCount = 0;
  for (const group of new Set(params.rows.map((row) => row.entry.group))) {
    prunedCount += await pruneImportedSourceEntries({
      vaultRoot: params.vaultRoot,
      group,
      activeKeys,
      state,
    });
  }
  // The prune above tracks each removed stale row in the state's deleteKeys,
  // so this write takes the plan-based path: it deletes those rows from the
  // raw store by key directly. The unscoped-row skip lives only in the
  // plan-less full-write sweep and does not apply here.
  await writeMemoryWikiSourceSyncState(params.vaultRoot, state, store);
  return prunedCount;
}

export async function migrateLegacyImportedSourceSyncKeys(params: {
  vaultRoot: string;
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
  unsafeLocalConfiguredPaths: readonly string[];
}): Promise<LegacyImportedSourceSyncMigrationResult> {
  const raw = params.openKeyedStore<MemoryWikiSourceSyncStateRecord>({
    namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
    maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
    overflowPolicy: "reject-new",
  });
  const vaultRootKey = resolveVaultRootKey(params.vaultRoot);
  const { legacyRows, retainedKeys } = await listLegacyImportedSourceSyncRows(params);
  const configuredRoots = params.unsafeLocalConfiguredPaths.map((configuredPath) =>
    path.resolve(configuredPath),
  );

  // Two rekey paths, chosen by host capability. Stores with atomic rekey move
  // key and value in one slot-neutral transaction: no register-first spare
  // slot, no delete-first window, so a process kill mid-rekey can never drop
  // the only durable ownership record, full namespaces converge in one pass,
  // and reruns stay idempotent. Stores without it fall back to register-first
  // and retain the legacy row at capacity rather than opening a kill window.
  const migrateRow = async (
    row: LegacyImportedSourceSyncRow,
    nextSyncKey: string,
  ): Promise<"migrated" | "capacity"> => {
    const nextStoreKey = resolveStateEntryKey(vaultRootKey, nextSyncKey);
    if (await raw.lookup(nextStoreKey)) {
      await raw.delete(row.storeKey);
      return "migrated";
    }
    const nextValue = { ...row.entry, vaultRootKey, syncKey: nextSyncKey };
    if (raw.rekey) {
      const outcome = await raw.rekey(row.storeKey, nextStoreKey, nextValue);
      if (outcome === "conflict") {
        // A racing writer owns the scoped key, so the replacement is already
        // durable and the legacy duplicate can go.
        await raw.delete(row.storeKey);
      }
      // "rekeyed" moved the row; "missing" means it vanished mid-pass. Either
      // way no legacy row remains.
      return "migrated";
    }
    try {
      // registerIfAbsent, not register: a racing sync that wrote the scoped
      // key after the lookup above owns the newer row, and an upsert would
      // silently overwrite it with the older legacy value. An already-owned
      // target means the replacement is durable, so the legacy duplicate goes
      // either way.
      await raw.registerIfAbsent(nextStoreKey, nextValue);
      await raw.delete(row.storeKey);
      return "migrated";
    } catch (error) {
      if (!isPluginStateLimitExceeded(error)) {
        throw error;
      }
      // No atomic rekey and no spare slot: keep the legacy row durable and
      // retry on the next doctor run instead of deleting it first.
      return "capacity";
    }
  };

  let translatedCount = 0;
  const staleRows: LegacyImportedSourceSyncRow[] = [];
  const capacityRetainedKeys: string[] = [];
  for (const row of legacyRows) {
    const nextSyncKey = translateLegacyImportedSourceSyncKey({
      entry: row.entry,
      syncKey: row.syncKey,
      unsafeLocalConfiguredRoots: configuredRoots,
    });
    if (!nextSyncKey) {
      // The recorded binding no longer matches any configured unsafe-local
      // root: prune through the canonical salvage path, never drop silently.
      staleRows.push(row);
      continue;
    }
    if ((await migrateRow(row, nextSyncKey)) === "migrated") {
      translatedCount += 1;
    } else {
      capacityRetainedKeys.push(row.syncKey);
    }
  }

  // Prune stale rows last: the canonical salvage path owns their pages, and
  // the slots it frees are available to later migrations in the same pass.
  const prunedCount = await pruneLegacyImportedSourceRows({
    vaultRoot: params.vaultRoot,
    openKeyedStore: params.openKeyedStore,
    rows: staleRows,
  });

  return { translatedCount, prunedCount, retainedKeys, capacityRetainedKeys };
}
