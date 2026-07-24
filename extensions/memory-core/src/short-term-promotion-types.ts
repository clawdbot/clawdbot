import path from "node:path";
import type { ConceptTagScriptCoverage } from "./concept-vocabulary.js";

export const DEFAULT_PROMOTION_MIN_SCORE = 0.75;
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = 3;
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = 2;
export const SHORT_TERM_STORE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "short-term-recall.json",
);
export const SHORT_TERM_PHASE_SIGNAL_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "phase-signals.json",
);

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
  promotedAt?: string;
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
  promotedAt?: string;
  firstRecalledAt: string;
  lastRecalledAt: string;
  ageDays: number;
  score: number;
  recallDays: string[];
  conceptTags: string[];
  components: PromotionComponents;
};

export type ShortTermAuditIssue = {
  severity: "warn" | "error";
  code:
    | "recall-store-unreadable"
    | "recall-store-empty"
    | "recall-store-invalid"
    | "recall-store-over-limit"
    | "recall-lock-stale"
    | "recall-lock-unreadable"
    | "qmd-index-missing"
    | "qmd-index-empty"
    | "qmd-collections-empty";
  message: string;
  fixable: boolean;
};

export type ShortTermAuditSummary = {
  storePath: string;
  lockPath: string;
  updatedAt?: string;
  exists: boolean;
  entryCount: number;
  promotedCount: number;
  spacedEntryCount: number;
  conceptTaggedEntryCount: number;
  conceptTagScripts?: ConceptTagScriptCoverage;
  invalidEntryCount: number;
  issues: ShortTermAuditIssue[];
  qmd?:
    | {
        dbPath?: string;
        collections?: number;
        dbBytes?: number;
      }
    | undefined;
};

export type RepairShortTermPromotionArtifactsResult = {
  changed: boolean;
  removedInvalidEntries: number;
  removedOverflowEntries: number;
  rewroteStore: boolean;
  removedStaleLock: boolean;
};

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
};

export type ApplyShortTermPromotionsResult = {
  memoryPath: string;
  applied: number;
  appended: number;
  reconciledExisting: number;
  appliedCandidates: PromotionCandidate[];
  /** Number of older promotion sections compacted out to honor the budget. */
  compactedSections: number;
  /** Dates of the compacted promotion sections, oldest first. */
  compactedDates: string[];
};

export type ShortTermDreamingStatsEntry = {
  key: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  recallCount: number;
  dailyCount: number;
  groundedCount: number;
  totalSignalCount: number;
  lightHits: number;
  remHits: number;
  phaseHitCount: number;
  promotedAt?: string;
  lastRecalledAt?: string;
};

export type ShortTermDreamingStats = {
  shortTermCount: number;
  recallSignalCount: number;
  dailySignalCount: number;
  groundedSignalCount: number;
  totalSignalCount: number;
  phaseSignalCount: number;
  lightPhaseHitCount: number;
  remPhaseHitCount: number;
  promotedTotal: number;
  promotedToday: number;
  storePath: string;
  phaseSignalPath: string;
  phaseSignalError?: string;
  lastPromotedAt?: string;
  shortTermEntries: ShortTermDreamingStatsEntry[];
  signalEntries: ShortTermDreamingStatsEntry[];
  promotedEntries: ShortTermDreamingStatsEntry[];
};
