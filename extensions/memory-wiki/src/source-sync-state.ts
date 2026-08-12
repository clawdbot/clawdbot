// Memory Wiki plugin module implements source sync state behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import { FsSafeError, root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createWikiPageFilename, extractHumanNotesBlock } from "./markdown.js";
import { resolveUnsafeLocalPagePath } from "./source-path-shared.js";

export type MemoryWikiImportedSourceGroup = "bridge" | "unsafe-local";

type MemoryWikiImportedSourceStateEntry = {
  group: MemoryWikiImportedSourceGroup;
  pagePath: string;
  sourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
};

type MemoryWikiImportedSourceState = {
  version: 1;
  entries: Record<string, MemoryWikiImportedSourceStateEntry>;
};

type MemoryWikiSourceSyncStateChanges = {
  upsertKeys: Set<string>;
  deleteKeys: Set<string>;
};

type MemoryWikiSourceSyncStateWritePlan = {
  upsertKeys: string[];
  deleteKeys: string[];
};

type MemoryWikiSourceSyncStateStore = {
  read: (vaultRoot: string) => Promise<MemoryWikiImportedSourceState>;
  write: (
    vaultRoot: string,
    state: MemoryWikiImportedSourceState,
    plan?: MemoryWikiSourceSyncStateWritePlan,
  ) => Promise<void>;
};

type MemoryWikiSourceSyncStateRecord = MemoryWikiImportedSourceStateEntry & {
  vaultRootKey: string;
  syncKey: string;
};

export const MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE = "source-sync";
export const MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES = 20_000;

// Ownership rows shipped in v2026.7.1 keyed only by canonical source path, so
// bridge and unsafe-local imports of one physical file overwrote each other's
// row and orphaned the losing page (#118370). Group-scoped keys keep both
// bindings owned, and each group binds the inputs that own its page identity:
// bridge binds workspaceDir + relativePath so aliased workspaces keep distinct
// pages; unsafe-local binds the configured root so moving a root re-keys
// instead of orphaning the previous page.
export function scopeImportedSourceSyncKey(
  group: MemoryWikiImportedSourceGroup,
  bindingKey: string,
): string {
  return `${group}:${bindingKey}`;
}

function isScopedImportedSourceSyncKey(syncKey: string): boolean {
  return syncKey.startsWith("bridge:") || syncKey.startsWith("unsafe-local:");
}

// The plugin SDK does not expose PluginStateStoreError; match the documented
// reject-new capacity contract structurally instead of widening SDK surface.
function isPluginStateLimitExceeded(error: unknown): boolean {
  return isRecord(error) && error.code === "PLUGIN_STATE_LIMIT_EXCEEDED";
}
const MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES = 16 * 1024 * 1024;
const MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES = 64 * 1024;
const MAX_MEMORY_WIKI_SOURCE_PAGE_SCAN_BYTES = 32 * 1024 * 1024;

const EMPTY_STATE: MemoryWikiImportedSourceState = {
  version: 1,
  entries: {},
};

let configuredSourceSyncStore: MemoryWikiSourceSyncStateStore | undefined;
const memorySourceSyncStateByVault = new Map<string, MemoryWikiImportedSourceState>();
const sourceSyncStateChanges = new WeakMap<
  MemoryWikiImportedSourceState,
  MemoryWikiSourceSyncStateChanges
>();

export function resolveMemoryWikiSourceSyncStatePath(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "source-sync.json");
}

function cloneSourceSyncState(state: MemoryWikiImportedSourceState): MemoryWikiImportedSourceState {
  return {
    version: 1,
    entries: Object.fromEntries(
      Object.entries(state.entries).map(([key, value]) => [key, { ...value }]),
    ),
  };
}

function normalizeSourceSyncState(value: unknown): MemoryWikiImportedSourceState {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return EMPTY_STATE;
  }
  const parsed = value as Partial<MemoryWikiImportedSourceState>;
  if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") {
    return EMPTY_STATE;
  }
  const entries: Record<string, MemoryWikiImportedSourceStateEntry> = {};
  for (const [syncKey, entry] of Object.entries(parsed.entries)) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      (entry.group !== "bridge" && entry.group !== "unsafe-local") ||
      typeof entry.pagePath !== "string" ||
      typeof entry.sourcePath !== "string" ||
      typeof entry.sourceUpdatedAtMs !== "number" ||
      typeof entry.sourceSize !== "number" ||
      typeof entry.renderFingerprint !== "string"
    ) {
      continue;
    }
    entries[syncKey] = {
      group: entry.group,
      pagePath: entry.pagePath,
      sourcePath: entry.sourcePath,
      sourceUpdatedAtMs: entry.sourceUpdatedAtMs,
      sourceSize: entry.sourceSize,
      renderFingerprint: entry.renderFingerprint,
    };
  }
  return { version: 1, entries };
}

