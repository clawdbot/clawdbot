// Memory Wiki plugin module implements import run state behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  OpenKeyedStoreOptions,
  PluginStateKeyedStore,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import pMap from "p-map";

const LEGACY_IMPORT_RUN_READ_CONCURRENCY = 16;

type ChatGptImportRunEntry = {
  path: string;
  snapshotPath?: string;
};

export type ChatGptImportRunRecord = {
  version: 1;
  runId: string;
  importType: "chatgpt";
  exportPath: string;
  sourcePath: string;
  appliedAt: string;
  conversationCount: number;
  createdCount: number;
  updatedCount: number;
  skippedCount: number;
  createdPaths: string[];
  updatedPaths: ChatGptImportRunEntry[];
  rolledBackAt?: string;
};

type MemoryWikiImportRunStateStore = {
  read: (vaultRoot: string, runId: string) => Promise<ChatGptImportRunRecord | null>;
  write: (vaultRoot: string, record: ChatGptImportRunRecord) => Promise<void>;
  list: (vaultRoot: string) => Promise<ChatGptImportRunRecord[]>;
  rowCount: () => Promise<number>;
};

type MemoryWikiImportRunMetaStateRecord = Omit<
  ChatGptImportRunRecord,
  "createdPaths" | "updatedPaths"
> & {
  kind: "meta";
  vaultRootKey: string;
};

type MemoryWikiImportRunPathStateRecord = {
  kind: "created-path" | "updated-path";
  vaultRootKey: string;
  runId: string;
  index: number;
  path: string;
  snapshotPath?: string;
};

type MemoryWikiImportRunStateRecord =
  | MemoryWikiImportRunMetaStateRecord
  | MemoryWikiImportRunPathStateRecord;

export const MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE = "import-runs";
export const MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES = 20_000;

let configuredImportRunStore: MemoryWikiImportRunStateStore | undefined;
const memoryImportRunsByVault = new Map<string, Map<string, ChatGptImportRunRecord>>();

export function resolveMemoryWikiImportRunsDir(vaultRoot: string): string {
  return path.join(vaultRoot, ".openclaw-wiki", "import-runs");
}

function resolveVaultRootKey(vaultRoot: string): string {
  return createHash("sha256").update(path.resolve(vaultRoot), "utf8").digest("hex").slice(0, 32);
}

function resolveStateEntryKey(vaultRootKey: string, runId: string): string {
  return createHash("sha256").update(`${vaultRootKey}\0meta\0${runId}`, "utf8").digest("hex");
}

function resolvePathStateEntryKey(params: {
  vaultRootKey: string;
  runId: string;
  kind: MemoryWikiImportRunPathStateRecord["kind"];
  index: number;
  path: string;
}): string {
  return createHash("sha256")
    .update(
      `${params.vaultRootKey}\0${params.runId}\0${params.kind}\0${params.index}\0${params.path}`,
      "utf8",
    )
    .digest("hex");
}

function cloneImportRunRecord(record: ChatGptImportRunRecord): ChatGptImportRunRecord {
  return {
    ...record,
    createdPaths: [...record.createdPaths],
    updatedPaths: record.updatedPaths.map((entry) => ({ ...entry })),
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
  );
}

function asNonNegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function normalizeMemoryWikiImportRunRecord(raw: unknown): ChatGptImportRunRecord | null {
  const record = asRecord(raw);
  if (!record) {
    return null;
  }
  const runId = typeof record.runId === "string" ? record.runId.trim() : "";
  const exportPath = typeof record.exportPath === "string" ? record.exportPath.trim() : "";
  const sourcePath = typeof record.sourcePath === "string" ? record.sourcePath.trim() : "";
  const appliedAt = typeof record.appliedAt === "string" ? record.appliedAt.trim() : "";
  if (
    record.version !== 1 ||
    record.importType !== "chatgpt" ||
    !runId ||
    !exportPath ||
    !sourcePath ||
    !appliedAt
  ) {
    return null;
  }
  const updatedPaths = Array.isArray(record.updatedPaths)
    ? record.updatedPaths
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null)
        .flatMap((entry): ChatGptImportRunEntry[] => {
          const entryPath = typeof entry.path === "string" ? entry.path.trim() : "";
          if (!entryPath) {
            return [];
          }
          const snapshotPath =
            typeof entry.snapshotPath === "string" && entry.snapshotPath.trim()
              ? entry.snapshotPath.trim()
              : undefined;
          return [{ path: entryPath, ...(snapshotPath ? { snapshotPath } : {}) }];
        })
    : [];
  const rolledBackAt =
    typeof record.rolledBackAt === "string" && record.rolledBackAt.trim()
      ? record.rolledBackAt.trim()
      : undefined;
  return {
    version: 1,
    runId,
    importType: "chatgpt",
    exportPath,
    sourcePath,
    appliedAt,
    conversationCount: asNonNegativeInteger(record.conversationCount),
    createdCount: asNonNegativeInteger(record.createdCount),
    updatedCount: asNonNegativeInteger(record.updatedCount),
    skippedCount: asNonNegativeInteger(record.skippedCount),
    createdPaths: asStringArray(record.createdPaths),
    updatedPaths,
    ...(rolledBackAt ? { rolledBackAt } : {}),
  };
}

function normalizeMetaRecord(raw: unknown): MemoryWikiImportRunMetaStateRecord | null {
  const record = asRecord(raw);
  if (!record || record.kind !== "meta") {
    return null;
  }
  const normalized = normalizeMemoryWikiImportRunRecord({
    ...record,
    createdPaths: [],
    updatedPaths: [],
  });
  const vaultRootKey = typeof record.vaultRootKey === "string" ? record.vaultRootKey : "";
  return normalized && vaultRootKey
    ? {
        ...normalized,
        kind: "meta",
        vaultRootKey,
      }
    : null;
}

function normalizePathRecord(raw: unknown): MemoryWikiImportRunPathStateRecord | null {
  const record = asRecord(raw);
  if (
    !record ||
    (record.kind !== "created-path" && record.kind !== "updated-path") ||
    typeof record.vaultRootKey !== "string" ||
    typeof record.runId !== "string" ||
    typeof record.path !== "string" ||
    typeof record.index !== "number" ||
    !Number.isFinite(record.index)
  ) {
    return null;
  }
  const snapshotPath =
    typeof record.snapshotPath === "string" && record.snapshotPath.trim()
      ? record.snapshotPath.trim()
      : undefined;
  return {
    kind: record.kind,
    vaultRootKey: record.vaultRootKey,
    runId: record.runId,
    index: Math.max(0, Math.floor(record.index)),
    path: record.path,
    ...(snapshotPath ? { snapshotPath } : {}),
  };
}

function composeImportRunRecord(
  meta: MemoryWikiImportRunMetaStateRecord,
  pathRows: MemoryWikiImportRunPathStateRecord[],
): ChatGptImportRunRecord {
  const createdPaths = pathRows
    .filter((row) => row.kind === "created-path")
    .toSorted((left, right) => left.index - right.index)
    .map((row) => row.path);
  const updatedPaths = pathRows
    .filter((row) => row.kind === "updated-path")
    .toSorted((left, right) => left.index - right.index)
    .map((row) => {
      const entry: ChatGptImportRunEntry = { path: row.path };
      if (row.snapshotPath) {
        entry.snapshotPath = row.snapshotPath;
      }
      return entry;
    });
  return {
    version: 1,
    runId: meta.runId,
    importType: "chatgpt",
    exportPath: meta.exportPath,
    sourcePath: meta.sourcePath,
    appliedAt: meta.appliedAt,
    conversationCount: meta.conversationCount,
    createdCount: meta.createdCount,
    updatedCount: meta.updatedCount,
    skippedCount: meta.skippedCount,
    createdPaths,
    updatedPaths,
    ...(meta.rolledBackAt ? { rolledBackAt: meta.rolledBackAt } : {}),
  };
}

