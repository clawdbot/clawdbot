// Memory Core plugin module implements short term promotion behavior.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  formatMemoryDreamingDay,
  isSameMemoryDreamingDay,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { appendMemoryHostEvent } from "openclaw/plugin-sdk/memory-host-events";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeStringEntries,
  uniqueStrings,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  deriveConceptTags,
  MAX_CONCEPT_TAGS,
  summarizeConceptTagScriptCoverage,
  type ConceptTagScriptCoverage,
} from "./concept-vocabulary.js";
import { asRecord, formatErrorMessage } from "./dreaming-shared.js";
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
import { compactMemoryForBudget, DEFAULT_MEMORY_FILE_MAX_CHARS } from "./memory-budget.js";
import { resolveMemoryCoreNowMs, resolveMemoryCoreTimestamp } from "./time.js";

const SHORT_TERM_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const DREAMING_MEMORY_PATH_RE = /(?:^|\/)memory\/dreaming\//;
const SHORT_TERM_SESSION_CORPUS_RE =
  /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/;
const SHORT_TERM_BASENAME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENCY_HALF_LIFE_DAYS = 14;
export const DEFAULT_PROMOTION_MIN_SCORE = 0.75;
export const DEFAULT_PROMOTION_MIN_RECALL_COUNT = 3;
export const DEFAULT_PROMOTION_MIN_UNIQUE_QUERIES = 2;
const PROMOTION_MARKER_PREFIX = "openclaw-memory-promotion:";
const PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE = 4;
const MAX_QUERY_HASHES = 32;
const MAX_RECALL_DAYS = 16;
const SHORT_TERM_RECALL_MAX_ENTRIES = 512;
const SHORT_TERM_RECALL_MAX_SNIPPET_CHARS = 800;
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
const SHORT_TERM_LOCK_WAIT_TIMEOUT_MS = 10_000;
const SHORT_TERM_LOCK_STALE_MS = 60_000;
const SHORT_TERM_LOCK_RETRY_DELAY_MS = 40;
const DREAMING_ENTRY_LIST_LIMIT = 8;
// Repeated dreaming revisits should be able to clear the default promotion gate
// without requiring separate organic recall traffic for the same snippet.
const PHASE_SIGNAL_LIGHT_BOOST_MAX = 0.06;
const PHASE_SIGNAL_REM_BOOST_MAX = 0.09;
const PHASE_SIGNAL_HALF_LIFE_DAYS = 14;
const DREAMING_TRANSCRIPT_PROMPT_LINE_RE =
  /\[[^\]]*dreaming-narrative[^\]]*]\s*(?:User|Assistant):\s*Write a dream diary entry from these memory fragments:?/i;
const RAW_SESSION_METADATA_RE =
  /\bSession Key\b.{0,260}\bSession ID\b|\bSession ID\b.{0,260}\bSession Key\b/i;
const RAW_CONVERSATION_SUMMARY_RE = /^(?:[-*+]\s*)?Conversation Summary:/i;
const RAW_TRANSCRIPT_TURN_RE = /^(?:[-*+]\s*)?(?:user|assistant):\s/i;
const MEMORY_FLUSH_PROMPT_RE =
  /Save important context from this session to the daily memory file\.\s*STRICT RULES:/i;
// Optional signals=N accepts both legacy annotations and the current format.
const PROMOTION_SCORE_METADATA_RE =
  /\[\s*score=\d+(?:\.\d+)?\s+(?:signals=\d+\s+)?recalls=\d+\s+avg=\d+(?:\.\d+)?\s+source=memory\//i;
const DREAMING_DIFF_PREFIX_RE = /@@\s*-\d+(?:,\d+)?\s+[-*+]\s+/iy;
const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const PROMOTION_LIST_MARKER_RE = /^(?:\d+\.\s+|[-*+]\s+)/;
const MANAGED_DREAMING_HEADINGS = new Set(["light sleep", "rem sleep"]);
const inProcessShortTermLocks = new KeyedAsyncQueue();

type PromotionWeights = {
  frequency: number;
  relevance: number;
  diversity: number;
  recency: number;
  consolidation: number;
  conceptual: number;
};

const DEFAULT_PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.3,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  conceptual: 0.06,
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

type ShortTermRecallStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermRecallEntry>;
};

type ShortTermPhaseSignalEntry = {
  key: string;
  lightHits: number;
  remHits: number;
  lastLightAt?: string;
  lastRemAt?: string;
  lastRemConsideredAt?: string;
};

type ShortTermPhaseSignalStore = {
  version: 1;
  updatedAt: string;
  entries: Record<string, ShortTermPhaseSignalEntry>;
};

type ShortTermStoreMeta = {
  updatedAt: string;
};

