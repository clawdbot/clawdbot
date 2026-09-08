import type { MemoryEntryProvenance } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE,
  DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type {
  RepairShortTermPromotionArtifactsResult as MemoryRepairShortTermPromotionArtifactsResult,
  ShortTermAuditIssue as MemoryShortTermAuditIssue,
  ShortTermAuditSummary as MemoryShortTermAuditSummary,
  ShortTermDreamingStats,
  ShortTermDreamingStatsEntry,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { ConceptTagScriptCoverage } from "./concept-vocabulary.js";

export const DEFAULT_PROMOTION_MIN_SCORE = DEFAULT_MEMORY_DEEP_DREAMING_MIN_SCORE;
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = DEFAULT_MEMORY_DEEP_DREAMING_MIN_RECALL_COUNT;
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = DEFAULT_MEMORY_DEEP_DREAMING_MIN_UNIQUE_QUERIES;
export type PromotionWeights = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};

export type ShortTermRecallEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalScore: number;
  maxScore: number;
  firstRecalledAt: string;
  lastRecalledAt: string;
  queryHashes: string[];
  recallDays: string[];
  conceptTags: string[];
  claimHash?: string;
  projectKey?: string;
  promotedAt?: string;
  provenance?: MemoryEntryProvenance;
};

export type ShortTermRecallStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermRecallEntry>;
};

export type ShortTermPhaseSignalEntry = {
  key: string;
  lightHits: number;
  remHits: number;
  lastLightAt?: string;
  lastRemAt?: string;
  lastRemConsideredAt?: string;
};

export type ShortTermPhaseSignalStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermPhaseSignalEntry>;
};

export type ShortTermStoreMeta = {
  updatedAt: string;
};

export type ShortTermLockEntry = {
  owner: string;
  acquiredAt: number;
  ownerStartTime?: number;
};

type PromotionComponents = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};

export type PromotionCandidate = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  source: "memory";
  snippet: string;
  recallCount: number;
  dailyCount?: number;
  groundedCount?: number;
  signalCount: number;
  avgScore: number;
  maxScore: number;
  uniqueQueries: number;
  claimHash?: string;
  projectKey?: string;
  promotedAt?: string;
  firstRecalledAt: string;
  lastRecalledAt: string;
  ageDays: number;
  score: number;
  recallDays: string[];
  conceptTags: string[];
  components: PromotionComponents;
  provenance?: MemoryEntryProvenance;
};

export type ShortTermAuditSummary = MemoryShortTermAuditSummary<ConceptTagScriptCoverage>;
export type ShortTermAuditIssue = MemoryShortTermAuditIssue;

export type RepairShortTermPromotionArtifactsResult = Omit<
  MemoryRepairShortTermPromotionArtifactsResult,
  "removedOverflowEntries"
> & { removedOverflowEntries: number };

export type RankShortTermPromotionOptions = {
  workspaceDir: string;
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  maxAgeDays?: number;
  includePromoted?: boolean;
  recencyHalfLifeDays?: number;
  weights?: Partial<PromotionWeights>;
  nowMs?: number;
};

export type ApplyShortTermPromotionsOptions = {
  agentId?: string;
  workspaceAgentIds?: readonly string[];
  workspaceDir: string;
  candidates: PromotionCandidate[];
  limit?: number;
  minScore?: number;
  minRecallCount?: number;
  minUniqueQueries?: number;
  maxAgeDays?: number;
  nowMs?: number;
  timezone?: string;
  /**
   * Maximum size of MEMORY.md on disk after a promotion write, in
   * characters. When the post-write size would exceed this budget, the
   * oldest auto-promotion sections are compacted out before write so the
   * file stays bounded and bootstrap injection keeps reaching new
   * sessions. Pass `0` to disable compaction. Defaults to
   * `DEFAULT_MEMORY_FILE_MAX_CHARS`. See #73691.
   */
  memoryFileMaxChars?: number;
  /**
   * Maximum visible size of each promoted short-term snippet in MEMORY.md, in
   * estimated tokens. This keeps daily journal ranges from being copied
   * wholesale into long-term memory while preserving the candidate's provenance
   * metadata.
   */
  maxPromotedSnippetTokens?: number;
  maxPriorEntryLossFraction?: number;
  consolidation?: {
    subagent?: import("./dreaming-narrative.js").DreamingCompletion;
    model?: string;
    logger: {
      info: (message: string) => void;
      warn: (message: string) => void;
    };
  };
};

export type ApplyShortTermPromotionsResult = {
  memoryPath: string;
  applied: number;
  appended: number;
  reconciledExisting: number;
  appliedCandidates: PromotionCandidate[];
  rejectedCandidates: Array<{
    candidate: PromotionCandidate;
    reason: string;
  }>;
  /** Number of older promotion sections compacted out to honor the budget. */
  compactedSections: number;
  /** Dates of the compacted promotion sections, oldest first. */
  compactedDates: string[];
};

export type { ShortTermDreamingStats, ShortTermDreamingStatsEntry };
