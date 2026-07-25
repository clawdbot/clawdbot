// Stable public surface for short-term promotion behavior.
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { readPhaseSignalStore, readStore } from "./short-term-promotion-store.js";
import {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  type PromotionCandidate,
  type RankShortTermPromotionOptions,
  type ShortTermPhaseSignalEntry,
} from "./short-term-promotion-types.js";
import {
  calculateRecencyComponent,
  clampScore,
  isContaminatedDreamingSnippet,
  isShortTermMemoryPath,
  isShortTermSessionCorpusPath,
  normalizeWeights,
  toFiniteNonNegativeInt,
  toFinitePositive,
  toFiniteScore,
  totalSignalCountForEntry,
} from "./short-term-promotion-utils.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
const PHASE_SIGNAL_LIGHT_BOOST_MAX = 0.06;
const PHASE_SIGNAL_REM_BOOST_MAX = 0.09;
const PHASE_SIGNAL_HALF_LIFE_DAYS = 14;

function calculateConsolidationComponent(recallDays: string[]): number {
  if (recallDays.length === 0) {
    return 0;
  }
  if (recallDays.length === 1) {
    return 0.2;
  }
  const parsed = recallDays
    .map((recallDay) => Date.parse(recallDay + "T00:00:00.000Z"))
    .filter((value) => Number.isFinite(value))
    .toSorted((left, right) => left - right);
  if (parsed.length <= 1) {
    return 0.2;
  }
  const first = expectDefined(parsed.at(0), "multiple parsed recall days");
  const last = expectDefined(parsed.at(-1), "multiple parsed recall days");
  const spanDays = Math.max(0, (last - first) / DAY_MS);
  const spacing = clampScore(Math.log1p(parsed.length - 1) / Math.log1p(4));
  const span = clampScore(spanDays / 7);
  return clampScore(0.55 * spacing + 0.45 * span);
}

function calculateConceptualComponent(conceptTags: string[]): number {
  return clampScore(conceptTags.length / 6);
}
function calculatePhaseSignalAgeDays(lastSeenAt: string | undefined, nowMs: number): number | null {
  if (!lastSeenAt) {
    return null;
  }
  const parsed = Date.parse(lastSeenAt);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.max(0, (nowMs - parsed) / DAY_MS);
}