function resolveVaultRootKey(vaultRoot: string): string {
  return createHash("sha256").update(path.resolve(vaultRoot), "utf8").digest("hex").slice(0, 32);
}

function resolveStateEntryKey(vaultRootKey: string, syncKey: string): string {
  return createHash("sha256").update(`${vaultRootKey}\0${syncKey}`, "utf8").digest("hex");
}

function createMemoryFallbackStateStore(): MemoryWikiSourceSyncStateStore {
  return {
    async read(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      return cloneSourceSyncState(memorySourceSyncStateByVault.get(vaultRootKey) ?? EMPTY_STATE);
    },
    async write(vaultRoot, state) {
      assertSourceSyncStateWithinLimit(state);
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      memorySourceSyncStateByVault.set(vaultRootKey, cloneSourceSyncState(state));
    },
  };
}

function assertSourceSyncStateWithinLimit(state: MemoryWikiImportedSourceState): void {
  const count = Object.keys(state.entries).length;
  if (count > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
    throw new Error(
      `Memory Wiki source sync state exceeds SQLite entry limit (${count}/${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES})`,
    );
  }
}

export function assertMemoryWikiSourceSyncStateCapacity(params: {
  state: MemoryWikiImportedSourceState;
  group: MemoryWikiImportedSourceGroup;
  incomingCount: number;
}): void {
  const retainedOtherGroupCount = Object.values(params.state.entries).filter(
    (entry) => entry.group !== params.group,
  ).length;
  const projectedCount = retainedOtherGroupCount + params.incomingCount;
  if (projectedCount > MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES) {
    throw new Error(
      `Memory Wiki source sync state exceeds SQLite entry limit (${projectedCount}/${MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES})`,
    );
  }
}

export function createMemoryWikiSourceSyncStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): MemoryWikiSourceSyncStateStore {
  const openStore = () =>
    openKeyedStore<MemoryWikiSourceSyncStateRecord>({
      namespace: MEMORY_WIKI_SOURCE_SYNC_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_SOURCE_SYNC_STATE_MAX_ENTRIES,
      overflowPolicy: "reject-new",
    });

  return {
    async read(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const entries: MemoryWikiImportedSourceState["entries"] = {};
      for (const row of await openStore().entries()) {
        const value = row.value;
        // Legacy unscoped rows stay invisible to runtime: the doctor migration
        // memory-wiki-source-sync-group-scoped-keys owns their translation, and
        // reading them here would let pruning delete pages that group-scoped
        // rows already own.
        if (
          value.vaultRootKey !== vaultRootKey ||
          typeof value.syncKey !== "string" ||
          !isScopedImportedSourceSyncKey(value.syncKey)
        ) {
          continue;
        }
        const normalized = normalizeSourceSyncState({
          version: 1,
          entries: { [value.syncKey]: value },
        });
        const entry = normalized.entries[value.syncKey];
        if (entry) {
          entries[value.syncKey] = entry;
        }
      }
      return { version: 1, entries };
    },
    async write(vaultRoot, state, plan) {
      assertSourceSyncStateWithinLimit(state);
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const store = openStore();
      if (plan) {
        for (const syncKey of plan.deleteKeys) {
          await store.delete(resolveStateEntryKey(vaultRootKey, syncKey));
        }
        for (const syncKey of plan.upsertKeys) {
          const entry = state.entries[syncKey];
          if (!entry) {
            throw new Error(`Missing tracked Memory Wiki source sync entry: ${syncKey}`);
          }
          await store.register(resolveStateEntryKey(vaultRootKey, syncKey), {
            ...entry,
            vaultRootKey,
            syncKey,
          });
        }
        return;
      }
      const normalized = normalizeSourceSyncState(state);
      const nextKeys = new Set(
        Object.keys(normalized.entries).map((syncKey) =>
          resolveStateEntryKey(vaultRootKey, syncKey),
        ),
      );
      for (const row of await store.entries()) {
        if (row.value.vaultRootKey === vaultRootKey && !nextKeys.has(row.key)) {
          // Legacy unscoped rows are owned by the group-scoped-keys doctor
          // migration; a full write must never delete them out from under it.
          if (
            typeof row.value.syncKey === "string" &&
            !isScopedImportedSourceSyncKey(row.value.syncKey)
          ) {
            continue;
          }
          await store.delete(row.key);
        }
      }
      for (const [syncKey, entry] of Object.entries(normalized.entries)) {
        await store.register(resolveStateEntryKey(vaultRootKey, syncKey), {
          ...entry,
          vaultRootKey,
          syncKey,
        });
      }
    },
  };
}

