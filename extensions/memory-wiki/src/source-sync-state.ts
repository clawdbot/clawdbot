// Memory Wiki plugin module implements source sync state behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { readJsonFileWithFallback } from "openclaw/plugin-sdk/json-store";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";

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
        if (value.vaultRootKey !== vaultRootKey || typeof value.syncKey !== "string") {
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

const HUMAN_START = "<!-- openclaw:human:start -->";
const HUMAN_END = "<!-- openclaw:human:end -->";
const CONTENT_HEADING_RE = /(?:^|\r?\n)## Content\r?\n/u;

/**
 * Find the end of the fenced code block that follows the `## Content` heading.
 * Mirrors `afterSourceContentFence` in markdown.ts so the salvage path avoids
 * treating marker comments inside imported source content as human Notes.
 */
function afterContentFence(page: string): number {
  const heading = CONTENT_HEADING_RE.exec(page);
  if (!heading) {
    return 0;
  }
  const fenceLineStart = heading.index + heading[0].length;
  const fence = /^`+/.exec(page.slice(fenceLineStart))?.[0];
  if (!fence) {
    return fenceLineStart;
  }
  const closingFence = new RegExp(`\\r?\\n${fence}(?=\\r?\\n|$)`, "u");
  const close = closingFence.exec(page.slice(fenceLineStart + fence.length));
  if (!close) {
    return fenceLineStart;
  }
  return fenceLineStart + fence.length + close.index + close[0].length;
}

/**
 * Extract the human Notes block from a wiki page. Only searches after the
 * `## Content` fenced block so marker comments inside imported source body
 * do not produce a false positive.
 */
function extractHumanNotesBlock(content: string): string | null {
  const searchFrom = afterContentFence(content);
  const start = content.indexOf(HUMAN_START, searchFrom);
  if (start === -1) {
    return null;
  }
  const end = content.lastIndexOf(HUMAN_END);
  if (end < start) {
    return null;
  }
  return content.slice(start, end + HUMAN_END.length);
}

export async function pruneImportedSourceEntries(params: {
  vaultRoot: string;
  group: MemoryWikiImportedSourceGroup;
  activeKeys: Set<string>;
  state: MemoryWikiImportedSourceState;
}): Promise<number> {
  let removedCount = 0;
  for (const [syncKey, entry] of Object.entries(params.state.entries)) {
    if (entry.group !== params.group || params.activeKeys.has(syncKey)) {
      continue;
    }
    const pageAbsPath = path.join(params.vaultRoot, entry.pagePath);
    // Before removing the page, salvage any human-authored Notes block
    // so legitimate prunes (renamed/deleted workspaces) don't silently
    // destroy durable annotations. See openclaw/openclaw#102230.
    let notesBlock: string | null = null;
    try {
      const pageContent = await fs.readFile(pageAbsPath, "utf-8");
      notesBlock = extractHumanNotesBlock(pageContent);
    } catch (err) {
      // A genuinely missing page is safe to prune (it was already removed).
      // Transient failures (EBUSY, EMFILE, EACCES, EPERM) must keep the
      // page — otherwise Notes are lost when unlink succeeds but read fails.
      if (!(err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        continue;
      }
    }
    if (notesBlock) {
      const salvageDir = path.join(params.vaultRoot, ".salvage");
      const salvagePath = path.join(salvageDir, `${entry.pagePath.replace(/\//g, "_")}.notes.md`);
      try {
        await fs.mkdir(salvageDir, { recursive: true });
        await fs.writeFile(salvagePath, notesBlock, "utf-8");
      } catch {
        // Salvage write failed — keep the page so Notes are not lost.
        continue;
      }
    }
    await fs.rm(pageAbsPath, { force: true }).catch(() => undefined);
    delete params.state.entries[syncKey];
    const changes = sourceSyncStateChanges.get(params.state);
    changes?.upsertKeys.delete(syncKey);
    changes?.deleteKeys.add(syncKey);
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
