import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { isSameMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatErrorMessage } from "./dreaming-shared.js";
import {
  emptyPhaseSignalStore,
  readPhaseSignalStore,
  readStore,
  resolvePhaseSignalPath,
  resolveStorePath,
  withShortTermLock,
  writePhaseSignalStore,
} from "./short-term-promotion-store.js";
import type {
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
  ShortTermPhaseSignalStore,
  ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
import {
  isShortTermMemoryPath,
  normalizeMemoryPathForWorkspace,
  normalizeSnippet,
  parseEntryRangeFromKey,
  parseStoreTimestampMs,
  toNonNegativeInt,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const DREAMING_ENTRY_LIST_LIMIT = 8;

function compareDreamingStatsEntryByRecency(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  const aMs = a.lastRecalledAt ? Date.parse(a.lastRecalledAt) : Number.NEGATIVE_INFINITY;
  const bMs = b.lastRecalledAt ? Date.parse(b.lastRecalledAt) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(aMs) || Number.isFinite(bMs)) {
    if (bMs !== aMs) {
      return bMs - aMs;
    }
  }
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  return a.path.localeCompare(b.path);
}

function compareDreamingStatsEntryBySignals(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  if (b.totalSignalCount !== a.totalSignalCount) {
    return b.totalSignalCount - a.totalSignalCount;
  }
  if (b.phaseHitCount !== a.phaseHitCount) {
    return b.phaseHitCount - a.phaseHitCount;
  }
  return compareDreamingStatsEntryByRecency(a, b);
}

function compareDreamingStatsEntryByPromotion(
  a: ShortTermDreamingStatsEntry,
  b: ShortTermDreamingStatsEntry,
): number {
  const aMs = a.promotedAt ? Date.parse(a.promotedAt) : Number.NEGATIVE_INFINITY;
  const bMs = b.promotedAt ? Date.parse(b.promotedAt) : Number.NEGATIVE_INFINITY;
  if (Number.isFinite(aMs) || Number.isFinite(bMs)) {
    if (bMs !== aMs) {
      return bMs - aMs;
    }
  }
  return compareDreamingStatsEntryBySignals(a, b);
}

function trimDreamingStatsEntries(
  entries: ShortTermDreamingStatsEntry[],
  compare: (a: ShortTermDreamingStatsEntry, b: ShortTermDreamingStatsEntry) => number,
): ShortTermDreamingStatsEntry[] {
  const selected: ShortTermDreamingStatsEntry[] = [];
  for (const entry of entries) {
    let insertAt = selected.length;
    for (let index = 0; index < selected.length; index += 1) {
      if (compare(entry, expectDefined(selected[index], "selected dreaming stats index")) < 0) {
        insertAt = index;
        break;
      }
    }
    if (insertAt < DREAMING_ENTRY_LIST_LIMIT) {
      selected.splice(insertAt, 0, entry);
      if (selected.length > DREAMING_ENTRY_LIST_LIMIT) {
        selected.pop();
      }
    } else if (selected.length < DREAMING_ENTRY_LIST_LIMIT) {
      selected.push(entry);
    }
  }
  return selected;
}

export async function loadShortTermPromotionDreamingStats(params: {
  workspaceDir: string;
  nowMs: number;
  timezone?: string;
}): Promise<ShortTermDreamingStats> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date(params.nowMs).toISOString();
  const store = await readStore(workspaceDir, nowIso);
  let phaseSignalError: string | undefined;
  let phaseStore: ShortTermPhaseSignalStore;
  try {
    phaseStore = await readPhaseSignalStore(workspaceDir, nowIso);
  } catch (err) {
    phaseSignalError = formatErrorMessage(err);
    phaseStore = emptyPhaseSignalStore(nowIso);
  }
  let shortTermCount = 0;
  let recallSignalCount = 0;
  let dailySignalCount = 0;
  let groundedSignalCount = 0;
  let totalSignalCount = 0;
  let phaseSignalCount = 0;
  let lightPhaseHitCount = 0;
  let remPhaseHitCount = 0;
  let promotedTotal = 0;
  let promotedToday = 0;
  let latestPromotedAtMs = Number.NEGATIVE_INFINITY;
  let latestPromotedAt: string | undefined;
  const activeKeys = new Set<string>();
  const activeEntries = new Map<string, ShortTermDreamingStatsEntry>();
  const shortTermEntries: ShortTermDreamingStatsEntry[] = [];
  const promotedEntries: ShortTermDreamingStatsEntry[] = [];

  for (const [entryKey, entry] of Object.entries(store.entries)) {
    if (entry.source !== "memory" || !entry.path || !isShortTermMemoryPath(entry.path)) {
      continue;
    }
    const range = parseEntryRangeFromKey(entryKey, entry.startLine, entry.endLine);
    const recallCount = toNonNegativeInt(entry.recallCount);
    const dailyCount = toNonNegativeInt(entry.dailyCount);
    const groundedCount = toNonNegativeInt(entry.groundedCount);
    const totalEntrySignalCount = recallCount + dailyCount + groundedCount;
    const normalizedEntryPath = normalizeMemoryPathForWorkspace(workspaceDir, entry.path);
    const detail: ShortTermDreamingStatsEntry = {
      key: entryKey,
      path: normalizedEntryPath,
      startLine: range.startLine,
      endLine: Math.max(range.startLine, range.endLine),
      snippet: normalizeSnippet(entry.snippet) || normalizedEntryPath,
      recallCount,
      dailyCount,
      groundedCount,
      totalSignalCount: totalEntrySignalCount,
      lightHits: 0,
      remHits: 0,
      phaseHitCount: 0,
      ...(entry.lastRecalledAt ? { lastRecalledAt: entry.lastRecalledAt } : {}),
    };
    if (!entry.promotedAt) {
      shortTermCount += 1;
      activeKeys.add(entryKey);
      recallSignalCount += recallCount;
      dailySignalCount += dailyCount;
      groundedSignalCount += groundedCount;
      totalSignalCount += totalEntrySignalCount;
      shortTermEntries.push(detail);
      activeEntries.set(entryKey, detail);
      continue;
    }
    promotedTotal += 1;
    promotedEntries.push({ ...detail, promotedAt: entry.promotedAt });
    const promotedAtMs = Date.parse(entry.promotedAt);
    if (
      Number.isFinite(promotedAtMs) &&
      isSameMemoryDreamingDay(promotedAtMs, params.nowMs, params.timezone)
    ) {
      promotedToday += 1;
    }
    if (Number.isFinite(promotedAtMs) && promotedAtMs > latestPromotedAtMs) {
      latestPromotedAtMs = promotedAtMs;
      latestPromotedAt = entry.promotedAt;
    }
  }

  for (const [key, phaseEntry] of Object.entries(phaseStore.entries)) {
    if (!activeKeys.has(key)) {
      continue;
    }
    const lightHits = toNonNegativeInt(phaseEntry.lightHits);
    const remHits = toNonNegativeInt(phaseEntry.remHits);
    lightPhaseHitCount += lightHits;
    remPhaseHitCount += remHits;
    phaseSignalCount += lightHits + remHits;
    const detail = activeEntries.get(key);
    if (detail) {
      detail.lightHits = lightHits;
      detail.remHits = remHits;
      detail.phaseHitCount = lightHits + remHits;
    }
  }

  return {
    shortTermCount,
    recallSignalCount,
    dailySignalCount,
    groundedSignalCount,
    totalSignalCount,
    phaseSignalCount,
    lightPhaseHitCount,
    remPhaseHitCount,
    promotedTotal,
    promotedToday,
    storePath: resolveStorePath(workspaceDir),
    phaseSignalPath: resolvePhaseSignalPath(workspaceDir),
    shortTermEntries: trimDreamingStatsEntries(
      shortTermEntries,
      compareDreamingStatsEntryByRecency,
    ),
    signalEntries: trimDreamingStatsEntries(shortTermEntries, compareDreamingStatsEntryBySignals),
    promotedEntries: trimDreamingStatsEntries(
      promotedEntries,
      compareDreamingStatsEntryByPromotion,
    ),
    ...(phaseSignalError ? { phaseSignalError } : {}),
    ...(latestPromotedAt ? { lastPromotedAt: latestPromotedAt } : {}),
  };
}