type ShortTermLockEntry = {
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

type ShortTermAuditIssue = {
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

type RankShortTermPromotionOptions = {
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

type ApplyShortTermPromotionsOptions = {
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

type ApplyShortTermPromotionsResult = {
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

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function toFiniteScore(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  if (num < 0 || num > 1) {
    return fallback;
  }
  return num;
}

function normalizeSnippet(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, " ");
}

function truncateShortTermSnippet(snippet: string): string {
  if (snippet.length <= SHORT_TERM_RECALL_MAX_SNIPPET_CHARS) {
    return snippet;
  }
  return truncateUtf16Safe(snippet, SHORT_TERM_RECALL_MAX_SNIPPET_CHARS).trimEnd();
}

function enforceShortTermRecallSnippetCap(store: ShortTermRecallStore): void {
  for (const entry of Object.values(store.entries)) {
    entry.snippet = truncateShortTermSnippet(entry.snippet);
  }
}

function consumeDreamingLeadPrefix(snippet: string): string {
  let index = 0;
  while (index < snippet.length) {
    DREAMING_DIFF_PREFIX_RE.lastIndex = index;
    const diffMatch = DREAMING_DIFF_PREFIX_RE.exec(snippet);
    if (diffMatch) {
      index = DREAMING_DIFF_PREFIX_RE.lastIndex;
      continue;
    }
    const char = snippet[index];
    if (char === "[" || char === "(") {
      index += 1;
      while (snippet[index] === " ") {
        index += 1;
      }
      continue;
    }
    if (
      (char === "-" || char === "*" || char === "+" || char === ">") &&
      snippet[index + 1] === " "
    ) {
      index += 2;
      continue;
    }
    break;
  }
  return snippet.slice(index);
}

function hasDreamingNarrativeLead(snippet: string): boolean {
  const withoutPrefix = consumeDreamingLeadPrefix(snippet);
  if (/^(?:Candidate|Reflections?):/i.test(withoutPrefix)) {
    return true;
  }
  // Managed dreaming blocks occasionally serialize recall metadata (status:/confidence:/
  // evidence:/recalls:) inline before the Candidate or Reflections marker, so the
  // start-of-string check misses shapes like "status: staged - Candidate: User: ...".
  // The composite detector below still requires the full signal combination, so widening
  // the lead check to anywhere in the first 200 chars closes the leak without creating
  // false positives for ordinary durable notes that merely mention the word in prose.
  const head = withoutPrefix.slice(0, 200);
  return /\b(?:Candidate|Reflections?):/i.test(head);
}

function isContaminatedDreamingSnippet(
  raw: string,
  opts: { allowTranscriptTurnSnippet?: boolean } = {},
): boolean {
  const snippet = normalizeSnippet(raw);
  if (!snippet) {
    return false;
  }
  if (
    /<!--\s*openclaw-memory-promotion:/i.test(snippet) ||
    DREAMING_TRANSCRIPT_PROMPT_LINE_RE.test(snippet) ||
    RAW_SESSION_METADATA_RE.test(snippet) ||
    RAW_CONVERSATION_SUMMARY_RE.test(snippet) ||
    (!opts.allowTranscriptTurnSnippet && RAW_TRANSCRIPT_TURN_RE.test(snippet)) ||
    MEMORY_FLUSH_PROMPT_RE.test(snippet) ||
    PROMOTION_SCORE_METADATA_RE.test(snippet)
  ) {
    return true;
  }

  const hasNarrativeLead = hasDreamingNarrativeLead(snippet);
  const hasConfidence = /\bconfidence:\s*\d/i.test(snippet);
  const hasEvidence = /\bevidence:\s*(?:memory\/\.dreams\/session-corpus\/|memory\/)/i.test(
    snippet,
  );
  const hasStatus = /\bstatus:\s*staged\b/i.test(snippet);
  const hasRecalls = /\brecalls:\s*\d+\b/i.test(snippet);
  return hasNarrativeLead && hasConfidence && hasEvidence && hasStatus && hasRecalls;
}

function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

function buildClaimHash(snippet: string): string {
  return createHash("sha1").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12);
}

function buildEntryKey(result: {
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  claimHash?: string;
}): string {
  const base = `${result.source}:${normalizeMemoryPath(result.path)}:${result.startLine}:${result.endLine}`;
  return result.claimHash ? `${base}:${result.claimHash}` : base;
}

function hashQuery(query: string): string {
  return createHash("sha1")
    .update(normalizeLowercaseStringOrEmpty(query))
    .digest("hex")
    .slice(0, 12);
}

function mergeQueryHashes(existing: string[], queryHash: string): string[] {
  if (!queryHash) {
    return existing;
  }
  const seen = new Set<string>();
  const next = existing.filter((value) => {
    if (!value || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
  if (!seen.has(queryHash)) {
    next.push(queryHash);
  }
  if (next.length <= MAX_QUERY_HASHES) {
    return next;
  }
  return next.slice(next.length - MAX_QUERY_HASHES);
}

function mergeRecentDistinct(existing: string[], nextValue: string, limit: number): string[] {
  const seen = new Set<string>();
  const next = existing.filter((value): value is string => {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) {
      return false;
    }
    seen.add(value);
    return true;
  });
  if (nextValue && !next.includes(nextValue)) {
    next.push(nextValue);
  }
  if (next.length <= limit) {
    return next;
  }
  return next.slice(next.length - limit);
}

function normalizeIsoDay(isoLike: string): string | null {
  if (typeof isoLike !== "string") {
    return null;
  }
  const match = isoLike.trim().match(/^(\d{4}-\d{2}-\d{2})/);
  return match?.[1] ?? null;
}

function normalizeDistinctStrings(values: unknown[], limit: number): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
    if (normalized.length >= limit) {
      break;
    }
  }
  return normalized;
}

function totalSignalCountForEntry(entry: {
  recallCount?: number;
  dailyCount?: number;
  groundedCount?: number;
}): number {
  return (
    Math.max(0, Math.floor(entry.recallCount ?? 0)) +
    Math.max(0, Math.floor(entry.dailyCount ?? 0)) +
    Math.max(0, Math.floor(entry.groundedCount ?? 0))
  );
}

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

function emptyStore(nowIso: string): ShortTermRecallStore {
  return {
    version: 1,
    updatedAt: nowIso,
    entries: {},
  };
}

export function normalizeShortTermRecallStore(raw: unknown, nowIso: string): ShortTermRecallStore {
  if (!raw || typeof raw !== "object") {
    return emptyStore(nowIso);
  }
  const record = raw as Record<string, unknown>;
  const entriesRaw = record.entries;
  const entries: Record<string, ShortTermRecallEntry> = {};

  if (entriesRaw && typeof entriesRaw === "object") {
    for (const [key, value] of Object.entries(entriesRaw as Record<string, unknown>)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const entry = value as Record<string, unknown>;
      const entryPath = typeof entry.path === "string" ? normalizeMemoryPath(entry.path) : "";
      const startLine = Number(entry.startLine);
      const endLine = Number(entry.endLine);
      const source = entry.source === "memory" ? "memory" : null;
      if (!entryPath || !Number.isInteger(startLine) || !Number.isInteger(endLine) || !source) {
        continue;
      }

      const recallCount = Math.max(0, Math.floor(Number(entry.recallCount) || 0));
      const dailyCount = Math.max(0, Math.floor(Number(entry.dailyCount) || 0));
      const groundedCount = Math.max(0, Math.floor(Number(entry.groundedCount) || 0));
      const totalScore = Math.max(0, Number(entry.totalScore) || 0);
      const maxScore = clampScore(Number(entry.maxScore) || 0);
      const firstRecalledAt =
        typeof entry.firstRecalledAt === "string" ? entry.firstRecalledAt : nowIso;
      const lastRecalledAt =
        typeof entry.lastRecalledAt === "string" ? entry.lastRecalledAt : nowIso;
      const promotedAt = typeof entry.promotedAt === "string" ? entry.promotedAt : undefined;
      const claimHash =
        typeof entry.claimHash === "string" && entry.claimHash.trim().length > 0
          ? entry.claimHash.trim()
          : undefined;
      const fullSnippet = typeof entry.snippet === "string" ? normalizeSnippet(entry.snippet) : "";
      if (
        fullSnippet &&
        isContaminatedDreamingSnippet(fullSnippet, {
          allowTranscriptTurnSnippet: isShortTermSessionCorpusPath(entryPath),
        })
      ) {
        continue;
      }
      const snippet = truncateShortTermSnippet(fullSnippet);
      const queryHashes = Array.isArray(entry.queryHashes)
        ? normalizeDistinctStrings(entry.queryHashes, MAX_QUERY_HASHES)
        : [];
      const recallDays = Array.isArray(entry.recallDays)
        ? entry.recallDays
            .map((recallDay) => (typeof recallDay === "string" ? normalizeIsoDay(recallDay) : null))
            .filter((valueLocal): valueLocal is string => valueLocal !== null)
        : [];
      const conceptTags = Array.isArray(entry.conceptTags)
        ? normalizeDistinctStrings(
            entry.conceptTags.map((tag) =>
              typeof tag === "string" ? normalizeLowercaseStringOrEmpty(tag) : tag,
            ),
            MAX_CONCEPT_TAGS,
          )
        : deriveConceptTags({ path: entryPath, snippet: fullSnippet });

      const normalizedKey =
        key || buildEntryKey({ path: entryPath, startLine, endLine, source, claimHash });
      entries[normalizedKey] = {
        key: normalizedKey,
        path: entryPath,
        startLine,
        endLine,
        source,
        snippet,
        recallCount,
        dailyCount,
        groundedCount,
        totalScore,
        maxScore,
        firstRecalledAt,
        lastRecalledAt,
        queryHashes,
        recallDays: recallDays.slice(-MAX_RECALL_DAYS),
        conceptTags,
        ...(claimHash ? { claimHash } : {}),
        ...(promotedAt ? { promotedAt } : {}),
      };
    }
  }

  return {
    version: 1,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso,
    entries,
  };
}

function parseStoreTimestampMs(value: string | undefined): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function compareStoreTimestampDesc(left: string | undefined, right: string | undefined): number {
  const leftMs = parseStoreTimestampMs(left);
  const rightMs = parseStoreTimestampMs(right);
  if (leftMs === rightMs) {
    return 0;
  }
  return rightMs > leftMs ? 1 : -1;
}

function compareShortTermRecallRetention(a: ShortTermRecallEntry, b: ShortTermRecallEntry): number {
  const lastDiff = compareStoreTimestampDesc(a.lastRecalledAt, b.lastRecalledAt);
  if (lastDiff !== 0) {
    return lastDiff;
  }
  const signalDiff = totalSignalCountForEntry(b) - totalSignalCountForEntry(a);
  if (signalDiff !== 0) {
    return signalDiff;
  }
  const totalScoreDiff = b.totalScore - a.totalScore;
  if (totalScoreDiff !== 0) {
    return totalScoreDiff;
  }
  const maxScoreDiff = b.maxScore - a.maxScore;
  if (maxScoreDiff !== 0) {
    return maxScoreDiff;
  }
  const promotedDiff = compareStoreTimestampDesc(a.promotedAt, b.promotedAt);
  if (promotedDiff !== 0) {
    return promotedDiff;
  }
  return a.key.localeCompare(b.key);
}

function enforceShortTermRecallStoreRetention(store: ShortTermRecallStore): number {
  const entries = Object.entries(store.entries);
  if (entries.length <= SHORT_TERM_RECALL_MAX_ENTRIES) {
    return 0;
  }
  const retained = entries
    .toSorted(([, a], [, b]) => compareShortTermRecallRetention(a, b))
    .slice(0, SHORT_TERM_RECALL_MAX_ENTRIES);
  store.entries = Object.fromEntries(retained.toSorted(([a], [b]) => a.localeCompare(b)));
  return entries.length - retained.length;
}

function toFinitePositive(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return num;
}

function toFiniteNonNegativeInt(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  const floored = Math.floor(num);
  if (floored < 0) {
    return fallback;
  }
  return floored;
}

function normalizeWeights(weights?: Partial<PromotionWeights>): PromotionWeights {
  const merged = {
    ...DEFAULT_PROMOTION_WEIGHTS,
    ...weights,
  };
  const frequency = Math.max(0, merged.frequency);
  const relevance = Math.max(0, merged.relevance);
  const diversity = Math.max(0, merged.diversity);
  const recency = Math.max(0, merged.recency);
  const consolidation = Math.max(0, merged.consolidation);
  const conceptual = Math.max(0, merged.conceptual);
  const sum = frequency + relevance + diversity + recency + consolidation + conceptual;
  if (sum <= 0) {
    return { ...DEFAULT_PROMOTION_WEIGHTS };
  }
  return {
    frequency: frequency / sum,
    relevance: relevance / sum,
    diversity: diversity / sum,
    recency: recency / sum,
    consolidation: consolidation / sum,
    conceptual: conceptual / sum,
  };
}

function calculateRecencyComponent(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return 1;
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 1;
  }
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
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

function resolveStorePath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_RECALL_NAMESPACE, workspaceDir);
}

function resolvePhaseSignalPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_PHASE_SIGNAL_NAMESPACE, workspaceDir);
}