export function configureMemoryWikiSourceSyncStateStore(
  store: MemoryWikiSourceSyncStateStore | undefined,
): void {
  configuredSourceSyncStore = store;
}

function resolveSourceSyncStore(
  store?: MemoryWikiSourceSyncStateStore,
): MemoryWikiSourceSyncStateStore {
  return store ?? configuredSourceSyncStore ?? createMemoryFallbackStateStore();
}

export async function readMemoryWikiSourceSyncState(
  vaultRoot: string,
  store?: MemoryWikiSourceSyncStateStore,
): Promise<MemoryWikiImportedSourceState> {
  const state = await resolveSourceSyncStore(store).read(vaultRoot);
  sourceSyncStateChanges.set(state, { upsertKeys: new Set(), deleteKeys: new Set() });
  return state;
}

export async function readLegacyMemoryWikiSourceSyncState(
  vaultRoot: string,
): Promise<MemoryWikiImportedSourceState> {
  const statePath = resolveMemoryWikiSourceSyncStatePath(vaultRoot);
  const { value: parsed } = await readJsonFileWithFallback<unknown>(statePath, EMPTY_STATE);
  return normalizeSourceSyncState(parsed);
}

export async function writeMemoryWikiSourceSyncState(
  vaultRoot: string,
  state: MemoryWikiImportedSourceState,
  store?: MemoryWikiSourceSyncStateStore,
): Promise<void> {
  const changes = sourceSyncStateChanges.get(state);
  if (changes && changes.upsertKeys.size === 0 && changes.deleteKeys.size === 0) {
    return;
  }
  const plan = changes
    ? {
        upsertKeys: [...changes.upsertKeys],
        deleteKeys: [...changes.deleteKeys],
      }
    : undefined;
  await resolveSourceSyncStore(store).write(vaultRoot, state, plan);
  changes?.upsertKeys.clear();
  changes?.deleteKeys.clear();
}

export async function shouldSkipImportedSourceWrite(params: {
  vaultRoot: string;
  syncKey: string;
  expectedPagePath: string;
  expectedSourcePath: string;
  sourceUpdatedAtMs: number;
  sourceSize: number;
  renderFingerprint: string;
  state: MemoryWikiImportedSourceState;
}): Promise<boolean> {
  const entry = params.state.entries[params.syncKey];
  if (!entry) {
    return false;
  }
  if (
    entry.pagePath !== params.expectedPagePath ||
    entry.sourcePath !== params.expectedSourcePath ||
    entry.sourceUpdatedAtMs !== params.sourceUpdatedAtMs ||
    entry.sourceSize !== params.sourceSize ||
    entry.renderFingerprint !== params.renderFingerprint
  ) {
    return false;
  }
  const pagePath = path.join(params.vaultRoot, params.expectedPagePath);
  return await fs
    .access(pagePath)
    .then(() => true)
    .catch(() => false);
}

function removeImportedSourceStateEntry(
  state: MemoryWikiImportedSourceState,
  syncKey: string,
): void {
  delete state.entries[syncKey];
  const changes = sourceSyncStateChanges.get(state);
  changes?.upsertKeys.delete(syncKey);
  changes?.deleteKeys.add(syncKey);
}