export async function recordDreamingPhaseSignals(params: {
  workspaceDir?: string;
  phase: "light" | "rem";
  keys: string[];
  nowMs?: number;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const keys = uniqueStrings(normalizeStringEntries(params.keys));
  if (keys.length === 0) {
    return;
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);

  await withShortTermLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);
    const knownKeys = new Set(Object.keys(store.entries));

    for (const key of keys) {
      if (!knownKeys.has(key)) {
        continue;
      }
      const entry = phaseSignals.entries[key] ?? {
        key,
        lightHits: 0,
        remHits: 0,
      };
      if (params.phase === "light") {
        entry.lightHits = Math.min(9999, entry.lightHits + 1);
        entry.lastLightAt = nowIso;
      } else {
        entry.remHits = Math.min(9999, entry.remHits + 1);
        entry.lastRemAt = nowIso;
      }
      phaseSignals.entries[key] = entry;
    }

    for (const [key, entry] of Object.entries(phaseSignals.entries)) {
      if (!knownKeys.has(key) || (entry.lightHits <= 0 && entry.remHits <= 0)) {
        delete phaseSignals.entries[key];
      }
    }

    phaseSignals.updatedAt = nowIso;
    await writePhaseSignalStore(workspaceDir, phaseSignals);
  });
}

export async function recordRemConsideredPhaseSignals(params: {
  workspaceDir?: string;
  keys: string[];
  nowMs?: number;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const keys = uniqueStrings(normalizeStringEntries(params.keys));
  if (keys.length === 0) {
    return;
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);

  await withShortTermLock(workspaceDir, async () => {
    const [store, phaseSignals] = await Promise.all([
      readStore(workspaceDir, nowIso),
      readPhaseSignalStore(workspaceDir, nowIso),
    ]);
    const knownKeys = new Set(Object.keys(store.entries));

    for (const key of keys) {
      if (!knownKeys.has(key)) {
        continue;
      }
      const entry = phaseSignals.entries[key] ?? {
        key,
        lightHits: 0,
        remHits: 0,
      };
      entry.lastRemConsideredAt = nowIso;
      phaseSignals.entries[key] = entry;
    }

    for (const [key, entry] of Object.entries(phaseSignals.entries)) {
      if (!knownKeys.has(key) || (entry.lightHits <= 0 && entry.remHits <= 0)) {
        delete phaseSignals.entries[key];
      }
    }

    phaseSignals.updatedAt = nowIso;
    await writePhaseSignalStore(workspaceDir, phaseSignals);
  });
}

export async function readLightStagedKeys(params: {
  workspaceDir: string;
  nowMs?: number;
}): Promise<Set<string>> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return new Set();
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const store = await readPhaseSignalStore(workspaceDir, nowIso);
  const keys = new Set<string>();
  for (const [key, entry] of Object.entries(store.entries)) {
    if (entry.lightHits <= 0) {
      continue;
    }
    const lastLightMs = Date.parse(entry.lastLightAt ?? "");
    const lastRemMs = Date.parse(entry.lastRemAt ?? "");
    const lastRemConsideredMs = Date.parse(entry.lastRemConsideredAt ?? "");
    const lastConsumedMs = Math.max(
      Number.isFinite(lastRemMs) ? lastRemMs : Number.NEGATIVE_INFINITY,
      Number.isFinite(lastRemConsideredMs) ? lastRemConsideredMs : Number.NEGATIVE_INFINITY,
    );
    const hasPendingLightSignal = Number.isFinite(lastLightMs)
      ? lastLightMs > lastConsumedMs
      : !entry.lastRemAt;
    if (hasPendingLightSignal) {
      keys.add(key);
    }
  }
  return keys;
}

export async function filterFreshLightDreamingEntries(params: {
  workspaceDir: string;
  entries: readonly ShortTermRecallEntry[];
  nowMs?: number;
}): Promise<ShortTermRecallEntry[]> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir || params.entries.length === 0) {
    return [];
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const phaseSignals = await readPhaseSignalStore(workspaceDir, nowIso);
  return params.entries.filter((entry) => {
    const phaseSignal = phaseSignals.entries[entry.key];
    if (!phaseSignal || phaseSignal.lightHits <= 0) {
      return true;
    }
    const lastLightMs = parseStoreTimestampMs(phaseSignal.lastLightAt);
    if (!Number.isFinite(lastLightMs)) {
      return true;
    }
    const lastRecalledAtMs = parseStoreTimestampMs(entry.lastRecalledAt);
    return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs > lastLightMs;
  });
}
