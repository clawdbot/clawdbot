import {
  deriveConceptTags,
  summarizeConceptTagScriptCoverage,
  type ConceptTagScriptCoverage,
} from "./concept-vocabulary.js";
import {
  SHORT_TERM_LOCK_MAX_ENTRIES,
  SHORT_TERM_LOCK_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  openMemoryCoreStateStore,
  readMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { filterLiveShortTermRecallEntries } from "./short-term-promotion-record.js";
import {
  SHORT_TERM_LOCK_STALE_MS,
  deleteShortTermLockEntryIfCurrent,
  isProcessLikelyAlive,
  parseLockOwnerPid,
  readPhaseSignalStore,
  readStore,
  resolveLockPath,
  resolveStorePath,
  withShortTermLock,
  writePhaseSignalStore,
  writeStore,
} from "./short-term-promotion-store.js";
import type {
  RepairShortTermPromotionArtifactsResult,
  ShortTermAuditIssue,
  ShortTermAuditSummary,
  ShortTermLockEntry,
  ShortTermRecallEntry,
  ShortTermRecallStore,
} from "./short-term-promotion-types.js";
import {
  MAX_QUERY_HASHES,
  MAX_RECALL_DAYS,
  SHORT_TERM_RECALL_MAX_ENTRIES,
  enforceShortTermRecallStoreRetention,
  mergeRecentDistinct,
  normalizeIsoDay,
  normalizeShortTermRecallStore,
} from "./short-term-promotion-utils.js";

export function resolveShortTermRecallStorePath(workspaceDir: string): string {
  return resolveStorePath(workspaceDir);
}

export function resolveShortTermRecallLockPath(workspaceDir: string): string {
  return resolveLockPath(workspaceDir);
}

export async function auditShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<ShortTermAuditSummary> {
  const workspaceDir = params.workspaceDir.trim();
  const storePath = resolveStorePath(workspaceDir);
  const lockPath = resolveLockPath(workspaceDir);
  const issues: ShortTermAuditIssue[] = [];
  let entryCount = 0;
  let promotedCount = 0;
  let spacedEntryCount = 0;
  let conceptTaggedEntryCount = 0;
  let conceptTagScripts: ConceptTagScriptCoverage | undefined;
  let invalidEntryCount = 0;
  let danglingEntryCount = 0;
  let updatedAt: string | undefined;

  const nowIso = new Date().toISOString();
  const rawEntries = await readMemoryCoreWorkspaceEntries<unknown>({
    namespace: SHORT_TERM_RECALL_NAMESPACE,
    workspaceDir,
  });
  const exists = rawEntries.length > 0;
  if (exists) {
    const parsed = {
      version: 1,
      updatedAt: nowIso,
      entries: Object.fromEntries(rawEntries.map((entry) => [entry.key, entry.value])),
    };
    const store = normalizeShortTermRecallStore(parsed, nowIso);
    const normalizedEntryCount = Object.keys(store.entries).length;
    updatedAt = store.updatedAt;
    entryCount = normalizedEntryCount;
    promotedCount = Object.values(store.entries).filter((entry) =>
      Boolean(entry.promotedAt),
    ).length;
    spacedEntryCount = Object.values(store.entries).filter(
      (entry) => (entry.recallDays?.length ?? 0) > 1,
    ).length;
    conceptTaggedEntryCount = Object.values(store.entries).filter(
      (entry) => (entry.conceptTags?.length ?? 0) > 0,
    ).length;
    conceptTagScripts = summarizeConceptTagScriptCoverage(
      Object.values(store.entries)
        .filter((entry) => (entry.conceptTags?.length ?? 0) > 0)
        .map((entry) => entry.conceptTags ?? []),
    );
    invalidEntryCount = rawEntries.length - entryCount;
    if (invalidEntryCount > 0) {
      issues.push({
        severity: "warn",
        code: "recall-store-invalid",
        message: `Short-term recall store contains ${invalidEntryCount} invalid entr${invalidEntryCount === 1 ? "y" : "ies"}.`,
        fixable: true,
      });
    }
    const liveEntries = await filterLiveShortTermRecallEntries({
      workspaceDir,
      entries: Object.values(store.entries),
    });
    danglingEntryCount = normalizedEntryCount - liveEntries.length;
    if (danglingEntryCount > 0) {
      issues.push({
        severity: "warn",
        code: "recall-store-dangling",
        message: `Short-term recall store contains ${danglingEntryCount} entr${danglingEntryCount === 1 ? "y" : "ies"} whose source file is missing or not a regular file.`,
        fixable: true,
      });
    }
    if (normalizedEntryCount > SHORT_TERM_RECALL_MAX_ENTRIES) {
      issues.push({
        severity: "warn",
        code: "recall-store-over-limit",
        message: `Short-term recall store contains ${normalizedEntryCount} entries; only the newest ${SHORT_TERM_RECALL_MAX_ENTRIES} are kept at runtime.`,
        fixable: true,
      });
    }
  }

  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  const lockEntry = await lockStore.lookup(lockKey);
  if (lockEntry) {
    const ageMs = Date.now() - lockEntry.acquiredAt;
    const ownerPid = parseLockOwnerPid(lockEntry.owner);
    if (
      ageMs > SHORT_TERM_LOCK_STALE_MS &&
      (ownerPid === null || !isProcessLikelyAlive(ownerPid))
    ) {
      issues.push({
        severity: "warn",
        code: "recall-lock-stale",
        message: "Short-term promotion lock appears stale.",
        fixable: true,
      });
    }
  }

  return {
    storePath,
    lockPath,
    updatedAt,
    exists,
    entryCount,
    promotedCount,
    spacedEntryCount,
    conceptTaggedEntryCount,
    ...(conceptTagScripts ? { conceptTagScripts } : {}),
    invalidEntryCount,
    danglingEntryCount,
    issues,
  };
}

export async function repairShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<RepairShortTermPromotionArtifactsResult> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date().toISOString();
  let rewroteStore = false;
  let removedInvalidEntries = 0;
  let removedDanglingEntries = 0;
  let removedOverflowEntries = 0;
  let removedStaleLock = false;

  const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
  const lockStore = openMemoryCoreStateStore<ShortTermLockEntry>({
    namespace: SHORT_TERM_LOCK_NAMESPACE,
    maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
  });
  const lockEntry = await lockStore.lookup(lockKey);
  if (lockEntry && Date.now() - lockEntry.acquiredAt > SHORT_TERM_LOCK_STALE_MS) {
    const ownerPid = parseLockOwnerPid(lockEntry.owner);
    if (ownerPid === null || !isProcessLikelyAlive(ownerPid)) {
      removedStaleLock = await deleteShortTermLockEntryIfCurrent(lockStore, lockKey, lockEntry);
    }
  }

  await withShortTermLock(workspaceDir, async () => {
    const rawEntries = await readMemoryCoreWorkspaceEntries<unknown>({
      namespace: SHORT_TERM_RECALL_NAMESPACE,
      workspaceDir,
    });
    if (rawEntries.length > 0) {
      const normalized = normalizeShortTermRecallStore(
        {
          version: 1,
          updatedAt: nowIso,
          entries: Object.fromEntries(rawEntries.map((entry) => [entry.key, entry.value])),
        },
        nowIso,
      );
      removedInvalidEntries = Math.max(
        0,
        rawEntries.length - Object.keys(normalized.entries).length,
      );
      const nextEntries = Object.fromEntries(
        Object.entries(normalized.entries).map(([key, entry]) => {
          const conceptTags = deriveConceptTags({ path: entry.path, snippet: entry.snippet });
          const fallbackDay = normalizeIsoDay(entry.lastRecalledAt) ?? nowIso.slice(0, 10);
          return [
            key,
            {
              ...entry,
              dailyCount: Math.max(
                0,
                Math.floor((entry as { dailyCount?: number }).dailyCount ?? 0),
              ),
              groundedCount: Math.max(
                0,
                Math.floor((entry as { groundedCount?: number }).groundedCount ?? 0),
              ),
              queryHashes: (entry.queryHashes ?? []).slice(-MAX_QUERY_HASHES),
              recallDays: mergeRecentDistinct(entry.recallDays ?? [], fallbackDay, MAX_RECALL_DAYS),
              conceptTags: conceptTags.length > 0 ? conceptTags : (entry.conceptTags ?? []),
            } satisfies ShortTermRecallEntry,
          ];
        }),
      );
      const comparableStore: ShortTermRecallStore = {
        version: 1,
        updatedAt: normalized.updatedAt,
        entries: nextEntries,
      };
      const liveEntries = await filterLiveShortTermRecallEntries({
        workspaceDir,
        entries: Object.values(comparableStore.entries),
      });
      const liveEntryKeys = new Set(liveEntries.map((entry) => entry.key));
      const danglingEntryKeys = new Set<string>();
      for (const key of Object.keys(comparableStore.entries)) {
        if (!liveEntryKeys.has(key)) {
          delete comparableStore.entries[key];
          danglingEntryKeys.add(key);
          removedDanglingEntries += 1;
        }
      }
      removedOverflowEntries = enforceShortTermRecallStoreRetention(comparableStore);
      const needsRewrite =
        removedInvalidEntries > 0 ||
        removedDanglingEntries > 0 ||
        removedOverflowEntries > 0 ||
        JSON.stringify(normalized.entries) !== JSON.stringify(comparableStore.entries);
      if (needsRewrite) {
        let phaseSignals: Awaited<ReturnType<typeof readPhaseSignalStore>> | undefined;
        if (removedDanglingEntries > 0) {
          phaseSignals = await readPhaseSignalStore(workspaceDir, nowIso);
          for (const key of danglingEntryKeys) {
            delete phaseSignals.entries[key];
          }
          phaseSignals.updatedAt = nowIso;
        }
        // Phase signals are derived from recall rows. Remove signals for recalls
        // already proven dangling first so a later failure stays retryable.
        if (phaseSignals) {
          await writePhaseSignalStore(workspaceDir, phaseSignals);
        }
        await writeStore(workspaceDir, {
          ...comparableStore,
          updatedAt: nowIso,
        });
        rewroteStore = true;
      }
    }
  });

  return {
    changed: rewroteStore || removedStaleLock,
    removedInvalidEntries,
    removedDanglingEntries,
    removedOverflowEntries,
    rewroteStore,
    removedStaleLock,
  };
}

export async function removeGroundedShortTermCandidates(params: {
  workspaceDir: string;
}): Promise<{ removed: number; storePath: string }> {
  const workspaceDir = params.workspaceDir.trim();
  const storePath = resolveStorePath(workspaceDir);
  const nowIso = new Date().toISOString();
  let removed = 0;

  await withShortTermLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);

    for (const [key, entry] of Object.entries(store.entries)) {
      if (
        Math.max(0, Math.floor(entry.groundedCount ?? 0)) > 0 &&
        Math.max(0, Math.floor(entry.recallCount ?? 0)) === 0 &&
        Math.max(0, Math.floor(entry.dailyCount ?? 0)) === 0
      ) {
        delete store.entries[key];
        removed += 1;
      }
    }

    for (const key of Object.keys(phaseSignals.entries)) {
      if (!Object.hasOwn(store.entries, key)) {
        delete phaseSignals.entries[key];
      }
    }

    if (removed > 0) {
      store.updatedAt = nowIso;
      phaseSignals.updatedAt = nowIso;
      await Promise.all([
        writeStore(workspaceDir, store),
        writePhaseSignalStore(workspaceDir, phaseSignals),
      ]);
    }
  });

  return { removed, storePath };
}