async function readImportedSourcePageForNotes(
  vault: Awaited<ReturnType<typeof fsRoot>>,
  pagePath: string,
): Promise<string> {
  try {
    return await vault.readText(pagePath, {
      maxBytes: MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES,
    });
  } catch (error) {
    if (!(error instanceof FsSafeError && error.code === "too-large")) {
      throw error;
    }
  }

  // Pin the same safe file while reading only its source header and trailing
  // Notes; large generated source content must not prevent safe pruning.
  const opened = await vault.open(pagePath);
  try {
    const readSlice = async (position: number, length: number): Promise<string> => {
      const buffer = Buffer.alloc(length);
      let totalBytesRead = 0;
      while (totalBytesRead < length) {
        const { bytesRead } = await opened.handle.read(
          buffer,
          totalBytesRead,
          length - totalBytesRead,
          position + totalBytesRead,
        );
        if (bytesRead === 0) {
          throw new Error("Memory Wiki source page changed during bounded Notes recovery");
        }
        totalBytesRead += bytesRead;
      }
      return buffer.toString("utf8");
    };

    const headerBytes = Math.min(MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES, opened.stat.size);
    const header = await readSlice(0, headerBytes);

    const contentFence = /(?:^|\r?\n)## Content\r?\n(`+)[^\r\n]*(?=\r?\n|$)/u.exec(header);
    if (!contentFence) {
      throw new Error("Memory Wiki source content fence is missing from the recovery header");
    }
    const fence = contentFence[1];
    // Scan from the pinned descriptor so the first complete producer-owned
    // boundary wins; a similar fence inside later human Notes cannot qualify.
    const notesBoundary = new RegExp(
      `\\r?\\n${fence}\\r?\\n(?:[\\t ]*\\r?\\n)*## Notes\\r?\\n<!-- openclaw:human:start -->(?=\\r?\\n|$)`,
      "u",
    );
    const decoder = new TextDecoder();
    let pending = "";
    let notes = "";
    let notesBytes = 0;
    let scannedBytes = headerBytes;
    let foundNotesBoundary = false;

    const consume = (text: string): void => {
      if (!text) {
        return;
      }
      let notesText = text;
      if (!foundNotesBoundary) {
        pending += text;
        const boundary = notesBoundary.exec(pending);
        if (!boundary) {
          pending = pending.slice(-MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES);
          return;
        }
        foundNotesBoundary = true;
        notesText = pending.slice(boundary.index);
        pending = "";
      }
      notesBytes += Buffer.byteLength(notesText, "utf8");
      if (headerBytes + notesBytes > MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES) {
        throw new Error("Memory Wiki human Notes exceed the bounded recovery limit");
      }
      notes += notesText;
    };

    consume(header);
    const stream = opened.handle.createReadStream({
      autoClose: false,
      highWaterMark: MAX_MEMORY_WIKI_SOURCE_PAGE_HEADER_BYTES,
      start: headerBytes,
    });
    for await (const chunk of stream) {
      scannedBytes += chunk.byteLength;
      if (scannedBytes > MAX_MEMORY_WIKI_SOURCE_PAGE_SCAN_BYTES) {
        throw new Error("Memory Wiki source page exceeds the bounded recovery scan limit");
      }
      consume(decoder.decode(chunk, { stream: true }));
    }
    consume(decoder.decode());

    if (!foundNotesBoundary) {
      throw new Error("Memory Wiki source Notes boundary exceeds the bounded recovery limit");
    }

    return `${header}\n${notes}`;
  } finally {
    await opened.handle.close();
  }
}

export async function pruneImportedSourceEntries(params: {
  vaultRoot: string;
  group: MemoryWikiImportedSourceGroup;
  activeKeys: Set<string>;
  state: MemoryWikiImportedSourceState;
}): Promise<number> {
  let removedCount = 0;
  let vault: Awaited<ReturnType<typeof fsRoot>> | undefined;
  // Page paths shared with another live row must survive pruning: during key
  // format transitions two rows can transiently own one page, and deleting it
  // would destroy the page the surviving row still tracks.
  const pageRefCounts = new Map<string, number>();
  for (const entry of Object.values(params.state.entries)) {
    pageRefCounts.set(entry.pagePath, (pageRefCounts.get(entry.pagePath) ?? 0) + 1);
  }
  for (const [syncKey, entry] of Object.entries(params.state.entries)) {
    if (entry.group !== params.group || params.activeKeys.has(syncKey)) {
      continue;
    }
    if ((pageRefCounts.get(entry.pagePath) ?? 0) > 1) {
      removeImportedSourceStateEntry(params.state, syncKey);
      removedCount += 1;
      continue;
    }
    try {
      vault ??= await fsRoot(params.vaultRoot);
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        throw error;
      }
      removeImportedSourceStateEntry(params.state, syncKey);
      removedCount += 1;
      continue;
    }
    // Recover durable Notes before removing an imported source page. The root
    // handle applies containment and no-follow checks to each operation.
    let pageContent: string | undefined;
    try {
      pageContent = await readImportedSourcePageForNotes(vault, entry.pagePath);
    } catch (error) {
      if (!(error instanceof FsSafeError && error.code === "not-found")) {
        continue;
      }
    }
    const notesBlock = pageContent === undefined ? null : extractHumanNotesBlock(pageContent);
    if (notesBlock) {
      const salvageStem = entry.pagePath.replace(/\//g, "_");
      const contentHash = createHash("sha256").update(notesBlock).digest("hex").slice(0, 16);
      const salvagePaths = [
        path.join(".salvage", createWikiPageFilename(salvageStem, ".notes.md")),
        path.join(".salvage", createWikiPageFilename(`${salvageStem}.${contentHash}`, ".notes.md")),
      ];
      let notesSalvaged = false;
      // Content-addressed retries preserve prior recoveries without growing on failed removes.
      for (const salvagePath of salvagePaths) {
        try {
          await vault.create(salvagePath, notesBlock, { mkdir: true });
          notesSalvaged = true;
          break;
        } catch (error) {
          if (!(error instanceof FsSafeError && error.code === "already-exists")) {
            break;
          }
          try {
            if (
              (await vault.readText(salvagePath, {
                maxBytes: MAX_MEMORY_WIKI_NOTES_RECOVERY_BYTES,
              })) === notesBlock
            ) {
              notesSalvaged = true;
              break;
            }
          } catch {
            break;
          }
        }
      }
      if (!notesSalvaged) {
        continue;
      }
    }
    if (pageContent !== undefined) {
      try {
        await vault.remove(entry.pagePath);
      } catch (error) {
        if (!(error instanceof FsSafeError && error.code === "not-found")) {
          continue;
        }
      }
    }
    removeImportedSourceStateEntry(params.state, syncKey);
    removedCount += 1;
  }
  return removedCount;
}

