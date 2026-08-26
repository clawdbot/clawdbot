import fsSync from "node:fs";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { PluginStateKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  memoryCoreStateReference,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import type {
  ShortTermLockEntry,
  ShortTermPhaseSignalEntry,
  ShortTermPhaseSignalStore,
  ShortTermRecallEntry,
  ShortTermRecallStore,
  ShortTermStoreMeta,
} from "./short-term-promotion-types.js";
import {
  enforceShortTermRecallSnippetCap,
  enforceShortTermRecallStoreRetention,
  normalizeShortTermRecallStore,
  toFiniteNonNegativeInt,
} from "./short-term-promotion-utils.js";

const SHORT_TERM_LOCK_WAIT_TIMEOUT_MS = 10_000;
export const SHORT_TERM_LOCK_STALE_MS = 60_000;
const SHORT_TERM_LOCK_RETRY_DELAY_MS = 40;
const inProcessShortTermLocks = new KeyedAsyncQueue();

export function resolveStorePath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_RECALL_NAMESPACE, workspaceDir);
}

export function resolvePhaseSignalPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_PHASE_SIGNAL_NAMESPACE, workspaceDir);
}

export function resolveLockPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_LOCK_NAMESPACE, workspaceDir);
}

export function parseLockOwnerPid(raw: string): number | null {
  const match = raw.trim().match(/^(\d+):/);
  if (!match) {
    return null;
  }
  const pid = Number.parseInt(match[1] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return pid;
}

export function isProcessLikelyAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM and unknown errors remain potentially alive unless procfs proves a zombie.
  }
  if (process.platform !== "linux") {
    return true;
  }
  try {
    const status = fsSync.readFileSync(`/proc/${pid}/status`, "utf8");
    const state = status.match(/^State:\s+(\S)/m)?.[1];
    return state !== "Z" && state !== "X";
  } catch {
    // An unreadable proc entry is not enough evidence to steal an active lock.
    return true;
  }
}

export async function deleteShortTermLockEntryIfCurrent(
  lockStore: PluginStateKeyedStore<ShortTermLockEntry>,
  lockKey: string,
  expected: ShortTermLockEntry,
): Promise<boolean> {
  if (!lockStore.deleteIf) {
    throw new Error("memory-core short-term lock store requires conditional deletion");
  }
  return await lockStore.deleteIf(
    lockKey,
    (current) => current.owner === expected.owner && current.acquiredAt === expected.acquiredAt,
  );
}

async function withInProcessShortTermLock<T>(lockPath: string, task: () => Promise<T>): Promise<T> {
  return await inProcessShortTermLocks.enqueue(lockPath, task);
}

