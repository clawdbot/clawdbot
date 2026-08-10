import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { asRecord } from "./dreaming-shared.js";
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
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") {
      return false;
    }
    // EPERM and unknown errors are treated as alive to avoid stealing active locks.
    return true;
  }
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
      const owner = `${process.pid}:${Date.now()}`;
      const acquired = await lockStore.registerIfAbsent(lockKey, {
        owner,
        acquiredAt: Date.now(),
      });
      if (acquired) {
        try {
          return await task();
        } finally {
          const current = await lockStore.lookup(lockKey).catch(() => undefined);
          if (current?.owner === owner) {
            await lockStore.delete(lockKey).catch(() => false);
          }
        }
      }

      const existing = await lockStore.lookup(lockKey);
      if (existing && Date.now() - existing.acquiredAt > SHORT_TERM_LOCK_STALE_MS) {
        const ownerPid = parseLockOwnerPid(existing.owner);
        if (ownerPid === null || !isProcessLikelyAlive(ownerPid)) {
          await lockStore.delete(lockKey);
          continue;
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
  const record = asRecord(raw);
  if (!record) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entriesRaw = asRecord(record?.entries);
  if (!entriesRaw) {
    return emptyPhaseSignalStore(nowIso);
  }
  const entries: Record<string, ShortTermPhaseSignalEntry> = {};
  for (const [mapKey, value] of Object.entries(entriesRaw)) {
    const entry = asRecord(value);
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