export function setImportedSourceEntry(params: {
  syncKey: string;
  entry: MemoryWikiImportedSourceStateEntry;
  state: MemoryWikiImportedSourceState;
}): void {
  const current = params.state.entries[params.syncKey];
  if (
    current?.group === params.entry.group &&
    current.pagePath === params.entry.pagePath &&
    current.sourcePath === params.entry.sourcePath &&
    current.sourceUpdatedAtMs === params.entry.sourceUpdatedAtMs &&
    current.sourceSize === params.entry.sourceSize &&
    current.renderFingerprint === params.entry.renderFingerprint
  ) {
    return;
  }
  params.state.entries[params.syncKey] = params.entry;
  const changes = sourceSyncStateChanges.get(params.state);
  changes?.deleteKeys.delete(params.syncKey);
  changes?.upsertKeys.add(params.syncKey);
}

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

export async function countLegacyImportedSourceSyncRows(params: {
  vaultRoot: string;
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>;
}): Promise<number> {
  const { legacyRows } = await listLegacyImportedSourceSyncRows(params);
  return legacyRows.length;
}

type LegacyImportedSourceSyncMigrationResult = {
  translatedCount: number;
  prunedCount: number;
  retainedKeys: string[];
  // Legacy rows kept because a full reject-new namespace could not hold the
  // scoped replacement; deleting them first would risk losing durable
  // ownership between two separate write transactions.
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

  // Migrates one legacy row to its scoped key. Returns "capacity" when a full
  // reject-new namespace cannot hold the temporary extra row; the legacy row
  // is left untouched in that case so durable ownership is never lost.
  const migrateRow = async (
    row: LegacyImportedSourceSyncRow,
    nextSyncKey: string,
  ): Promise<"migrated" | "capacity"> => {
    const nextStoreKey = resolveStateEntryKey(vaultRootKey, nextSyncKey);
    if (await raw.lookup(nextStoreKey)) {
      await raw.delete(row.storeKey);
      return "migrated";
    }
    try {
      // Register the scoped replacement before deleting the legacy row so a
      // crash mid-migration never loses ownership; reruns are idempotent.
      await raw.register(nextStoreKey, { ...row.entry, vaultRootKey, syncKey: nextSyncKey });
    } catch (error) {
      if (!isPluginStateLimitExceeded(error)) {
        throw error;
      }
      return "capacity";
    }
    await raw.delete(row.storeKey);
    return "migrated";
  };

  let translatedCount = 0;
  const staleRows: LegacyImportedSourceSyncRow[] = [];
  const capacityRows: { row: LegacyImportedSourceSyncRow; nextSyncKey: string }[] = [];
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
      capacityRows.push({ row, nextSyncKey });
    }
  }

  // Prune stale rows before retrying capacity-blocked ones: pruning frees
  // namespace slots that may let those translations complete in the same run.
  const prunedCount = await pruneLegacyImportedSourceRows({
    vaultRoot: params.vaultRoot,
    openKeyedStore: params.openKeyedStore,
    rows: staleRows,
  });

  for (const { row, nextSyncKey } of capacityRows) {
    if ((await migrateRow(row, nextSyncKey)) === "migrated") {
      translatedCount += 1;
      continue;
    }
    // Still no free slot. Deleting the legacy row first would leave a crash
    // window with no durable ownership at all, so retain it instead; Doctor
    // surfaces a warning and a later run retries once capacity frees up.
    capacityRetainedKeys.push(row.syncKey);
  }

  return { translatedCount, prunedCount, retainedKeys, capacityRetainedKeys };
}