export async function withShortTermLock<T>(
  workspaceDir: string,
  task: () => Promise<T>,
): Promise<T> {
  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const lockRef = resolveLockPath(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  return withInProcessShortTermLock(lockKey, async () => {
    const startedAt = Date.now();

    while (true) {
      const lockEntry: ShortTermLockEntry = {
        owner: `${process.pid}:${Date.now()}`,
        acquiredAt: Date.now(),
      };
      const acquired = await lockStore.registerIfAbsent(lockKey, lockEntry);
      if (acquired) {
        try {
          return await task();
        } finally {
          await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, lockEntry).catch(() => false);
        }
      }

      const existing = await lockStore.lookup(lockKey);
      if (existing && Date.now() - existing.acquiredAt > SHORT_TERM_LOCK_STALE_MS) {
        const ownerPid = parseLockOwnerPid(existing.owner);
        if (ownerPid === null || !isProcessLikelyAlive(ownerPid)) {
          if (await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, existing)) {
            continue;
          }
        }
      }

      if (Date.now() - startedAt >= SHORT_TERM_LOCK_WAIT_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for short-term promotion lock at ${lockRef}`);
      }

      await sleep(SHORT_TERM_LOCK_RETRY_DELAY_MS);
    }
  });
}

export async function readStore(
  workspaceDir: string,
  nowIso: string,
): Promise<ShortTermRecallStore> {
  const [entryRows, metaRows] = await Promise.all([
    readMemoryCoreWorkspaceEntries<ShortTermRecallEntry>({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<ShortTermStoreMeta>({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
    }),
  ]);
  const meta = metaRows.find((entry) => entry.key === "recall")?.value;
  const store = normalizeShortTermRecallStore(
    {
      version: 1,
      updatedAt: meta?.updatedAt ?? nowIso,
      entries: Object.fromEntries(entryRows.map((entry) => [entry.key, entry.value])),
    },
    nowIso,
  );
  enforceShortTermRecallStoreRetention(store);
  return store;
}

export function emptyPhaseSignalStore(nowIso: string): ShortTermPhaseSignalStore {
  return {
    version: 1,
    updatedAt: nowIso,
    entries: {},
  };
}

export function normalizeShortTermPhaseSignalStore(
  raw: unknown,
  nowIso: string,
): ShortTermPhaseSignalStore {
  const record = asNullableRecord(raw);
  if (!record) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entriesRaw = asNullableRecord(record?.entries);
  if (!entriesRaw) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entries: Record<string, ShortTermPhaseSignalEntry> = {};
  for (const [mapKey, value] of Object.entries(entriesRaw)) {
    const entry = asNullableRecord(value);
    if (!entry) {
      continue;
    }
    const key = typeof entry.key === "string" && entry.key.trim().length > 0 ? entry.key : mapKey;
    const lightHits = toFiniteNonNegativeInt(entry.lightHits, 0);
    const remHits = toFiniteNonNegativeInt(entry.remHits, 0);
    if (lightHits === 0 && remHits === 0) {
      continue;
    }
    const lastLightAt =
      typeof entry.lastLightAt === "string" && entry.lastLightAt.trim().length > 0
        ? entry.lastLightAt
        : undefined;
    const lastRemAt =
      typeof entry.lastRemAt === "string" && entry.lastRemAt.trim().length > 0
        ? entry.lastRemAt
        : undefined;
    const lastRemConsideredAt =
      typeof entry.lastRemConsideredAt === "string" && entry.lastRemConsideredAt.trim().length > 0
        ? entry.lastRemConsideredAt
        : undefined;
    entries[key] = {
      key,
      lightHits,
      remHits,
      ...(lastLightAt ? { lastLightAt } : {}),
      ...(lastRemAt ? { lastRemAt } : {}),
      ...(lastRemConsideredAt ? { lastRemConsideredAt } : {}),
    };
  }
  return {
    version: 1,
    updatedAt:
      typeof record.updatedAt === "string" && record.updatedAt.trim().length > 0
        ? record.updatedAt
        : nowIso,
    entries,
  };
}

export async function readPhaseSignalStore(
  workspaceDir: string,
  nowIso: string,
): Promise<ShortTermPhaseSignalStore> {
  const [entryRows, metaRows] = await Promise.all([
    readMemoryCoreWorkspaceEntries<ShortTermPhaseSignalEntry>({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir,
    }),
    readMemoryCoreWorkspaceEntries<ShortTermStoreMeta>({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
    }),
  ]);
  const meta = metaRows.find((entry) => entry.key === "phase")?.value;
  return normalizeShortTermPhaseSignalStore(
    {
      version: 1,
      updatedAt: meta?.updatedAt ?? nowIso,
      entries: Object.fromEntries(entryRows.map((entry) => [entry.key, entry.value])),
    },
    nowIso,
  );
}

export async function writePhaseSignalStore(
  workspaceDir: string,
  store: ShortTermPhaseSignalStore,
): Promise<void> {
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
      workspaceDir,
      entries: Object.entries(store.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
      key: "phase",
      value: { updatedAt: store.updatedAt },
    }),
  ]);
}

export async function writeStore(workspaceDir: string, store: ShortTermRecallStore): Promise<void> {
  enforceShortTermRecallSnippetCap(store);
  enforceShortTermRecallStoreRetention(store);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
      entries: Object.entries(store.entries).map(([key, value]) => ({ key, value })),
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
      key: "recall",
      value: { updatedAt: store.updatedAt },
    }),
  ]);
}
