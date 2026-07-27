import fs from "node:fs/promises";
import path from "node:path";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import pLimit from "p-limit";
import { deriveConceptTags } from "./concept-vocabulary.js";
import { readStore, withShortTermLock, writeStore } from "./short-term-promotion-store.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";
import {
  buildClaimHash,
  buildEntryKey,
  clampScore,
  hashQuery,
  isContaminatedDreamingSnippet,
  isShortTermMemoryPath,
  isShortTermSessionCorpusPath,
  MAX_RECALL_DAYS,
  mergeQueryHashes,
  mergeRecentDistinct,
  normalizeIsoDay,
  normalizeMemoryPath,
  normalizeSnippet,
  truncateShortTermSnippet,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

// One recall batch can inspect every retained entry; cap filesystem pressure.
const SHORT_TERM_SOURCE_FILE_CHECK_CONCURRENCY = 32;

async function shortTermRecallSourceIsFile(sourcePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(sourcePath);
    return stat.isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

export async function filterLiveShortTermRecallEntries(params: {
  workspaceDir: string;
  entries: ShortTermRecallEntry[];
}): Promise<ShortTermRecallEntry[]> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return [];
  }
  const sourceFileChecks = new Map<string, Promise<boolean>>();
  const sourceFileLimit = pLimit(SHORT_TERM_SOURCE_FILE_CHECK_CONCURRENCY);
  const checkSourceFile = (sourcePath: string): Promise<boolean> => {
    const existing = sourceFileChecks.get(sourcePath);
    if (existing) {
      return existing;
    }
    const check = sourceFileLimit(() => shortTermRecallSourceIsFile(sourcePath));
    sourceFileChecks.set(sourcePath, check);
    return check;
  };
  const results = await Promise.all(
    params.entries.map(async (entry) => {
      let exists = false;
      for (const sourcePath of resolveShortTermSourcePathCandidates(workspaceDir, entry.path)) {
        if (await checkSourceFile(sourcePath)) {
          exists = true;
          break;
        }
      }
      return { entry, exists };
    }),
  );
  return results.filter((result) => result.exists).map((result) => result.entry);
}

function buildMemoryRecallSkippedEvent(params: {
  timestamp: string;
  query: string;
  eligibleResultCount: number;
  skipped: MemorySearchResult[];
}) {
  return {
    type: "memory.recall.skipped" as const,
    timestamp: params.timestamp,
    query: params.query,
    reason: "non-short-term-memory-path" as const,
    eligibleResultCount: params.eligibleResultCount,
    skippedResultCount: params.skipped.length,
    results: params.skipped.map((result) => ({
      path: normalizeMemoryPath(result.path),
      startLine: Math.max(1, Math.floor(result.startLine)),
      endLine: Math.max(1, Math.floor(result.endLine)),
      score: clampScore(result.score),
      reason: "non-short-term-memory-path" as const,
    })),
  };
}

