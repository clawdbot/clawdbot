// Memory Core helper module supports test helpers behavior.
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { afterAll, beforeAll } from "vitest";
import { consolidateMemory } from "./dreaming-consolidation.js";
import {
  normalizeDailyIngestionState,
  normalizeSessionIngestionState,
} from "./dreaming-ingestion-state.js";
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
import { applyShortTermPromotions } from "./short-term-promotion-apply.js";
import {
  normalizeShortTermPhaseSignalStore,
  readShortTermStore,
} from "./short-term-promotion-store.js";
import type { ShortTermLockEntry } from "./short-term-promotion-types.js";
import { normalizeShortTermRecallStore } from "./short-term-promotion-utils.js";

const MEMORY_CORE_PLUGIN_ID = "memory-core";
const MEMORY_CORE_TEST_AGENT_ID = "memory-core-test";

export function consolidateMemoryForTests(
  params: Omit<Parameters<typeof consolidateMemory>[0], "agentId">,
) {
  return consolidateMemory({ ...params, agentId: MEMORY_CORE_TEST_AGENT_ID });
}

export function applyShortTermPromotionsForTests(
  params: Omit<Parameters<typeof applyShortTermPromotions>[0], "agentId">,
) {
  return applyShortTermPromotions({ ...params, agentId: MEMORY_CORE_TEST_AGENT_ID });
}

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

async function writeRawShortTermStore(params: {
  workspaceDir: string;
  raw: unknown;
  namespace: string;
  metaKey: "recall" | "phase";
}): Promise<void> {
  const record = asOptionalRecord(params.raw);
  const entries = asOptionalRecord(record?.entries);
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
    return normalizeShortTermRecallStore(
      await readShortTermStore(workspaceDir, "recall", nowIso),
      nowIso,
    );
  },
  async readPhaseSignalStore(workspaceDir: string, nowIso: string) {
    return normalizeShortTermPhaseSignalStore(
      await readShortTermStore(workspaceDir, "phase", nowIso),
      nowIso,
    );
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
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
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
