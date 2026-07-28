import { createHash } from "node:crypto";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { deriveConceptTags, MAX_CONCEPT_TAGS } from "./concept-vocabulary.js";
import type {
  PromotionWeights,
  ShortTermRecallEntry,
  ShortTermRecallStore,
} from "./short-term-promotion-types.js";

const SHORT_TERM_PATH_RE = /(?:^|\/)memory\/(?:[^/]+\/)*(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
const DREAMING_MEMORY_PATH_RE = /(?:^|\/)memory\/dreaming\//;
const SHORT_TERM_SESSION_CORPUS_RE =
  /(?:^|\/)memory\/\.dreams\/session-corpus\/(\d{4})-(\d{2})-(\d{2})\.(?:md|txt)$/;
export const SHORT_TERM_BASENAME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-[^/]+)?\.md$/;
export const MAX_QUERY_HASHES = 32;
export const MAX_RECALL_DAYS = 16;
export const SHORT_TERM_RECALL_MAX_ENTRIES = 512;
const SHORT_TERM_RECALL_MAX_SNIPPET_CHARS = 800;
const DREAMING_TRANSCRIPT_PROMPT_LINE_RE =
  /\[[^\]]*dreaming-narrative[^\]]*]\s*(?:User|Assistant):\s*Write a dream diary entry from these memory fragments:?/i;
const RAW_SESSION_METADATA_RE =
  /\bSession Key\b.{0,260}\bSession ID\b|\bSession ID\b.{0,260}\bSession Key\b/i;
const RAW_CONVERSATION_SUMMARY_RE = /^(?:[-*+]\s*)?Conversation Summary:/i;
const RAW_TRANSCRIPT_TURN_RE = /^(?:[-*+]\s*)?(?:user|assistant):\s/i;
const MEMORY_FLUSH_PROMPT_RE =
  /Save important context from this session to the daily memory file\.\s*STRICT RULES:/i;
const PROMOTION_SCORE_METADATA_RE =
  /\[\s*score=\d+(?:\.\d+)?\s+(?:signals=\d+\s+)?recalls=\d+\s+avg=\d+(?:\.\d+)?\s+source=memory\//i;
const DREAMING_DIFF_PREFIX_RE = /@@\s*-\d+(?:,\d+)?\s+[-*+]\s+/iy;
const DEFAULT_PROMOTION_WEIGHTS: PromotionWeights = {
  frequency: 0.24,
  relevance: 0.3,
  diversity: 0.15,
  recency: 0.15,
  consolidation: 0.1,
  conceptual: 0.06,
};

export function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function toFiniteScore(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }
  if (num < 0 || num > 1) {
    return fallback;
  }
  return num;
}

export function normalizeSnippet(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replace(/\s+/g, " ");
}

export function truncateShortTermSnippet(snippet: string): string {
  if (snippet.length <= SHORT_TERM_RECALL_MAX_SNIPPET_CHARS) {
    return snippet;
  }
  return truncateUtf16Safe(snippet, SHORT_TERM_RECALL_MAX_SNIPPET_CHARS).trimEnd();
}

export function enforceShortTermRecallSnippetCap(store: ShortTermRecallStore): void {
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

export function isContaminatedDreamingSnippet(
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

export function normalizeMemoryPath(rawPath: string): string {
  return rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function buildClaimHash(snippet: string): string {
  return createHash("sha1").update(normalizeSnippet(snippet)).digest("hex").slice(0, 12);
}

export function buildEntryKey(result: {
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  claimHash?: string;
}): string {
  const base = `${result.source}:${normalizeMemoryPath(result.path)}:${result.startLine}:${result.endLine}`;
  return result.claimHash ? `${base}:${result.claimHash}` : base;
}

export function hashQuery(query: string): string {
  return createHash("sha1")
    .update(normalizeLowercaseStringOrEmpty(query))
    .digest("hex")
    .slice(0, 12);
}

export function mergeQueryHashes(existing: string[], queryHash: string): string[] {
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

export function mergeRecentDistinct(
  existing: string[],
  nextValue: string,
  limit: number,
): string[] {
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

export function normalizeIsoDay(isoLike: string): string | null {
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

export function totalSignalCountForEntry(entry: {
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

export function parseStoreTimestampMs(value: string | undefined): number {
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

export function enforceShortTermRecallStoreRetention(store: ShortTermRecallStore): number {
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

export function toFinitePositive(value: unknown, fallback: number): number {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) {
    return fallback;
  }
  return num;
}

export function toFiniteNonNegativeInt(value: unknown, fallback: number): number {
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

export function normalizeWeights(weights?: Partial<PromotionWeights>): PromotionWeights {
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

export function calculateRecencyComponent(ageDays: number, halfLifeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) {
    return 1;
  }
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return 1;
  }
  const lambda = Math.LN2 / halfLifeDays;
  return Math.exp(-lambda * ageDays);
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

export function isShortTermSessionCorpusPath(filePath: string): boolean {
  return SHORT_TERM_SESSION_CORPUS_RE.test(normalizeMemoryPath(filePath));
}

export function normalizeMemoryPathForWorkspace(workspaceDir: string, rawPath: string): string {
  const normalized = normalizeMemoryPath(rawPath);
  const workspaceNormalized = normalizeMemoryPath(workspaceDir);
  if (path.isAbsolute(rawPath) && normalized.startsWith(`${workspaceNormalized}/`)) {
    return normalized.slice(workspaceNormalized.length + 1);
  }
  return normalized;
}

export function toNonNegativeInt(value: unknown): number {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return 0;
  }
  return Math.max(0, Math.floor(num));
}

export function parseEntryRangeFromKey(
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