export async function recordShortTermRecalls(params: {
  workspaceDir?: string;
  query: string;
  results: MemorySearchResult[];
  signalType?: "recall" | "daily";
  dedupeByQueryPerDay?: boolean;
  dayBucket?: string;
  nowMs?: number;
  timezone?: string;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const query = params.query.trim();
  if (!query) {
    return;
  }
  const memoryResults = params.results.filter((result) => result.source === "memory");
  const relevant = memoryResults.filter((result) => isShortTermMemoryPath(result.path));
  const skipped = memoryResults.filter((result) => !isShortTermMemoryPath(result.path));
  if (relevant.length === 0 && skipped.length === 0) {
    return;
  }

  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  if (relevant.length === 0) {
    await appendMemoryHostEvent(
      workspaceDir,
      buildMemoryRecallSkippedEvent({
        timestamp: nowIso,
        query,
        eligibleResultCount: relevant.length,
        skipped,
      }),
    );
    return;
  }
  const signalType = params.signalType ?? "recall";
  const queryHash = hashQuery(query);
  const todayBucket =
    normalizeIsoDay(params.dayBucket ?? "") ?? formatMemoryDreamingDay(nowMs, params.timezone);
  await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);

    for (const result of relevant) {
      const normalizedPath = normalizeMemoryPath(result.path);
      const rawSnippet = normalizeSnippet(result.snippet);
      const snippet = truncateShortTermSnippet(rawSnippet);
      if (
        !rawSnippet ||
        isContaminatedDreamingSnippet(rawSnippet, {
          allowTranscriptTurnSnippet: isShortTermSessionCorpusPath(normalizedPath),
        })
      ) {
        continue;
      }
      const claimHash = buildClaimHash(rawSnippet);
      const groundedKey = claimHash
        ? buildEntryKey({
            path: normalizedPath,
            startLine: Math.max(1, Math.floor(result.startLine)),
            endLine: Math.max(1, Math.floor(result.endLine)),
            source: "memory",
            claimHash,
          })
        : null;
      const baseKey = buildEntryKey(result);
      const key = groundedKey && store.entries[groundedKey] ? groundedKey : baseKey;
      const existing = store.entries[key];
      const score = clampScore(result.score);
      const recallDaysBase = existing?.recallDays ?? [];
      const queryHashesBase = existing?.queryHashes ?? [];
      const dedupeSignal =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        recallDaysBase.includes(todayBucket);
      const recallCount =
        signalType === "recall"
          ? Math.max(0, Math.floor(existing?.recallCount ?? 0) + (dedupeSignal ? 0 : 1))
          : Math.max(0, Math.floor(existing?.recallCount ?? 0));
      const dailyCount =
        signalType === "daily"
          ? Math.max(0, Math.floor(existing?.dailyCount ?? 0) + (dedupeSignal ? 0 : 1))
          : Math.max(0, Math.floor(existing?.dailyCount ?? 0));
      const totalScore = Math.max(0, (existing?.totalScore ?? 0) + (dedupeSignal ? 0 : score));
      const maxScore = Math.max(existing?.maxScore ?? 0, dedupeSignal ? 0 : score);
      const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
      const recallDays = mergeRecentDistinct(recallDaysBase, todayBucket, MAX_RECALL_DAYS);
      const conceptTags = deriveConceptTags({ path: normalizedPath, snippet });

      const unchangedRepeatedSignal =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        existing?.snippet === snippet;
      const lastRecalledAt = unchangedRepeatedSignal
        ? (existing?.lastRecalledAt ?? nowIso)
        : nowIso;

      store.entries[key] = {
        key,
        path: normalizedPath,
        startLine: Math.max(1, Math.floor(result.startLine)),
        endLine: Math.max(1, Math.floor(result.endLine)),
        source: "memory",
        snippet: snippet || existing?.snippet || "",
        recallCount,
        dailyCount,
        groundedCount: Math.max(0, Math.floor(existing?.groundedCount ?? 0)),
        totalScore,
        maxScore,
        firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
        lastRecalledAt,
        queryHashes,
        recallDays,
        conceptTags: conceptTags.length > 0 ? conceptTags : (existing?.conceptTags ?? []),
        ...(existing?.claimHash ? { claimHash: existing.claimHash } : {}),
        ...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
      };
    }

    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: nowIso,
      query,
      resultCount: relevant.length,
      results: relevant.map((result) => ({
        path: normalizeMemoryPath(result.path),
        startLine: Math.max(1, Math.floor(result.startLine)),
        endLine: Math.max(1, Math.floor(result.endLine)),
        score: clampScore(result.score),
      })),
    });
    if (skipped.length > 0) {
      await appendMemoryHostEvent(
        workspaceDir,
        buildMemoryRecallSkippedEvent({
          timestamp: nowIso,
          query,
          eligibleResultCount: relevant.length,
          skipped,
        }),
      );
    }
  });
}

