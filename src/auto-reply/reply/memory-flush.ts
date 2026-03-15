import { lookupContextTokens } from "../../agents/context.js";
import { resolveCronStyleNow } from "../../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS } from "../../agents/defaults.js";
import { DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR } from "../../agents/pi-settings.js";
import { parseNonNegativeByteSize } from "../../config/byte-size.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveFreshSessionTotalTokens, type SessionEntry } from "../../config/sessions.js";
import { SILENT_REPLY_TOKEN } from "../tokens.js";

export const DEFAULT_MEMORY_FLUSH_SOFT_TOKENS = 4000;
export const DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES = 2 * 1024 * 1024;

const MEMORY_FLUSH_TARGET_HINT =
  "Store durable memories only in memory/YYYY-MM-DD.md (create memory/ if needed).";
const MEMORY_FLUSH_APPEND_ONLY_HINT =
  "If memory/YYYY-MM-DD.md already exists, APPEND new content only and do not overwrite existing entries.";
const MEMORY_FLUSH_READ_ONLY_HINT =
  "Treat workspace bootstrap/reference files such as MEMORY.md, SOUL.md, TOOLS.md, and AGENTS.md as read-only during this flush; never overwrite, replace, or edit them.";
const MEMORY_FLUSH_REQUIRED_HINTS = [
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
];

export const DEFAULT_MEMORY_FLUSH_PROMPT = [
  "Pre-compaction memory flush.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  "Do NOT create timestamped variant files (e.g., YYYY-MM-DD-HHMM.md); always use the canonical YYYY-MM-DD.md filename.",
  `If nothing to store, reply with ${SILENT_REPLY_TOKEN}.`,
].join(" ");

export const DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT = [
  "Pre-compaction memory flush turn.",
  "The session is near auto-compaction; capture durable memories to disk.",
  MEMORY_FLUSH_TARGET_HINT,
  MEMORY_FLUSH_READ_ONLY_HINT,
  MEMORY_FLUSH_APPEND_ONLY_HINT,
  `You may reply, but usually ${SILENT_REPLY_TOKEN} is correct.`,
].join(" ");