function calculatePhaseSignalBoost(
  entry: ShortTermPhaseSignalEntry | undefined,
  nowMs: number,
): number {
  if (!entry) {
    return 0;
  }
  const lightStrength = clampScore(Math.log1p(Math.max(0, entry.lightHits)) / Math.log1p(6));
  const remStrength = clampScore(Math.log1p(Math.max(0, entry.remHits)) / Math.log1p(6));
  const lightAgeDays = calculatePhaseSignalAgeDays(entry.lastLightAt, nowMs);
  const remAgeDays = calculatePhaseSignalAgeDays(entry.lastRemAt, nowMs);
  const lightRecency =
    lightAgeDays === null
      ? 0
      : clampScore(calculateRecencyComponent(lightAgeDays, PHASE_SIGNAL_HALF_LIFE_DAYS));
  const remRecency =
    remAgeDays === null
      ? 0
      : clampScore(calculateRecencyComponent(remAgeDays, PHASE_SIGNAL_HALF_LIFE_DAYS));
  return clampScore(
    PHASE_SIGNAL_LIGHT_BOOST_MAX * lightStrength * lightRecency +
      PHASE_SIGNAL_REM_BOOST_MAX * remStrength * remRecency,
  );
}
export async function rankShortTermPromotionCandidates(
  options: RankShortTermPromotionOptions,
): Promise<PromotionCandidate[]> {
  const workspaceDir = options.workspaceDir.trim();
  if (!workspaceDir) {
    return [];
  }

  const nowMs = resolveMemoryCoreNowMs(options.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const minScore = toFiniteScore(options.minScore, DEFAULT_PROMOTION_MIN_SCORE);
  const minRecallCount = toFiniteNonNegativeInt(
    options.minRecallCount,
    DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  );
  const minUniqueQueries = toFiniteNonNegativeInt(
    options.minUniqueQueries,
    DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  );
  const maxAgeDays = toFiniteNonNegativeInt(options.maxAgeDays, -1);
  const includePromoted = Boolean(options.includePromoted);
  const halfLifeDays = toFinitePositive(
    options.recencyHalfLifeDays,
    DEFAULT_RECENCY_HALF_LIFE_DAYS,
  );
  const weights = normalizeWeights(options.weights);

  const [store, phaseSignals] = await Promise.all([
    readStore(workspaceDir, nowIso),
    readPhaseSignalStore(workspaceDir, nowIso),
  ]);
  const candidates: PromotionCandidate[] = [];

  for (const entry of Object.values(store.entries)) {
    if (!entry || entry.source !== "memory" || !isShortTermMemoryPath(entry.path)) {
      continue;
    }
    if (
      isContaminatedDreamingSnippet(entry.snippet, {
        allowTranscriptTurnSnippet: isShortTermSessionCorpusPath(entry.path),
      })
    ) {
      continue;
    }
    if (!includePromoted && entry.promotedAt) {
      continue;
    }
    const recallCount = Math.max(0, Math.floor(entry.recallCount ?? 0));
    const dailyCount = Math.max(0, Math.floor(entry.dailyCount ?? 0));
    const groundedCount = Math.max(0, Math.floor(entry.groundedCount ?? 0));
    const signalCount = totalSignalCountForEntry(entry);
    if (signalCount <= 0) {
      continue;
    }
    if (signalCount < minRecallCount) {
      continue;
    }

    const avgScore = clampScore(entry.totalScore / Math.max(1, signalCount));
    const frequency = clampScore(Math.log1p(signalCount) / Math.log1p(10));
    const uniqueQueries = entry.queryHashes?.length ?? 0;
    const contextDiversity = Math.max(uniqueQueries, entry.recallDays?.length ?? 0);
    if (contextDiversity < minUniqueQueries) {
      continue;
    }
    const diversity = clampScore(contextDiversity / 5);
    const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
    const ageDays = Number.isFinite(lastRecalledAtMs)
      ? Math.max(0, (nowMs - lastRecalledAtMs) / DAY_MS)
      : 0;
    if (maxAgeDays >= 0 && ageDays > maxAgeDays) {
      continue;
    }
    const recency = clampScore(calculateRecencyComponent(ageDays, halfLifeDays));
    const recallDays = entry.recallDays ?? [];
    const conceptTags = entry.conceptTags ?? [];
    const consolidation = Math.max(
      calculateConsolidationComponent(recallDays),
      clampScore(groundedCount / 3),
    );
    const conceptual = calculateConceptualComponent(conceptTags);

    const phaseBoost = calculatePhaseSignalBoost(phaseSignals.entries[entry.key], nowMs);
    const score =
      weights.frequency * frequency +
      weights.relevance * avgScore +
      weights.diversity * diversity +
      weights.recency * recency +
      weights.consolidation * consolidation +
      weights.conceptual * conceptual +
      phaseBoost;

    if (score < minScore) {
      continue;
    }

    candidates.push({
      key: entry.key,
      path: entry.path,
      startLine: entry.startLine,
      endLine: entry.endLine,
      source: entry.source,
      snippet: entry.snippet,
      recallCount,
      dailyCount,
      groundedCount,
      signalCount,
      avgScore,
      maxScore: clampScore(entry.maxScore),
      uniqueQueries,
      ...(entry.claimHash ? { claimHash: entry.claimHash } : {}),
      promotedAt: entry.promotedAt,
      firstRecalledAt: entry.firstRecalledAt,
      lastRecalledAt: entry.lastRecalledAt,
      ageDays,
      score: clampScore(score),
      recallDays,
      conceptTags,
      components: {
        frequency,
        relevance: avgScore,
        diversity,
        recency,
        consolidation,
        conceptual,
      },
    });
  }

  const sorted = candidates.toSorted((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.recallCount !== a.recallCount) {
      return b.recallCount - a.recallCount;
    }
    return a.path.localeCompare(b.path);
  });

  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit as number))
    : sorted.length;
  return sorted.slice(0, limit);
}

export {
  DEFAULT_PROMOTION_MIN_RECALL_COUNT,
  DEFAULT_PROMOTION_MIN_SCORE,
  DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES,
  SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH,
  SHORT_TERM_STORE_RELATIVE_PATH,
  type PromotionCandidate,
  type RepairShortTermPromotionArtifactsResult,
  type ShortTermAuditSummary,
  type ShortTermDreamingStats,
  type ShortTermDreamingStatsEntry,
  type ShortTermRecallEntry,
} from "./short-term-promotion-types.js";
export { normalizeShortTermPhaseSignalStore } from "./short-term-promotion-store.js";
export { normalizeShortTermRecallStore } from "./short-term-promotion-utils.js";
export {
  filterFreshLightDreamingEntries,
  loadShortTermPromotionDreamingStats,
  readLightStagedKeys,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
} from "./short-term-promotion-stats.js";
export {
  filterLiveShortTermRecallEntries,
  readShortTermRecallEntries,
  recordGroundedShortTermCandidates,
  recordShortTermRecalls,
} from "./short-term-promotion-record.js";
export { applyShortTermPromotions } from "./short-term-promotion-apply.js";
export {
  auditShortTermPromotionArtifacts,
  removeGroundedShortTermCandidates,
  repairShortTermPromotionArtifacts,
  resolveShortTermRecallLockPath,
  resolveShortTermRecallStorePath,
} from "./short-term-promotion-artifacts.js";