export async function recordGroundedShortTermCandidates(params: {
  workspaceDir?: string;
  query: string;
  items: Array<{
    path: string;
    startLine: number;
    endLine: number;
    snippet: string;
    score: number;
    query?: string;
    signalCount?: number;
    dayBucket?: string;
  }>;
  dedupeByQueryPerDay?: boolean;
  dayBucket?: string;
  nowMs?: number;
  timezone?: string;
}): Promise<void> {
  const workspaceDir = params.workspaceDir?.trim();
  if (!workspaceDir) {
    return;
  }
  const query = params.query.trim();
  if (!query) {
    return;
  }
  const relevant = params.items
    .map((item) => {
      const rawSnippet = normalizeSnippet(item.snippet);
      const snippet = truncateShortTermSnippet(rawSnippet);
      const normalizedPath = normalizeMemoryPath(item.path);
      if (
        !rawSnippet ||
        isContaminatedDreamingSnippet(rawSnippet) ||
        !normalizedPath ||
        !isShortTermMemoryPath(normalizedPath) ||
        !Number.isFinite(item.startLine) ||
        !Number.isFinite(item.endLine)
      ) {
        return null;
      }
      return {
        path: normalizedPath,
        startLine: Math.max(1, Math.floor(item.startLine)),
        endLine: Math.max(1, Math.floor(item.endLine)),
        snippet,
        identitySnippet: rawSnippet,
        score: clampScore(item.score),
        query: normalizeSnippet(item.query ?? query),
        signalCount: Math.max(1, Math.floor(item.signalCount ?? 1)),
        dayBucket: normalizeIsoDay(item.dayBucket ?? params.dayBucket ?? ""),
      };
    })
    .filter((item): item is NonNullable<typeof item> => item !== null);
  if (relevant.length === 0) {
    return;
  }

  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const fallbackDayBucket = formatMemoryDreamingDay(nowMs, params.timezone);
  await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);

    for (const item of relevant) {
      const dayBucket = item.dayBucket ?? fallbackDayBucket;
      const effectiveQuery = item.query || query;
      if (!effectiveQuery) {
        continue;
      }
      const queryHash = hashQuery(effectiveQuery);
      const claimHash = buildClaimHash(item.identitySnippet);
      const key = buildEntryKey({
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        source: "memory",
        claimHash,
      });
      const existing = store.entries[key];
      const recallDaysBase = existing?.recallDays ?? [];
      const queryHashesBase = existing?.queryHashes ?? [];
      const dedupeSignal =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        recallDaysBase.includes(dayBucket);
      const groundedCount = Math.max(
        0,
        Math.floor(existing?.groundedCount ?? 0) + (dedupeSignal ? 0 : item.signalCount),
      );
      const totalScore = Math.max(
        0,
        (existing?.totalScore ?? 0) + (dedupeSignal ? 0 : item.score * item.signalCount),
      );
      const maxScore = Math.max(existing?.maxScore ?? 0, dedupeSignal ? 0 : item.score);
      const queryHashes = mergeQueryHashes(existing?.queryHashes ?? [], queryHash);
      const recallDays = mergeRecentDistinct(recallDaysBase, dayBucket, MAX_RECALL_DAYS);
      const conceptTags = deriveConceptTags({ path: item.path, snippet: item.snippet });

      const unchangedRepeatedSignal =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        existing?.snippet === item.snippet;
      const lastRecalledAt = unchangedRepeatedSignal
        ? (existing?.lastRecalledAt ?? nowIso)
        : nowIso;

      store.entries[key] = {
        key,
        path: item.path,
        startLine: item.startLine,
        endLine: item.endLine,
        source: "memory",
        snippet: item.snippet,
        recallCount: Math.max(0, Math.floor(existing?.recallCount ?? 0)),
        dailyCount: Math.max(0, Math.floor(existing?.dailyCount ?? 0)),
        groundedCount,
        totalScore,
        maxScore,
        firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
        lastRecalledAt,
        queryHashes,
        recallDays,
        conceptTags: conceptTags.length > 0 ? conceptTags : (existing?.conceptTags ?? []),
        claimHash,
        ...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
      };
    }

    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
  });
}

export async function readShortTermRecallEntries(params: {
  workspaceDir: string;
  nowMs?: number;
}): Promise<ShortTermRecallEntry[]> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    return [];
  }
  const nowMs = resolveMemoryCoreNowMs(params.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const store = await readStore(workspaceDir, nowIso);
  return Object.values(store.entries).filter(
    (entry): entry is ShortTermRecallEntry =>
      Boolean(entry) && entry.source === "memory" && isShortTermMemoryPath(entry.path),
  );
}

export function resolveShortTermSourcePathCandidates(
  workspaceDir: string,
  candidatePath: string,
): string[] {
  const normalizedPath = normalizeMemoryPath(candidatePath);
  const basenames = [normalizedPath];
  if (!normalizedPath.startsWith("memory/")) {
    basenames.push(path.posix.join("memory", path.posix.basename(normalizedPath)));
  }
  const seen = new Set<string>();
  const resolved: string[] = [];
  for (const relativePath of basenames) {
    const absolutePath = path.resolve(workspaceDir, relativePath);
    if (seen.has(absolutePath)) {
      continue;
    }
    seen.add(absolutePath);
    resolved.push(absolutePath);
  }
  return resolved;
}