function formatDateStampInTimezone(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (year && month && day) {
    return `${year}-${month}-${day}`;
  }
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function resolveMemoryFlushRelativePathForRun(params: {
  cfg?: OpenClawConfig;
  nowMs?: number;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const { userTimezone } = resolveCronStyleNow(params.cfg ?? {}, nowMs);
  const dateStamp = formatDateStampInTimezone(nowMs, userTimezone);
  return `memory/${dateStamp}.md`;
}

export function resolveMemoryFlushPromptForRun(params: {
  prompt: string;
  cfg?: OpenClawConfig;
  nowMs?: number;
}): string {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const { timeLine } = resolveCronStyleNow(params.cfg ?? {}, nowMs);
  const dateStamp = resolveMemoryFlushRelativePathForRun({
    cfg: params.cfg,
    nowMs,
  })
    .replace(/^memory\//, "")
    .replace(/\.md$/, "");
  const withDate = params.prompt.replaceAll("YYYY-MM-DD", dateStamp).trimEnd();
  if (!withDate) {
    return timeLine;
  }
  if (withDate.includes("Current time:")) {
    return withDate;
  }
  return `${withDate}\n${timeLine}`;
}

export type MemoryFlushSettings = {
  enabled: boolean;
  softThresholdTokens: number;
  /**
   * Force a pre-compaction memory flush when the session transcript reaches this
   * size. Set to 0 to disable byte-size based triggering.
   */
  forceFlushTranscriptBytes: number;
  prompt: string;
  systemPrompt: string;
  reserveTokensFloor: number;
};

const normalizeNonNegativeInt = (value: unknown): number | null => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  const int = Math.floor(value);
  return int >= 0 ? int : null;
};

export function resolveMemoryFlushSettings(cfg?: OpenClawConfig): MemoryFlushSettings | null {
  const defaults = cfg?.agents?.defaults?.compaction?.memoryFlush;
  const enabled = defaults?.enabled ?? true;
  if (!enabled) {
    return null;
  }
  const softThresholdTokens =
    normalizeNonNegativeInt(defaults?.softThresholdTokens) ?? DEFAULT_MEMORY_FLUSH_SOFT_TOKENS;
  const forceFlushTranscriptBytes =
    parseNonNegativeByteSize(defaults?.forceFlushTranscriptBytes) ??
    DEFAULT_MEMORY_FLUSH_FORCE_TRANSCRIPT_BYTES;
  const prompt = ensureMemoryFlushSafetyHints(
    defaults?.prompt?.trim() || DEFAULT_MEMORY_FLUSH_PROMPT,
  );
  const systemPrompt = ensureMemoryFlushSafetyHints(
    defaults?.systemPrompt?.trim() || DEFAULT_MEMORY_FLUSH_SYSTEM_PROMPT,
  );
  const reserveTokensFloor =
    normalizeNonNegativeInt(cfg?.agents?.defaults?.compaction?.reserveTokensFloor) ??
    DEFAULT_PI_COMPACTION_RESERVE_TOKENS_FLOOR;

  return {
    enabled,
    softThresholdTokens,
    forceFlushTranscriptBytes,
    prompt: ensureNoReplyHint(prompt),
    systemPrompt: ensureNoReplyHint(systemPrompt),
    reserveTokensFloor,
  };
}

function ensureNoReplyHint(text: string): string {
  if (text.includes(SILENT_REPLY_TOKEN)) {
    return text;
  }
  return `${text}\n\nIf no user-visible reply is needed, start with ${SILENT_REPLY_TOKEN}.`;
}

function ensureMemoryFlushSafetyHints(text: string): string {
  let next = text.trim();
  for (const hint of MEMORY_FLUSH_REQUIRED_HINTS) {
    if (!next.includes(hint)) {
      next = next ? `${next}\n\n${hint}` : hint;
    }
  }
  return next;
}

export function resolveMemoryFlushContextWindowTokens(params: {
  modelId?: string;
  agentCfgContextTokens?: number;
}): number {
  return (
    lookupContextTokens(params.modelId) ?? params.agentCfgContextTokens ?? DEFAULT_CONTEXT_TOKENS
  );
}

export function shouldRunMemoryFlush(params: {
  entry?: Pick<
    SessionEntry,
    "totalTokens" | "totalTokensFresh" | "compactionCount" | "memoryFlushCompactionCount"
  >;
  /**
   * Optional token count override for flush gating. When provided, this value is
   * treated as a fresh context snapshot and used instead of the cached
   * SessionEntry.totalTokens (which may be stale/unknown).
   */
  tokenCount?: number;
  contextWindowTokens: number;
  reserveTokensFloor: number;
  softThresholdTokens: number;
}): boolean {
  if (!params.entry) {
    return false;
  }

  const override = params.tokenCount;
  const overrideTokens =
    typeof override === "number" && Number.isFinite(override) && override > 0
      ? Math.floor(override)
      : undefined;

  const totalTokens = overrideTokens ?? resolveFreshSessionTotalTokens(params.entry);
  if (!totalTokens || totalTokens <= 0) {
    return false;
  }
  const contextWindow = Math.max(1, Math.floor(params.contextWindowTokens));
  const reserveTokens = Math.max(0, Math.floor(params.reserveTokensFloor));
  const softThreshold = Math.max(0, Math.floor(params.softThresholdTokens));
  const threshold = Math.max(0, contextWindow - reserveTokens - softThreshold);
  if (threshold <= 0) {
    return false;
  }
  if (totalTokens < threshold) {
    return false;
  }

  if (hasAlreadyFlushedForCurrentCompaction(params.entry)) {
    return false;
  }

  return true;
}

/**
 * Returns true when a memory flush has already been performed for the current
 * compaction cycle. This prevents repeated flush runs within the same cycle —
 * important for both the token-based and transcript-size–based trigger paths.
 */
export function hasAlreadyFlushedForCurrentCompaction(
  entry: Pick<SessionEntry, "compactionCount" | "memoryFlushCompactionCount">,
): boolean {
  const compactionCount = entry.compactionCount ?? 0;
  const lastFlushAt = entry.memoryFlushCompactionCount;
  // If lastFlushAt is undefined, never flushed
  if (typeof lastFlushAt !== "number") {
    return false;
  }
  // If both are 0, this is the initial state (never flushed for real).
  // This handles the case where memoryFlushCompactionCount was set to 0
  // during the first flush but compactionCount hasn't changed yet.
  if (lastFlushAt === 0 && compactionCount === 0) {
    return false;
  }
  return lastFlushAt === compactionCount;
}