function toMetaRecord(
  vaultRootKey: string,
  record: ChatGptImportRunRecord,
): MemoryWikiImportRunMetaStateRecord {
  return {
    version: 1,
    kind: "meta",
    vaultRootKey,
    runId: record.runId,
    importType: "chatgpt",
    exportPath: record.exportPath,
    sourcePath: record.sourcePath,
    appliedAt: record.appliedAt,
    conversationCount: record.conversationCount,
    createdCount: record.createdCount,
    updatedCount: record.updatedCount,
    skippedCount: record.skippedCount,
    ...(record.rolledBackAt ? { rolledBackAt: record.rolledBackAt } : {}),
  };
}

function toPathRecords(
  vaultRootKey: string,
  record: ChatGptImportRunRecord,
): MemoryWikiImportRunPathStateRecord[] {
  return [
    ...record.createdPaths.map(
      (entryPath, index): MemoryWikiImportRunPathStateRecord => ({
        kind: "created-path",
        vaultRootKey,
        runId: record.runId,
        index,
        path: entryPath,
      }),
    ),
    ...record.updatedPaths.map(
      (entry, index): MemoryWikiImportRunPathStateRecord => ({
        kind: "updated-path",
        vaultRootKey,
        runId: record.runId,
        index,
        path: entry.path,
        ...(entry.snapshotPath ? { snapshotPath: entry.snapshotPath } : {}),
      }),
    ),
  ];
}

function createMemoryFallbackImportRunStore(): MemoryWikiImportRunStateStore {
  return {
    async read(vaultRoot, runId) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const record = memoryImportRunsByVault.get(vaultRootKey)?.get(runId);
      return record ? cloneImportRunRecord(record) : null;
    },
    async write(vaultRoot, record) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const records = memoryImportRunsByVault.get(vaultRootKey) ?? new Map();
      records.set(record.runId, cloneImportRunRecord(record));
      memoryImportRunsByVault.set(vaultRootKey, records);
    },
    async list(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      return [...(memoryImportRunsByVault.get(vaultRootKey)?.values() ?? [])].map(
        cloneImportRunRecord,
      );
    },
    async rowCount() {
      let count = 0;
      for (const records of memoryImportRunsByVault.values()) {
        for (const record of records.values()) {
          count += 1 + record.createdPaths.length + record.updatedPaths.length;
        }
      }
      return count;
    },
  };
}

