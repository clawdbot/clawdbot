// Memory Core helper module supports test helpers behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll } from "vitest";
import { normalizeDailyIngestionState, normalizeSessionIngestionState } from "./dreaming-phases.js";
import {
  configureMemoryCoreDreamingState,
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
  DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  readMemoryCoreWorkspaceEntries,
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import {
  normalizeShortTermPhaseSignalStore,
  normalizeShortTermRecallStore,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";

export async function configureMemoryCoreDreamingStateForTests(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const testEnv = { ...env };
  configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) =>
    createPluginStateKeyedStoreForTests<T>(MEMORY_CORE_PLUGIN_ID, { ...options, env: testEnv }),
  );
}

export function resetMemoryCoreDreamingStateForTests(): void {
  configureMemoryCoreDreamingState((_options: OpenKeyedStoreOptions) => {
    throw new Error("memory-core dreaming SQLite state store is not configured");
  });
}

type ShortTermStoreMeta = { updatedAt: string };

type ShortTermLockEntry = {
  owner: string;
  acquiredAt: number;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

async function readShortTermStoreEntries<T>(params: {
  namespace: string;
  workspaceDir: string;
  metaKey: "recall" | "phase";
  nowIso: string;
}): Promise<{ updatedAt: string; entries: Record<string, T> }> {
  const [entryRows, metaRows] = await Promise.all([
    readMemoryCoreWorkspaceEntries<T>({
      namespace: params.namespace,
      workspaceDir: params.workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<ShortTermStoreMeta>({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: params.workspaceDir,
    }),
  ]);
  return {
    updatedAt:
      metaRows.find((entry) => entry.key === params.metaKey)?.value.updatedAt ?? params.nowIso,
    entries: Object.fromEntries(entryRows.map((entry) => [entry.key, entry.value])),
  };
}

async function writeRawShortTermStore(params: {
  workspaceDir: string;
  raw: unknown;
  namespace: string;
  metaKey: "recall" | "phase";
}): Promise<void> {
  const record = asRecord(params.raw);
  const entries = asRecord(record?.entries);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: params.namespace,
      workspaceDir: params.workspaceDir,
      entries: entries ? Object.entries(entries).map(([key, value]) => ({ key, value })) : [],
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir: params.workspaceDir,
      key: params.metaKey,
      value: {
        updatedAt:
          typeof record?.updatedAt === "string" && record.updatedAt.trim()
            ? record.updatedAt
            : new Date().toISOString(),
      },
    }),
  ]);
}

export const shortTermTestState = {
  SHORT_TERM_RECALL_MAX_ENTRIES: 512,
  SHORT_TERM_RECALL_MAX_SNIPPET_CHARS: 800,
  async readRecallStore(workspaceDir: string, nowIso: string) {
    const raw = await readShortTermStoreEntries<ShortTermRecallEntry>({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      metaKey: "recall",
      nowIso,
    });
    return normalizeShortTermRecallStore({ version: 1, ...raw }, nowIso);
  },
  async readPhaseSignalStore(workspaceDir: string, nowIso: string) {
    const raw = await readShortTermStoreEntries<unknown>({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir,
      metaKey: "phase",
      nowIso,
    });
    return normalizeShortTermPhaseSignalStore({ version: 1, ...raw }, nowIso);
  },
  writeRawRecallStore: (workspaceDir: string, raw: unknown) =>
    writeRawShortTermStore({
      workspaceDir,
      raw,
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      metaKey: "recall",
    }),
  writeRawPhaseSignalStore: (workspaceDir: string, raw: unknown) =>
    writeRawShortTermStore({
      workspaceDir,
      raw,
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      metaKey: "phase",
    }),
  async writeShortTermLock(workspaceDir: string, entry: ShortTermLockEntry) {
    await openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    }).register(memoryCoreWorkspaceStateKey(workspaceDir), entry);
  },
  async deleteShortTermLock(workspaceDir: string) {
    await openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    }).delete(memoryCoreWorkspaceStateKey(workspaceDir));
  },
};

export const dreamingTestState = {
  async readDailyIngestionState(workspaceDir: string) {
    const entries = await readMemoryCoreWorkspaceEntries({
      namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
      workspaceDir,
    });
    return normalizeDailyIngestionState({
      version: 1,
      files: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
    });
  },
  async readSessionIngestionState(workspaceDir: string) {
    const [fileEntries, seenChunks] = await Promise.all([
      readMemoryCoreWorkspaceEntries<Record<string, unknown>>({
        namespace: DREAMING_SESSION_INGESTION_FILES_NAMESPACE,
        workspaceDir,
      }),
      readMemoryCoreWorkspaceEntries<{ scope: string; index: number; hashes: string[] }>({
        namespace: DREAMING_SESSION_INGESTION_SEEN_NAMESPACE,
        workspaceDir,
      }),
    ]);
    const chunksByScope = new Map<string, Array<{ index: number; hashes: string[] }>>();
    for (const chunk of seenChunks) {
      const chunks = chunksByScope.get(chunk.value.scope) ?? [];
      chunks.push({ index: chunk.value.index, hashes: chunk.value.hashes });
      chunksByScope.set(chunk.value.scope, chunks);
    }
    return normalizeSessionIngestionState({
      version: 3,
      files: Object.fromEntries(fileEntries.map((entry) => [entry.key, entry.value])),
      seenMessages: Object.fromEntries(
        [...chunksByScope].map(([scope, chunks]) => [
          scope,
          chunks.toSorted((a, b) => a.index - b.index).flatMap((chunk) => chunk.hashes),
        ]),
      ),
    });
  },
};

export function createMemoryCoreTestHarness() {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(
      path.join(resolvePreferredOpenClawTmpDir(), "memory-core-test-fixtures-"),
    );
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  async function createTempWorkspace(prefix: string): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `${prefix}${caseId++}`);
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  return {
    createTempWorkspace,
  };
}
