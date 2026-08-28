import fs from "node:fs/promises";
import path from "node:path";
import type {
  MemoryEntryProvenance,
  MemorySearchResult,
} from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import pLimit from "p-limit";
import { deriveConceptTags } from "./concept-vocabulary.js";
import {
  listMemorySessionTombstones,
  recordMemoryEntryOrigins,
  type MemoryEntryOrigin,
} from "./memory-entry-origins.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import type { SessionEntryOrigin } from "./session-ingestion.js";
import { readStore, writeStore } from "./short-term-promotion-store.js";
import type { ShortTermRecallEntry } from "./short-term-promotion-types.js";
import {
  buildDailyClaimEntryKey,
  buildClaimHash,
  buildEntryKey,
  clampScore,
  hashQuery,
  isContaminatedDreamingSnippet,
  isShortTermMemoryPath,
  isShortTermSessionCorpusPath,
  MAX_QUERY_HASHES,
  MAX_RECALL_DAYS,
  mergeProjectKeyLists,
  mergeRecentDistinct,
  normalizeIsoDay,
  normalizeMemoryPath,
  normalizeSnippet,
  truncateShortTermSnippet,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

// One recall batch can inspect every retained entry; cap filesystem pressure.
const SHORT_TERM_SOURCE_FILE_CHECK_CONCURRENCY = 32;

function mergeRecallProvenance(
  existing: MemoryEntryProvenance | undefined,
  incoming: MemoryEntryProvenance,
): MemoryEntryProvenance {
  if (!existing) {
    return incoming;
  }
  const priority = ["owner", "agent", "system", "untrusted"] as const;
  const originClass = priority.findLast(
    (origin) => origin === existing.originClass || origin === incoming.originClass,
  );
  return {
    originClass: originClass ?? "untrusted",
    sessionKind: existing.sessionKind === incoming.sessionKind ? incoming.sessionKind : "unknown",
    observedAt: Math.max(existing.observedAt, incoming.observedAt),
    ...(existing.supersedesKey && existing.supersedesKey === incoming.supersedesKey
      ? { supersedesKey: existing.supersedesKey }
      : {}),
  };
}

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
  results: Array<
    MemorySearchResult & {
      identitySnippet?: string;
      sessionOrigin?: SessionEntryOrigin;
      query?: string;
      signalCount?: number;
      dayBucket?: string;
    }
  >;
  signalType?: "recall" | "daily" | "grounded";
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
  const signalType = params.signalType ?? "recall";
  const memoryResults = params.results.filter((result) => result.source === "memory");
  const relevant = memoryResults.filter((result) => isShortTermMemoryPath(result.path));
  const skipped = memoryResults.filter((result) => !isShortTermMemoryPath(result.path));
  if (relevant.length === 0 && (skipped.length === 0 || signalType === "grounded")) {
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
  const sourceSessions = new Map<string, Set<string>>();
  for (const { sessionOrigin } of relevant) {
    if (sessionOrigin) {
      const sessions = sourceSessions.get(sessionOrigin.agentId) ?? new Set<string>();
      sessions.add(sessionOrigin.sessionId);
      sourceSessions.set(sessionOrigin.agentId, sessions);
    }
  }
  const todayBucket = formatMemoryDreamingDay(nowMs, params.timezone);
  await withMemoryWorkspaceLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);
    const forgottenByAgent = new Map<string, Set<string>>();
    for (const [agentId, sessionIds] of sourceSessions) {
      forgottenByAgent.set(
        agentId,
        new Set(
          listMemorySessionTombstones({ agentId, sessionIds: [...sessionIds] }).map(
            (entry) => entry.sessionId,
          ),
        ),
      );
    }
    // Revalidate after acquiring the shared mutation lock: a purge can finish
    // while transcript scanning or a previous staging operation is awaited.
    const admitted = relevant.filter(
      ({ sessionOrigin }) =>
        !sessionOrigin ||
        !forgottenByAgent.get(sessionOrigin.agentId)?.has(sessionOrigin.sessionId),
    );
    if (admitted.length === 0) {
      return;
    }
    const origins: MemoryEntryOrigin[] = [];
    for (const result of admitted) {
      const normalizedPath = normalizeMemoryPath(result.path);
      const rawSnippet = normalizeSnippet(result.snippet);
      const snippet = truncateShortTermSnippet(rawSnippet);
      if (
        !rawSnippet ||
        (signalType === "grounded" &&
          (!Number.isFinite(result.startLine) || !Number.isFinite(result.endLine))) ||
        isContaminatedDreamingSnippet(rawSnippet, {
          allowTranscriptTurnSnippet:
            signalType !== "grounded" && isShortTermSessionCorpusPath(normalizedPath),
        })
      ) {
        continue;
      }
      const identitySnippet =
        signalType === "daily"
          ? normalizeSnippet(result.identitySnippet ?? rawSnippet)
          : rawSnippet;
      const claimHash = buildClaimHash(identitySnippet);
      const nonDailyEntry =
        signalType === "daily"
          ? Object.values(store.entries).find(
              (entry) =>
                !entry.key.startsWith("memory:claim:") &&
                Math.max(0, Math.floor(entry.recallCount ?? 0)) +
                  Math.max(0, Math.floor(entry.groundedCount ?? 0)) >
                  0 &&
                entry.claimHash === claimHash,
            )
          : undefined;
      // Interactive/grounded writers retain their path-qualified identity.
      // Daily recurrence reinforces that candidate instead of creating a rival.
      const claimKey =
        signalType === "daily"
          ? buildDailyClaimEntryKey(claimHash)
          : buildEntryKey({
              path: normalizedPath,
              startLine: Math.max(1, Math.floor(result.startLine)),
              endLine: Math.max(1, Math.floor(result.endLine)),
              source: "memory",
              claimHash,
            });
      const key =
        nonDailyEntry?.key ??
        (signalType !== "recall" || store.entries[claimKey] ? claimKey : buildEntryKey(result));
      const existing = store.entries[key];
      const score = clampScore(result.score);
      const effectiveQuery =
        signalType === "grounded" ? normalizeSnippet(result.query ?? query) || query : query;
      const queryHash = hashQuery(effectiveQuery);
      const dayBucket =
        normalizeIsoDay(
          (signalType === "grounded" ? result.dayBucket : undefined) ?? params.dayBucket ?? "",
        ) ?? todayBucket;
      const signalCount =
        signalType === "grounded" ? Math.max(1, Math.floor(result.signalCount ?? 1)) : 1;
      const recallDaysBase = existing?.recallDays ?? [];
      const queryHashesBase = existing?.queryHashes ?? [];
      const dedupeSignal =
        Boolean(params.dedupeByQueryPerDay) &&
        queryHashesBase.includes(queryHash) &&
        recallDaysBase.includes(dayBucket);
      const addedSignals = dedupeSignal ? 0 : signalCount;
      const recallCount = Math.max(
        0,
        Math.floor(existing?.recallCount ?? 0) + (signalType === "recall" ? addedSignals : 0),
      );
      const dailyCount = Math.max(
        0,
        Math.floor(existing?.dailyCount ?? 0) + (signalType === "daily" ? addedSignals : 0),
      );
      const groundedCount = Math.max(
        0,
        Math.floor(existing?.groundedCount ?? 0) + (signalType === "grounded" ? addedSignals : 0),
      );
      const totalScore = Math.max(0, (existing?.totalScore ?? 0) + score * addedSignals);
      const maxScore = Math.max(existing?.maxScore ?? 0, dedupeSignal ? 0 : score);
      const queryHashes = mergeRecentDistinct(queryHashesBase, queryHash, MAX_QUERY_HASHES);
      const recallDays = mergeRecentDistinct(recallDaysBase, dayBucket, MAX_RECALL_DAYS);
      const conceptTags = deriveConceptTags({ path: normalizedPath, snippet });
      // Workspace-file hits without explicit provenance retain the index's
      // agent default; source-origin rows keep these facts before trust merges.
      const sourceProvenance = result.provenance ?? {
        originClass: "agent" as const,
        sessionKind: "unknown" as const,
        observedAt: nowMs,
      };
      const provenance = mergeRecallProvenance(existing?.provenance, sourceProvenance);
      const projectKey = mergeProjectKeyLists(existing?.projectKey, result.projectKey);
      const unchangedRepeatedSignal =
        (Boolean(params.dedupeByQueryPerDay) || signalType === "daily") &&
        queryHashesBase.includes(queryHash) &&
        existing?.snippet === snippet;
      // Freshness and signal counting are independent: changed daily content
      // may add evidence without a repeated query refreshing an old claim.
      const lastRecalledAt = unchangedRepeatedSignal
        ? (existing?.lastRecalledAt ?? nowIso)
        : nowIso;
      // Daily claim keys omit the file path; retain the first source citation
      // while observations from distinct days accumulate on the same claim.
      const preserveFirstDailySource = signalType === "daily" && existing !== undefined;
      store.entries[key] = {
        key,
        path: preserveFirstDailySource ? existing.path : normalizedPath,
        startLine: preserveFirstDailySource
          ? existing.startLine
          : Math.max(1, Math.floor(result.startLine)),
        endLine: preserveFirstDailySource
          ? existing.endLine
          : Math.max(1, Math.floor(result.endLine)),
        source: "memory",
        snippet: snippet || existing?.snippet || "",
        recallCount,
        dailyCount,
        groundedCount,
        totalScore,
        maxScore,
        firstRecalledAt: existing?.firstRecalledAt ?? nowIso,
        lastRecalledAt,
        queryHashes,
        recallDays,
        conceptTags: conceptTags.length > 0 ? conceptTags : (existing?.conceptTags ?? []),
        provenance,
        claimHash,
        ...(projectKey ? { projectKey } : {}),
        ...(existing?.promotedAt ? { promotedAt: existing.promotedAt } : {}),
      };
      if (result.sessionOrigin) {
        origins.push({
          entryKey: key,
          agentId: result.sessionOrigin.agentId,
          sessionId: result.sessionOrigin.sessionId,
          sessionKey: result.sessionOrigin.sessionKey ?? null,
          originClass: sourceProvenance.originClass,
          observedAt: sourceProvenance.observedAt,
        });
      }
    }
    // Reserve lineage before publishing candidates. A failed provenance write
    // must not leave durable staged content without its source-session facts.
    for (const agentId of sourceSessions.keys()) {
      recordMemoryEntryOrigins({
        agentId,
        origins: origins.filter((origin) => origin.agentId === agentId),
      });
    }
    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    if (signalType === "grounded") {
      return;
    }
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: nowIso,
      query,
      resultCount: admitted.length,
      results: admitted.map((result) => ({
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
          eligibleResultCount: admitted.length,
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
    projectKey?: string;
    provenance?: MemoryEntryProvenance;
    sessionOrigin?: SessionEntryOrigin;
  }>;
  dedupeByQueryPerDay?: boolean;
  dayBucket?: string;
  nowMs?: number;
  timezone?: string;
}): Promise<void> {
  const { items, ...options } = params;
  await recordShortTermRecalls({
    ...options,
    signalType: "grounded",
    results: items.map((item) => Object.assign({}, item, { source: "memory" as const })),
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