function resolveLockPath(workspaceDir: string): string {
  return memoryCoreStateReference(SHORT_TERM_LOCK_NAMESPACE, workspaceDir);
}

function parseLockOwnerPid(raw: string): number | null {
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

function isProcessLikelyAlive(pid: number): boolean {
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

async function withShortTermLock<T>(workspaceDir: string, task: () => Promise<T>): Promise<T> {
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

async function readStore(workspaceDir: string, nowIso: string): Promise<ShortTermRecallStore> {
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

function emptyPhaseSignalStore(nowIso: string): ShortTermPhaseSignalStore {
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

async function readPhaseSignalStore(
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

async function writePhaseSignalStore(
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

async function writeStore(workspaceDir: string, store: ShortTermRecallStore): Promise<void> {
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

export function isShortTermMemoryPath(filePath: string): boolean {
  const normalized = normalizeMemoryPath(filePath);
  if (DREAMING_MEMORY_PATH_RE.test(normalized)) {
    return false;
  }
  if (SHORT_TERM_PATH_RE.test(normalized)) {
    return true;
  }
  if (SHORT_TERM_SESSION_CORPUS_RE.test(normalized)) {
    return true;
  }
  return SHORT_TERM_BASENAME_RE.test(normalized);
}

function isShortTermSessionCorpusPath(filePath: string): boolean {
  return SHORT_TERM_SESSION_CORPUS_RE.test(normalizeMemoryPath(filePath));
}

function normalizeMemoryPathForWorkspace(workspaceDir: string, rawPath: string): string {
  const normalized = normalizeMemoryPath(rawPath);
  const workspaceNormalized = normalizeMemoryPath(workspaceDir);
  if (path.isAbsolute(rawPath) && normalized.startsWith(`${workspaceNormalized}/`)) {
    return normalized.slice(workspaceNormalized.length + 1);
  }
  return normalized;
}

function toNonNegativeInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.floor(num));
}

function parseEntryRangeFromKey(
  key: string,
  fallbackStartLine: unknown,
  fallbackEndLine: unknown,
): { startLine: number; endLine: number } {
  const startLine = toNonNegativeInt(fallbackStartLine);
  const endLine = toNonNegativeInt(fallbackEndLine);
  if (startLine > 0 && endLine > 0) {
    return { startLine, endLine };
  }
  const match = key.match(/:(\d+):(\d+)$/);
  if (match) {
    return {
      startLine: Math.max(1, toNonNegativeInt(match[1])),
      endLine: Math.max(1, toNonNegativeInt(match[2])),
    };
  }
  return { startLine: 1, endLine: 1 };
}

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
  const checkSourceFile = (sourcePath: string): Promise<boolean> => {
    const existing = sourceFileChecks.get(sourcePath);
    if (existing) {
      return existing;
    }
    const check = shortTermRecallSourceIsFile(sourcePath);
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

function resolveShortTermSourcePathCandidates(
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

function normalizeRangeSnippet(lines: string[], startLine: number, endLine: number): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  return normalizeSnippet(lines.slice(startIndex, endIndex).join(" "));
}

function normalizeListMarkerFreeRangeSnippet(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  const startIndex = Math.max(0, startLine - 1);
  const endIndex = Math.min(lines.length, endLine);
  if (startIndex >= endIndex) {
    return "";
  }
  const strippedLines = lines.slice(startIndex, endIndex).map((line) => {
    const trimmed = line.trim();
    const withoutMarker = trimmed.replace(PROMOTION_LIST_MARKER_RE, "");
    return { text: withoutMarker, hadListMarker: withoutMarker !== trimmed };
  });
  const joiner =
    strippedLines.length > 1 && strippedLines.every((line) => line.hadListMarker) ? "; " : " ";
  return normalizeSnippet(strippedLines.map((line) => line.text).join(joiner));
}

function normalizeDailyHeadingForPromotion(line: string): string | null {
  const match = line.trim().match(/^#{1,6}\s+(.+)$/);
  const heading = match?.[1]?.replace(PROMOTION_LIST_MARKER_RE, "").trim() ?? "";
  const normalized = normalizeSnippet(heading);
  if (
    !normalized ||
    SHORT_TERM_BASENAME_RE.test(normalized) ||
    isGenericDailyHeadingForPromotion(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isGenericDailyHeadingForPromotion(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  const lower = normalized.toLowerCase();
  if (MANAGED_DREAMING_HEADINGS.has(lower)) {
    return true;
  }
  if (lower === "today" || lower === "yesterday" || lower === "tomorrow") {
    return true;
  }
  if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "night") {
    return true;
  }
  return GENERIC_DAY_HEADING_RE.test(normalized);
}

function buildRelocatedDailyHeadingLookup(lines: string[]): (string | null)[] {
  const headings: (string | null)[] = Array.from({ length: lines.length + 1 }, () => null);
  let currentHeading: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    headings[index + 1] = currentHeading;
    const line = lines[index] ?? "";
    if (DREAMING_FENCE_START_RE.test(line) || DREAMING_FENCE_END_RE.test(line)) {
      currentHeading = null;
      continue;
    }
    if (/^#{1,6}\s+.+$/.test(line.trim())) {
      currentHeading = normalizeDailyHeadingForPromotion(line);
    }
  }
  return headings;
}

function buildListMarkerFreeMatchSnippet(
  heading: string | null,
  listMarkerFreeSnippet: string,
): string {
  if (!listMarkerFreeSnippet) {
    return listMarkerFreeSnippet;
  }
  return heading ? normalizeSnippet(`${heading}: ${listMarkerFreeSnippet}`) : listMarkerFreeSnippet;
}

function targetSnippetHasHeadingContext(targetSnippet: string, bodySnippet: string): boolean {
  if (!targetSnippet || !bodySnippet || targetSnippet === bodySnippet) {
    return false;
  }
  const bodyIndex = targetSnippet.indexOf(bodySnippet);
  if (bodyIndex <= 0) {
    return false;
  }
  return targetSnippet.slice(0, bodyIndex).trimEnd().endsWith(":");
}

function extractTargetHeadingBodySnippet(
  targetSnippet: string,
  bodySnippet: string,
): string | null {
  if (!targetSnippet || !bodySnippet || targetSnippet === bodySnippet) {
    return null;
  }
  if (bodySnippet.startsWith(targetSnippet)) {
    return null;
  }
  const normalizedBody = normalizeSnippet(bodySnippet);
  for (let separatorIndex = targetSnippet.indexOf(": "); separatorIndex > 0;) {
    const targetBody = normalizeSnippet(targetSnippet.slice(separatorIndex + 2));
    if (targetBody && normalizedBody.startsWith(targetBody)) {
      return targetBody;
    }
    separatorIndex = targetSnippet.indexOf(": ", separatorIndex + 2);
  }
  return null;
}

function compareCandidateWindow(
  targetSnippet: string,
  windowSnippet: string,
): { matched: boolean; quality: number } {
  if (!targetSnippet || !windowSnippet) {
    return { matched: false, quality: 0 };
  }
  if (windowSnippet === targetSnippet) {
    return { matched: true, quality: 3 };
  }
  if (windowSnippet.includes(targetSnippet)) {
    return { matched: true, quality: 2 };
  }
  if (targetSnippet.includes(windowSnippet)) {
    return { matched: true, quality: 1 };
  }
  return { matched: false, quality: 0 };
}

function relocateCandidateRange(
  lines: string[],
  candidate: PromotionCandidate,
): { startLine: number; endLine: number; snippet: string } | null {
  const targetSnippet = normalizeSnippet(candidate.snippet);
  const preferredSpan = Math.max(1, candidate.endLine - candidate.startLine + 1);
  if (targetSnippet.length === 0) {
    const fallbackSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
    if (!fallbackSnippet) {
      return null;
    }
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: fallbackSnippet,
    };
  }

  const exactSnippet = normalizeRangeSnippet(lines, candidate.startLine, candidate.endLine);
  if (exactSnippet === targetSnippet) {
    return {
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      snippet: exactSnippet,
    };
  }

  const maxSpan = Math.min(lines.length, Math.max(preferredSpan + 3, 8));
  const headingLookup = buildRelocatedDailyHeadingLookup(lines);
  let bestMatch:
    | { startLine: number; endLine: number; snippet: string; quality: number; distance: number }
    | undefined;
  for (let startIndex = 0; startIndex < lines.length; startIndex += 1) {
    for (let span = 1; span <= maxSpan && startIndex + span <= lines.length; span += 1) {
      const startLine = startIndex + 1;
      const endLine = startIndex + span;
      const snippet = normalizeRangeSnippet(lines, startLine, endLine);
      const comparison = compareCandidateWindow(targetSnippet, snippet);
      const listMarkerFreeSnippet = normalizeListMarkerFreeRangeSnippet(lines, startLine, endLine);
      const listMarkerFreeMatchSnippet = buildListMarkerFreeMatchSnippet(
        headingLookup[startLine] ?? null,
        listMarkerFreeSnippet,
      );
      const listMarkerFreeComparison =
        listMarkerFreeSnippet === snippet
          ? { matched: false, quality: 0 }
          : compareCandidateWindow(targetSnippet, listMarkerFreeSnippet);
      const listMarkerFreeContextComparison =
        listMarkerFreeMatchSnippet === listMarkerFreeSnippet
          ? { matched: false, quality: 0 }
          : compareCandidateWindow(targetSnippet, listMarkerFreeMatchSnippet);
      const targetHeadingBodySnippet = extractTargetHeadingBodySnippet(
        targetSnippet,
        listMarkerFreeSnippet,
      );
      const targetHeadingBodyComparison =
        targetHeadingBodySnippet && listMarkerFreeMatchSnippet !== listMarkerFreeSnippet
          ? compareCandidateWindow(targetHeadingBodySnippet, listMarkerFreeSnippet)
          : { matched: false, quality: 0 };
      const useTargetHeadingBodyContext =
        targetHeadingBodyComparison.matched &&
        targetHeadingBodyComparison.quality >= comparison.quality &&
        targetHeadingBodyComparison.quality >= listMarkerFreeComparison.quality;
      const useListMarkerFreeContext =
        !useTargetHeadingBodyContext &&
        listMarkerFreeContextComparison.quality > comparison.quality &&
        listMarkerFreeContextComparison.quality >= listMarkerFreeComparison.quality;
      const useListMarkerFree =
        !useListMarkerFreeContext && listMarkerFreeComparison.quality > comparison.quality;
      const bestComparison = useTargetHeadingBodyContext
        ? targetHeadingBodyComparison
        : useListMarkerFreeContext
          ? listMarkerFreeContextComparison
          : useListMarkerFree
            ? listMarkerFreeComparison
            : comparison;
      if (!bestComparison.matched) {
        continue;
      }
      const matchedSnippet =
        useTargetHeadingBodyContext || useListMarkerFreeContext
          ? listMarkerFreeMatchSnippet
          : useListMarkerFree
            ? targetSnippetHasHeadingContext(targetSnippet, listMarkerFreeSnippet)
              ? listMarkerFreeMatchSnippet
              : listMarkerFreeSnippet
            : snippet;
      const distance = Math.abs(startLine - candidate.startLine);
      if (
        !bestMatch ||
        bestComparison.quality > bestMatch.quality ||
        (bestComparison.quality === bestMatch.quality && distance < bestMatch.distance) ||
        (bestComparison.quality === bestMatch.quality &&
          distance === bestMatch.distance &&
          Math.abs(span - preferredSpan) <
            Math.abs(bestMatch.endLine - bestMatch.startLine + 1 - preferredSpan))
      ) {
        bestMatch = {
          startLine,
          endLine,
          snippet: matchedSnippet,
          quality: bestComparison.quality,
          distance,
        };
      }
    }
  }

  if (!bestMatch) {
    return null;
  }
  return {
    startLine: bestMatch.startLine,
    endLine: bestMatch.endLine,
    snippet: bestMatch.snippet,
  };
}

const DREAMING_FENCE_START_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:start\s*-->/i;
const DREAMING_FENCE_END_RE = /<!--\s*openclaw:dreaming:[a-z][a-z0-9-]*:end\s*-->/i;

function lineRangeOverlapsDreamingFence(
  lines: string[],
  startLine: number,
  endLine: number,
): boolean {
  if (lines.length === 0) {
    return false;
  }
  const safeStart = Math.max(1, Math.min(startLine, lines.length));
  const safeEnd = Math.max(safeStart, Math.min(endLine, lines.length));
  let insideFence = false;
  for (let i = 0; i < safeEnd; i += 1) {
    const line = lines[i] ?? "";
    const oneIndexed = i + 1;
    const isStart = DREAMING_FENCE_START_RE.test(line);
    const isEnd = DREAMING_FENCE_END_RE.test(line);
    if (isStart || isEnd) {
      // The marker line itself is managed-block content. A relocated range
      // that includes a `<!-- openclaw:dreaming:*:start/end -->` marker would
      // build its snippet from raw lines that contain that marker text and
      // leak it into MEMORY.md alongside any adjacent fenced content captured
      // by the same window. (#80613)
      if (oneIndexed >= safeStart && oneIndexed <= safeEnd) {
        return true;
      }
      insideFence = isStart;
      continue;
    }
    if (insideFence && oneIndexed >= safeStart && oneIndexed <= safeEnd) {
      return true;
    }
  }
  return false;
}

async function rehydratePromotionCandidate(
  workspaceDir: string,
  candidate: PromotionCandidate,
): Promise<PromotionCandidate | null> {
  const sourcePaths = resolveShortTermSourcePathCandidates(workspaceDir, candidate.path);
  for (const sourcePath of sourcePaths) {
    let rawSource: string;
    try {
      rawSource = await fs.readFile(sourcePath, "utf-8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        continue;
      }
      throw err;
    }

    const lines = rawSource.split(/\r?\n/);
    const relocated = relocateCandidateRange(lines, candidate);
    if (!relocated) {
      continue;
    }
    // Managed dreaming blocks in daily memory files are scratchwork, not durable
    // content. If rehydration lands inside an openclaw:dreaming fence (for example
    // because file edits shifted lines between ranking and apply), refuse the
    // candidate so dream artifacts cannot be promoted into MEMORY.md.
    if (lineRangeOverlapsDreamingFence(lines, relocated.startLine, relocated.endLine)) {
      continue;
    }
    return {
      ...candidate,
      startLine: relocated.startLine,
      endLine: relocated.endLine,
      snippet: relocated.snippet,
    };
  }
  return null;
}

function buildPromotionSection(
  candidates: PromotionCandidate[],
  nowMs: number,
  timezone?: string,
  maxPromotedSnippetTokens = DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
): string {
  const sectionDate = formatMemoryDreamingDay(nowMs, timezone);
  const lines = ["", `## Promoted From Short-Term Memory (${sectionDate})`, ""];

  for (const candidate of candidates) {
    const source = `${candidate.path}:${candidate.startLine}-${candidate.endLine}`;
    const metadata = `[score=${candidate.score.toFixed(3)} signals=${candidate.signalCount} recalls=${candidate.recallCount} avg=${candidate.avgScore.toFixed(3)} source=${source}]`;
    lines.push(`<!-- ${PROMOTION_MARKER_PREFIX}${candidate.key} -->`);
    // Cap only the visible MEMORY.md text. The recall store keeps the full
    // rehydrated snippet so ranking, provenance, and dream narratives remain
    // tied to the source entry instead of this presentation budget.
    lines.push(
      `- ${formatPromotedSnippetForMemory(candidate.snippet, maxPromotedSnippetTokens)} ${metadata}`,
    );
  }

  lines.push("");
  return lines.join("\n");
}

function resolvePromotedSnippetCharLimit(maxTokens: number): number {
  const tokenLimit = toFiniteNonNegativeInt(
    maxTokens,
    DEFAULT_MEMORY_DEEP_DREAMING_MAX_PROMOTED_SNIPPET_TOKENS,
  );
  // This is an inexpensive display-size guard, not a tokenizer contract.
  return tokenLimit * PROMOTED_SNIPPET_CHARS_PER_TOKEN_ESTIMATE;
}

function truncatePromotedSnippet(snippet: string, maxTokens: number): string {
  const limit = resolvePromotedSnippetCharLimit(maxTokens);
  if (limit === 0 || snippet.length <= limit) {
    return snippet;
  }
  const hardLimit = truncateUtf16Safe(snippet, limit);
  const sentenceBoundary = Math.max(
    hardLimit.lastIndexOf(". "),
    hardLimit.lastIndexOf("! "),
    hardLimit.lastIndexOf("? "),
  );
  const wordBoundary = hardLimit.lastIndexOf(" ");
  const cutAt =
    sentenceBoundary >= Math.floor(limit * 0.55)
      ? sentenceBoundary + 1
      : wordBoundary >= Math.floor(limit * 0.65)
        ? wordBoundary
        : limit;
  return `${hardLimit.slice(0, cutAt).trimEnd()}...`;
}

function formatPromotedSnippetForMemory(rawSnippet: string, maxTokens: number): string {
  const normalized = normalizeSnippet(rawSnippet || "(no snippet captured)")
    .replace(/^[-*+] +/, "")
    .trim();
  return truncatePromotedSnippet(normalized || "(no snippet captured)", maxTokens);
}

function withTrailingNewline(content: string): string {
  if (!content) {
    return "";
  }
  return content.endsWith("\n") ? content : `${content}\n`;
}

function extractPromotionMarkers(memoryText: string): Set<string> {
  const markers = new Set<string>();
  // Marker keys include source paths, so spaces are valid. Capture until the
  // comment close; otherwise a path like "memory/project alpha/..." is missed
  // and the same candidate can be appended again.
  const matches = memoryText.matchAll(/<!--\s*openclaw-memory-promotion:([^\n]*?)\s*-->/gi);
  for (const match of matches) {
    const key = match[1]?.trim();
    if (key) {
      markers.add(key);
    }
  }
  return markers;
}

export async function applyShortTermPromotions(
  options: ApplyShortTermPromotionsOptions,
): Promise<ApplyShortTermPromotionsResult> {
  const workspaceDir = options.workspaceDir.trim();
  const nowMs = resolveMemoryCoreNowMs(options.nowMs);
  const nowIso = resolveMemoryCoreTimestamp(nowMs);
  const limit = Number.isFinite(options.limit)
    ? Math.max(0, Math.floor(options.limit as number))
    : options.candidates.length;
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
  const memoryPath = path.join(workspaceDir, "MEMORY.md");

  return await withShortTermLock(workspaceDir, async () => {
    const store = await readStore(workspaceDir, nowIso);
    const selected = options.candidates
      .filter((candidate) => {
        if (isContaminatedDreamingSnippet(candidate.snippet)) {
          return false;
        }
        if (candidate.promotedAt) {
          return false;
        }
        if (candidate.score < minScore) {
          return false;
        }
        if (candidate.signalCount < minRecallCount) {
          return false;
        }
        if (Math.max(candidate.uniqueQueries, candidate.recallDays.length) < minUniqueQueries) {
          return false;
        }
        if (maxAgeDays >= 0 && candidate.ageDays > maxAgeDays) {
          return false;
        }
        const latest = store.entries[candidate.key];
        if (latest?.promotedAt) {
          return false;
        }
        return true;
      })
      .slice(0, limit);

    const rehydratedSelected: PromotionCandidate[] = [];
    for (const candidate of selected) {
      const rehydrated = await rehydratePromotionCandidate(workspaceDir, candidate);
      if (rehydrated && !isContaminatedDreamingSnippet(rehydrated.snippet)) {
        rehydratedSelected.push(rehydrated);
      }
    }

    if (rehydratedSelected.length === 0) {
      return {
        memoryPath,
        applied: 0,
        appended: 0,
        reconciledExisting: 0,
        appliedCandidates: [],
        compactedSections: 0,
        compactedDates: [],
      };
    }

    const existingMemory = await fs.readFile(memoryPath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    const existingMarkers = extractPromotionMarkers(existingMemory);
    const alreadyWritten = rehydratedSelected.filter((candidate) =>
      existingMarkers.has(candidate.key),
    );
    const toAppend = rehydratedSelected.filter((candidate) => !existingMarkers.has(candidate.key));

    let compactedDates: string[] = [];
    if (toAppend.length > 0) {
      const section = buildPromotionSection(
        toAppend,
        nowMs,
        options.timezone,
        options.maxPromotedSnippetTokens,
      );
      const budgetChars =
        typeof options.memoryFileMaxChars === "number" &&
        Number.isFinite(options.memoryFileMaxChars)
          ? Math.max(0, Math.floor(options.memoryFileMaxChars))
          : DEFAULT_MEMORY_FILE_MAX_CHARS;
      const compaction = compactMemoryForBudget({
        existingMemory,
        newSection: section,
        budgetChars,
      });
      compactedDates = compaction.droppedDates;
      const baseMemory = compaction.compacted;
      const header = baseMemory.trim().length > 0 ? "" : "# Long-Term Memory\n\n";
      await fs.writeFile(
        memoryPath,
        `${header}${withTrailingNewline(baseMemory)}${section}`,
        "utf-8",
      );
    }

    for (const candidate of rehydratedSelected) {
      const entry = store.entries[candidate.key];
      if (!entry) {
        continue;
      }
      entry.startLine = candidate.startLine;
      entry.endLine = candidate.endLine;
      entry.snippet = candidate.snippet;
      entry.promotedAt = nowIso;
    }
    store.updatedAt = nowIso;
    await writeStore(workspaceDir, store);
    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.promotion.applied",
      timestamp: nowIso,
      memoryPath,
      applied: rehydratedSelected.length,
      candidates: rehydratedSelected.map((candidate) => ({
        key: candidate.key,
        path: candidate.path,
        startLine: candidate.startLine,
        endLine: candidate.endLine,
        score: candidate.score,
        recallCount: candidate.recallCount,
      })),
    });

    return {
      memoryPath,
      applied: rehydratedSelected.length,
      appended: toAppend.length,
      reconciledExisting: alreadyWritten.length,
      appliedCandidates: rehydratedSelected,
      compactedSections: compactedDates.length,
      compactedDates,
    };
  });
}

export function resolveShortTermRecallStorePath(workspaceDir: string): string {
  return resolveStorePath(workspaceDir);
}

export function resolveShortTermRecallLockPath(workspaceDir: string): string {
  return resolveLockPath(workspaceDir);
}

export async function auditShortTermPromotionArtifacts(params: {
  workspaceDir: string;
  qmd?: {
    dbPath?: string;
    collections?: number;
  };
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

  let qmd: ShortTermAuditSummary["qmd"];
  if (params.qmd) {
    qmd = {
      dbPath: params.qmd.dbPath,
      collections: params.qmd.collections,
    };
    if (typeof params.qmd.collections === "number" && params.qmd.collections <= 0) {
      issues.push({
        severity: "warn",
        code: "qmd-collections-empty",
        message: "QMD reports zero managed collections.",
        fixable: false,
      });
    }
    const dbPath = params.qmd.dbPath?.trim();
    if (dbPath) {
      try {
        const stat = await fs.stat(dbPath);
        qmd.dbBytes = stat.size;
        if (!stat.isFile() || stat.size <= 0) {
          issues.push({
            severity: "error",
            code: "qmd-index-empty",
            message: "QMD index file exists but is empty.",
            fixable: false,
          });
        }
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          issues.push({
            severity: "error",
            code: "qmd-index-missing",
            message: "QMD index file is missing.",
            fixable: false,
          });
        } else {
          throw err;
        }
      }
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
    issues,
    ...(qmd ? { qmd } : {}),
  };
}

export async function repairShortTermPromotionArtifacts(params: {
  workspaceDir: string;
}): Promise<RepairShortTermPromotionArtifactsResult> {
  const workspaceDir = params.workspaceDir.trim();
  const nowIso = new Date().toISOString();
  let rewroteStore = false;
  let removedInvalidEntries = 0;
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
      removedStaleLock = await lockStore.delete(lockKey);
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
      removedOverflowEntries = enforceShortTermRecallStoreRetention(comparableStore);
      const needsRewrite =
        removedInvalidEntries > 0 ||
        removedOverflowEntries > 0 ||
        JSON.stringify(normalized.entries) !== JSON.stringify(comparableStore.entries);
      if (needsRewrite) {
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

async function writeRawShortTermStoreForTest(
  workspaceDir: string,
  raw: unknown,
  namespace: string,
  metaKey: "recall" | "phase",
): Promise<void> {
  const record = asRecord(raw);
  const entries = asRecord(record?.entries);
  await Promise.all([
    writeMemoryCoreWorkspaceEntries({
      namespace,
      workspaceDir,
      entries: entries ? Object.entries(entries).map(([key, value]) => ({ key, value })) : [],
    }),
    writeMemoryCoreWorkspaceEntry({
      namespace: SHORT_TERM_META_NAMESPACE,
      workspaceDir,
      key: metaKey,
      value: {
        updatedAt:
          typeof record?.updatedAt === "string" && record.updatedAt.trim()
            ? record.updatedAt
            : new Date().toISOString(),
      },
    }),
  ]);
}

export const testing = {
  parseLockOwnerPid,
  isProcessLikelyAlive,
  readRecallStore: readStore,
  readPhaseSignalStore,
  writeRawRecallStore: (workspaceDir: string, raw: unknown) =>
    writeRawShortTermStoreForTest(workspaceDir, raw, SHORT_TERM_RECALL_NAMESPACE, "recall"),
  writeRawPhaseSignalStore: (workspaceDir: string, raw: unknown) =>
    writeRawShortTermStoreForTest(workspaceDir, raw, SHORT_TERM_PHASE_SIGNAL_NAMESPACE, "phase"),
  writeShortTermLock: async (workspaceDir: string, entry: ShortTermLockEntry) => {
    await openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    }).register(memoryCoreWorkspaceStateKey(workspaceDir), entry);
  },
  deleteShortTermLock: async (workspaceDir: string) => {
    await openMemoryCoreStateStore<ShortTermLockEntry>({
      namespace: SHORT_TERM_LOCK_NAMESPACE,
      maxEntries: SHORT_TERM_LOCK_MAX_ENTRIES,
    }).delete(memoryCoreWorkspaceStateKey(workspaceDir));
  },
  deriveConceptTags,
  calculateConsolidationComponent,
  calculatePhaseSignalBoost,
  compareShortTermRecallRetention,
  buildClaimHash,
  totalSignalCountForEntry,
  isContaminatedDreamingSnippet,
  lineRangeOverlapsDreamingFence,
  SHORT_TERM_RECALL_MAX_ENTRIES,
  SHORT_TERM_RECALL_MAX_SNIPPET_CHARS,
};
export { testing as __testing };