export function createMemoryWikiImportRunStateStore(
  openKeyedStore: <T>(options: OpenKeyedStoreOptions) => PluginStateKeyedStore<T>,
): MemoryWikiImportRunStateStore {
  const openStore = () =>
    openKeyedStore<MemoryWikiImportRunStateRecord>({
      namespace: MEMORY_WIKI_IMPORT_RUN_STATE_NAMESPACE,
      maxEntries: MEMORY_WIKI_IMPORT_RUN_STATE_MAX_ENTRIES,
    });

  return {
    async read(vaultRoot, runId) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const row = await openStore().lookup(resolveStateEntryKey(vaultRootKey, runId));
      const meta = normalizeMetaRecord(row);
      if (!meta || meta.vaultRootKey !== vaultRootKey) {
        return null;
      }
      const pathRows = (await openStore().entries())
        .map((entry) => normalizePathRecord(entry.value))
        .filter(
          (entry): entry is MemoryWikiImportRunPathStateRecord =>
            entry !== null && entry.vaultRootKey === vaultRootKey && entry.runId === runId,
        );
      return composeImportRunRecord(meta, pathRows);
    },
    async write(vaultRoot, record) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const store = openStore();
      await store.register(
        resolveStateEntryKey(vaultRootKey, record.runId),
        toMetaRecord(vaultRootKey, record),
      );
      const nextPathKeys = new Set<string>();
      for (const pathRecord of toPathRecords(vaultRootKey, record)) {
        const key = resolvePathStateEntryKey({
          vaultRootKey,
          runId: record.runId,
          kind: pathRecord.kind,
          index: pathRecord.index,
          path: pathRecord.path,
        });
        nextPathKeys.add(key);
        await store.register(key, pathRecord);
      }
      for (const row of await store.entries()) {
        const pathRecord = normalizePathRecord(row.value);
        if (
          pathRecord?.vaultRootKey === vaultRootKey &&
          pathRecord.runId === record.runId &&
          !nextPathKeys.has(row.key)
        ) {
          await store.delete(row.key);
        }
      }
    },
    async list(vaultRoot) {
      const vaultRootKey = resolveVaultRootKey(vaultRoot);
      const metaRows = new Map<string, MemoryWikiImportRunMetaStateRecord>();
      const pathRows: MemoryWikiImportRunPathStateRecord[] = [];
      for (const row of await openStore().entries()) {
        const meta = normalizeMetaRecord(row.value);
        if (meta?.vaultRootKey === vaultRootKey) {
          metaRows.set(meta.runId, meta);
          continue;
        }
        const pathRecord = normalizePathRecord(row.value);
        if (pathRecord?.vaultRootKey === vaultRootKey) {
          pathRows.push(pathRecord);
        }
      }
      return [...metaRows.values()].map((meta) =>
        composeImportRunRecord(
          meta,
          pathRows.filter((row) => row.runId === meta.runId),
        ),
      );
    },
    async rowCount() {
      return (await openStore().entries()).length;
    },
  };
}

export function configureMemoryWikiImportRunStateStore(
  store: MemoryWikiImportRunStateStore | undefined,
): void {
  configuredImportRunStore = store;
}

function resolveImportRunStore(
  store?: MemoryWikiImportRunStateStore,
): MemoryWikiImportRunStateStore {
  return store ?? configuredImportRunStore ?? createMemoryFallbackImportRunStore();
}

export async function readMemoryWikiImportRunRecord(
  vaultRoot: string,
  runId: string,
  store?: MemoryWikiImportRunStateStore,
): Promise<ChatGptImportRunRecord | null> {
  return await resolveImportRunStore(store).read(vaultRoot, runId);
}

export async function writeMemoryWikiImportRunRecord(
  vaultRoot: string,
  record: ChatGptImportRunRecord,
  store?: MemoryWikiImportRunStateStore,
): Promise<void> {
  await resolveImportRunStore(store).write(vaultRoot, record);
}

export async function listMemoryWikiImportRunRecords(
  vaultRoot: string,
  store?: MemoryWikiImportRunStateStore,
): Promise<ChatGptImportRunRecord[]> {
  return await resolveImportRunStore(store).list(vaultRoot);
}

export async function countMemoryWikiImportRunStateRows(
  store?: MemoryWikiImportRunStateStore,
): Promise<number> {
  return await resolveImportRunStore(store).rowCount();
}

export async function readLegacyMemoryWikiImportRunRecords(
  vaultRoot: string,
): Promise<ChatGptImportRunRecord[]> {
  const importRunsDir = resolveMemoryWikiImportRunsDir(vaultRoot);
  const entries = await fs
    .readdir(importRunsDir, { withFileTypes: true })
    .catch((error: unknown) => {
      const code = asRecord(error)?.code;
      if (code === "ENOENT") {
        return [];
      }
      throw error;
    });
  const records = await pMap(
    entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")),
    async (entry) => {
      const raw = await fs.readFile(path.join(importRunsDir, entry.name), "utf8");
      return normalizeMemoryWikiImportRunRecord(JSON.parse(raw) as unknown);
    },
    { concurrency: LEGACY_IMPORT_RUN_READ_CONCURRENCY, stopOnError: true },
  );
  return records.filter((entry): entry is ChatGptImportRunRecord => entry !== null);
}
