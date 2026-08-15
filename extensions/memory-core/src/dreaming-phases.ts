// Memory Core plugin module implements dreaming phases behavior.
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { extractErrorCode } from "openclaw/plugin-sdk/error-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listSessionTranscriptCorpusEntriesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  formatMemoryDreamingDay,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeStringEntries, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { appendFailedDreamingEvent } from "./dreaming-events.js";
import {
  normalizeDailyIngestionState,
  normalizeMemoryDay,
  type DailyIngestionFileState,
  type DailyIngestionState,
} from "./dreaming-ingestion-state.js";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import {
  type DreamNarrativeRequest,
  type DreamNarrativeOutcome,
  readRecentDreamDiaryEntries,
  type NarrativePhaseData,
  runDreamNarrative,
} from "./dreaming-narrative.js";
import { formatErrorMessage } from "./dreaming-shared.js";
import {
  DREAMING_DAILY_INGESTION_NAMESPACE,
  DREAMING_DAILY_PROVENANCE_NAMESPACE,
  normalizeMemoryCoreWorkspaceKey,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { textSimilarity as snippetSimilarity } from "./memory/tokenize.js";
import {
  appendSessionCorpusLines,
  mergeTrackedMessageHashes,
  readSessionIngestionState,
  scanSessionIngestionSource,
  sessionIngestionSourceFromCorpus,
  sessionIngestionStateKeyFromCorpus,
  SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
  SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP,
  SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
  trimTrackedSessionScopes,
  writeSessionIngestionState,
  type SessionIngestionMessage,
  type SessionIngestionSource,
  type SessionIngestionState,
} from "./session-ingestion.js";
import { compareStoreTimestampDesc } from "./short-term-promotion-utils.js";
import {
  filterLiveShortTermRecallEntries,
  filterFreshLightDreamingEntries,
  readLightStagedKeys,
  readShortTermRecallEntries,
  recordDreamingPhaseSignals,
  recordRemConsideredPhaseSignals,
  recordShortTermRecalls,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;
type DreamingPhaseStorageConfig = {
  timezone?: string;
  storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
  execution?: { model?: string };
};
type LightDreamingConfig = DreamingPhaseStorageConfig & {
  enabled: boolean;
  lookbackDays: number;
  limit: number;
  dedupeSimilarity: number;
};
type RemDreamingConfig = DreamingPhaseStorageConfig & {
  enabled: boolean;
  lookbackDays: number;
  limit: number;
  minPatternStrength: number;
};
const DAILY_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})(?:-[^/]+)?\.md$/i;
const DAILY_INGESTION_SCORE = 0.62;
const DAILY_INGESTION_MAX_SNIPPET_CHARS = 280;
const DAILY_INGESTION_MIN_SNIPPET_CHARS = 8;
const DAILY_INGESTION_MAX_CHUNK_LINES = 4;
const SESSION_CHECKPOINT_TRANSCRIPT_FILENAME_RE = /\.checkpoint\..+\.jsonl$/i;
const LIGHT_DIARY_HISTORY_LIMIT = 4;
const LIGHT_DIARY_SNIPPET_SIMILARITY_THRESHOLD = 0.35;
const GENERIC_DAY_HEADING_RE =
  /^(?:(?:mon|monday|tue|tues|tuesday|wed|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday|sun|sunday)(?:,\s+)?)?(?:(?:jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?|\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?|\d{4}[/-]\d{2}[/-]\d{2})$/i;
const MANAGED_DAILY_DREAMING_BLOCKS = [
  {
    heading: "## Light Sleep",
    startMarker: "<!-- openclaw:dreaming:light:start -->",
    endMarker: "<!-- openclaw:dreaming:light:end -->",
  },
  {
    heading: "## REM Sleep",
    startMarker: "<!-- openclaw:dreaming:rem:start -->",
    endMarker: "<!-- openclaw:dreaming:rem:end -->",
  },
] as const;

function calculateLookbackCutoffMs(nowMs: number, lookbackDays: number): number {
  return nowMs - Math.max(0, lookbackDays) * 24 * 60 * 60 * 1000;
}

function isDayWithinLookback(day: string, cutoffMs: number): boolean {
  const dayMs = Date.parse(`${day}T23:59:59.999Z`);
  return Number.isFinite(dayMs) && dayMs >= cutoffMs;
}

function normalizeDailyListMarker(line: string): string {
  return line
    .replace(/^\d+\.\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .trim();
}

function normalizeDailyHeading(line: string): string | null {
  const trimmed = line.trim();
  const match = trimmed.match(/^#{1,6}\s+(.+)$/);
  if (!match) {
    return null;
  }
  const heading = match[1] ? normalizeDailyListMarker(match[1]) : "";
  if (!heading || DAILY_MEMORY_FILENAME_RE.test(heading) || isGenericDailyHeading(heading)) {
    return null;
  }
  return truncateUtf16Safe(heading, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}

function isGenericDailyHeading(heading: string): boolean {
  const normalized = heading.trim().replace(/\s+/g, " ");
  if (!normalized) {
    return true;
  }
  const lower = normalized.toLowerCase();
  if (lower === "today" || lower === "yesterday" || lower === "tomorrow") {
    return true;
  }
  if (lower === "morning" || lower === "afternoon" || lower === "evening" || lower === "night") {
    return true;
  }
  return GENERIC_DAY_HEADING_RE.test(normalized);
}

function normalizeDailySnippet(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("<!--")) {
    return null;
  }
  const withoutListMarker = normalizeDailyListMarker(trimmed);
  if (withoutListMarker.length < DAILY_INGESTION_MIN_SNIPPET_CHARS) {
    return null;
  }
  return truncateUtf16Safe(withoutListMarker, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(
    /\s+/g,
    " ",
  );
}

type DailySnippetChunk = {
  startLine: number;
  endLine: number;
  snippet: string;
  identitySnippet?: string;
};

const REM_REFLECTION_TAG_BLACKLIST = new Set(["assistant", "user", "system", "subagent", "the"]);

function buildDailyChunkSnippet(heading: string | null, chunkLines: string[]): string {
  const body = chunkLines.join(" ").trim();
  const prefixed = heading ? `${heading}: ${body}` : body;
  return truncateUtf16Safe(prefixed, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
}

function buildDailyListSnippet(
  heading: string | null,
  ancestors: string[],
  snippet: string,
): string {
  const body = [...ancestors, snippet].join(" > ").replaceAll(": > ", ": ");
  return buildDailyChunkSnippet(heading, [body]);
}

function buildDailySnippetChunks(lines: string[], limit: number): DailySnippetChunk[] {
  const chunks: DailySnippetChunk[] = [];
  let activeHeading: string | null = null;
  let chunkLines: string[] = [];
  let chunkStartLine = 0;
  let chunkEndLine = 0;
  let listAncestors: Array<{ indent: number; text: string }> = [];

  const flushChunk = () => {
    if (chunkLines.length === 0) {
      chunkStartLine = 0;
      chunkEndLine = 0;
      return;
    }

    const snippet = buildDailyChunkSnippet(activeHeading, chunkLines);
    if (snippet.length >= DAILY_INGESTION_MIN_SNIPPET_CHARS) {
      chunks.push({
        startLine: chunkStartLine,
        endLine: chunkEndLine,
        snippet,
      });
    }

    chunkLines = [];
    chunkStartLine = 0;
    chunkEndLine = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (typeof line !== "string") {
      continue;
    }

    const heading = normalizeDailyHeading(line);
    if (heading) {
      flushChunk();
      activeHeading = heading;
      listAncestors = [];
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--")) {
      flushChunk();
      listAncestors = [];
      continue;
    }

    const listMatch = line.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/);
    if (listMatch) {
      flushChunk();
      const indent = listMatch[1]?.length ?? 0;
      const listText = truncateUtf16Safe(
        normalizeDailyListMarker(trimmed),
        DAILY_INGESTION_MAX_SNIPPET_CHARS,
      ).replace(/\s+/g, " ");
      if (!listText) {
        listAncestors = [];
        continue;
      }
      while ((listAncestors.at(-1)?.indent ?? -1) >= indent) {
        listAncestors.pop();
      }
      const continuationLines: string[] = [];
      let endIndex = index;
      let hasNestedChild = false;
      let nestedChildIndex: number | undefined;
      for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
        const nextLine = lines[cursor];
        if (typeof nextLine !== "string") {
          break;
        }
        const nextTrimmed = nextLine.trim();
        if (!nextTrimmed) {
          let nextContentIndex = cursor + 1;
          while (nextContentIndex < lines.length && !lines[nextContentIndex]?.trim()) {
            nextContentIndex += 1;
          }
          const nextContentLine = lines[nextContentIndex];
          const looseChildMatch = nextContentLine?.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/);
          if (looseChildMatch && (looseChildMatch[1]?.length ?? 0) > indent) {
            hasNestedChild = true;
            nestedChildIndex = nextContentIndex;
          }
          break;
        }
        if (nextTrimmed.startsWith("#") || nextTrimmed.startsWith("<!--")) {
          break;
        }
        const nextListMatch = nextLine.match(/^(\s*)(?:[-*+]|\d+\.)\s+(.+)$/);
        if (nextListMatch) {
          hasNestedChild = (nextListMatch[1]?.length ?? 0) > indent;
          break;
        }
        continuationLines.push(nextTrimmed.replace(/\s+/g, " "));
        endIndex = cursor;
      }
      const claimBody = [listText, ...continuationLines].join(" ");
      const contextualSnippet = buildDailyListSnippet(
        activeHeading,
        listAncestors.map((ancestor) => ancestor.text),
        claimBody,
      );
      const isContainerOnly =
        hasNestedChild && continuationLines.length === 0 && listText.endsWith(":");
      if (!isContainerOnly && contextualSnippet.length >= DAILY_INGESTION_MIN_SNIPPET_CHARS) {
        chunks.push({
          startLine: index + 1,
          endLine: endIndex + 1,
          snippet: contextualSnippet,
          // The rendered semantic context is part of claim identity, keeping
          // identical bullet text for different subjects or events separate.
          identitySnippet: contextualSnippet,
        });
      }
      listAncestors.push({ indent, text: claimBody });
      index = nestedChildIndex === undefined ? endIndex : nestedChildIndex - 1;
      if (chunks.length >= limit) {
        break;
      }
      continue;
    }

    listAncestors = [];
    const snippet = normalizeDailySnippet(line);
    if (!snippet) {
      flushChunk();
      continue;
    }
    const nextChunkLines = chunkLines.length === 0 ? [snippet] : [...chunkLines, snippet];
    const candidateSnippet = buildDailyChunkSnippet(activeHeading, nextChunkLines);
    const shouldSplit =
      chunkLines.length > 0 &&
      (chunkLines.length >= DAILY_INGESTION_MAX_CHUNK_LINES ||
        candidateSnippet.length > DAILY_INGESTION_MAX_SNIPPET_CHARS);

    if (shouldSplit) {
      flushChunk();
    }

    if (chunkLines.length === 0) {
      chunkStartLine = index + 1;
    }
    chunkLines.push(snippet);
    chunkEndLine = index + 1;

    if (chunks.length >= limit) {
      break;
    }
  }

  flushChunk();
  return chunks.slice(0, limit);
}

function resolveDailyFileProvenance(params: {
  currentHash: string;
  defaultObservedAt: number;
  recorded?: { fileHash: string; originClass: "agent" | "untrusted"; observedAt: number };
}): { originClass: "agent" | "untrusted"; observedAt: number } {
  // Untracked workspace notes are operator-trusted; filesystem writers already
  // own the host, while explicit flush quarantine stays sticky across edits.
  if (params.recorded?.originClass === "untrusted") {
    return { originClass: "untrusted", observedAt: params.recorded.observedAt };
  }
  if (params.recorded?.fileHash === params.currentHash) {
    return { originClass: params.recorded.originClass, observedAt: params.recorded.observedAt };
  }
  return { originClass: "agent", observedAt: params.defaultObservedAt };
}

function findManagedDailyDreamingHeadingIndex(
  lines: string[],
  startIndex: number,
  heading: string,
): number | null {
  for (let index = startIndex - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]?.trim() ?? "";
    if (!trimmed) {
      continue;
    }
    return trimmed === heading ? index : null;
  }
  return null;
}

function isManagedDailyDreamingBoundary(
  line: string,
  blockByStartMarker: ReadonlyMap<string, (typeof MANAGED_DAILY_DREAMING_BLOCKS)[number]>,
): boolean {
  const trimmed = line.trim();
  return /^#{1,6}\s+/.test(trimmed) || blockByStartMarker.has(trimmed);
}

function stripManagedDailyDreamingLines(lines: string[]): string[] {
  const blockByStartMarker: ReadonlyMap<string, (typeof MANAGED_DAILY_DREAMING_BLOCKS)[number]> =
    new Map(MANAGED_DAILY_DREAMING_BLOCKS.map((block) => [block.startMarker, block]));
  const sanitized = [...lines];
  for (let index = 0; index < sanitized.length; index += 1) {
    const block = blockByStartMarker.get(sanitized[index]?.trim() ?? "");
    if (!block) {
      continue;
    }

    let stripUntilIndex = -1;
    for (let cursor = index + 1; cursor < sanitized.length; cursor += 1) {
      const line = sanitized[cursor];
      const trimmed = line?.trim() ?? "";
      if (trimmed === block.endMarker) {
        stripUntilIndex = cursor;
        break;
      }
      if (line && isManagedDailyDreamingBoundary(line, blockByStartMarker)) {
        stripUntilIndex = cursor - 1;
        break;
      }
    }
    if (stripUntilIndex < index) {
      continue;
    }

    const headingIndex = findManagedDailyDreamingHeadingIndex(lines, index, block.heading);
    const startIndex = headingIndex ?? index;
    for (let cursor = startIndex; cursor <= stripUntilIndex; cursor += 1) {
      sanitized[cursor] = "";
    }
    index = stripUntilIndex;
  }

  return sanitized;
}

function buildDailyIngestionResults(params: {
  raw: string;
  path: string;
  limit: number;
  defaultObservedAt: number;
  recorded?: { fileHash: string; originClass: "agent" | "untrusted"; observedAt: number };
}): Array<MemorySearchResult & { identitySnippet?: string }> {
  const provenance = resolveDailyFileProvenance({
    currentHash: createHash("sha256").update(params.raw).digest("hex"),
    defaultObservedAt: params.defaultObservedAt,
    ...(params.recorded ? { recorded: params.recorded } : {}),
  });
  return buildDailySnippetChunks(
    stripManagedDailyDreamingLines(params.raw.split(/\r?\n/)),
    params.limit,
  ).map((chunk) =>
    Object.assign(
      {
        path: params.path,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: DAILY_INGESTION_SCORE,
        snippet: chunk.snippet,
        source: "memory" as const,
        provenance: { ...provenance, sessionKind: "unknown" as const },
      },
      chunk.identitySnippet ? { identitySnippet: chunk.identitySnippet } : {},
    ),
  );
}

function entryWithinLookback(entry: ShortTermRecallEntry, cutoffMs: number): boolean {
  const byDay = (entry.recallDays ?? []).some((day) => isDayWithinLookback(day, cutoffMs));
  if (byDay) {
    return true;
  }
  const isDailyOnly =
    Math.max(0, Math.floor(entry.dailyCount ?? 0)) > 0 &&
    Math.max(0, Math.floor(entry.recallCount ?? 0)) === 0 &&
    Math.max(0, Math.floor(entry.groundedCount ?? 0)) === 0;
  if (isDailyOnly) {
    // The 14-day ingestion horizon gathers recurrence evidence; light/REM keep
    // their own shorter freshness window by evaluating daily file days only.
    // Claim keys are daily-only by contract; recall/grounded writers retain
    // path-qualified keys and cannot merge into this aggregate.
    return false;
  }
  const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
  return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs >= cutoffMs;
}

// Public lookback filter for recall entries. Kept in memory-core so gateway
// doctor harness, CLI harness, and internal REM/light dreaming paths all
// resolve `recallDays` vs `lastRecalledAt` the same way and cannot drift.
export function filterRecallEntriesWithinLookback(params: {
  entries: readonly ShortTermRecallEntry[];
  nowMs: number;
  lookbackDays: number;
}): ShortTermRecallEntry[] {
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  return params.entries.filter((entry) => entryWithinLookback(entry, cutoffMs));
}

type DailyIngestionBatch = {
  day: string;
  results: Array<MemorySearchResult & { identitySnippet?: string }>;
};

type DailyMemoryFile = {
  fileName: string;
  day: string;
  canonical: boolean;
};

function parseDailyMemoryFileName(fileName: string): DailyMemoryFile | null {
  const match = fileName.match(DAILY_MEMORY_FILENAME_RE);
  const day = match?.[1];
  return day
    ? {
        fileName,
        day,
        canonical: fileName.toLowerCase() === `${day}.md`,
      }
    : null;
}

function compareDailyMemoryFilesByNewestDay(left: DailyMemoryFile, right: DailyMemoryFile): number {
  const dayOrder = right.day.localeCompare(left.day);
  if (dayOrder !== 0) {
    return dayOrder;
  }
  if (left.canonical !== right.canonical) {
    return left.canonical ? -1 : 1;
  }
  return left.fileName.localeCompare(right.fileName);
}

function resolveWorkspaceMemoryRelativePath(workspaceDir: string, filePath: string): string {
  const relativePath = path.relative(workspaceDir, filePath).replace(/\\/g, "/");
  if (relativePath && relativePath !== ".." && !relativePath.startsWith("../")) {
    return relativePath;
  }
  return `memory/${path.basename(filePath)}`;
}

async function readDailyIngestionState(workspaceDir: string): Promise<DailyIngestionState> {
  const entries = await readMemoryCoreWorkspaceEntries<DailyIngestionFileState>({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir,
  });
  return normalizeDailyIngestionState({
    version: 1,
    files: Object.fromEntries(entries.map((entry) => [entry.key, entry.value])),
  });
}

async function writeDailyIngestionState(
  workspaceDir: string,
  state: DailyIngestionState,
): Promise<void> {
  await writeMemoryCoreWorkspaceEntries({
    namespace: DREAMING_DAILY_INGESTION_NAMESPACE,
    workspaceDir,
    entries: Object.entries(state.files).map(([key, value]) => ({ key, value })),
  });
}

function isCheckpointSessionTranscriptPath(absolutePath: string): boolean {
  return SESSION_CHECKPOINT_TRANSCRIPT_FILENAME_RE.test(path.basename(absolutePath));
}

function resolveSessionAgentsForWorkspace(params: {
  cfg: OpenClawConfig;
  workspaceDir: string;
  primaryWorkspaceDir?: string;
}): string[] {
  const { cfg, workspaceDir, primaryWorkspaceDir } = params;
  const target = normalizeMemoryCoreWorkspaceKey(workspaceDir);
  const workspaces = resolveMemoryDreamingWorkspaces(cfg, {
    primaryWorkspaceDir,
    primaryAgentId: "main",
  });
  const match = workspaces.find(
    (entry) => normalizeMemoryCoreWorkspaceKey(entry.workspaceDir) === target,
  );
  if (!match) {
    return [];
  }
  return uniqueStrings(match.agentIds.filter((agentId) => agentId.trim().length > 0)).toSorted();
}

async function collectSessionIngestionBatches(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  primaryWorkspaceDir?: string;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
  state: SessionIngestionState;
}) {
  if (!params.cfg) {
    const nextState = { version: 3 as const, files: {}, seenMessages: {} };
    return {
      batches: [],
      nextState,
      changed: JSON.stringify(nextState) !== JSON.stringify(params.state),
    };
  }
  const agentIds = resolveSessionAgentsForWorkspace({
    cfg: params.cfg,
    workspaceDir: params.workspaceDir,
    primaryWorkspaceDir: params.primaryWorkspaceDir,
  });
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  const batchByDay = new Map<string, SessionIngestionMessage[]>();
  // A bounded sweep must retain checkpoints for sources it never reaches.
  // Only a source that was discovered and then proved absent may be removed.
  const nextFiles = { ...params.state.files };
  const nextSeenMessages: Record<string, string[]> = { ...params.state.seenMessages };
  const sources: SessionIngestionSource[] = [];
  for (const agentId of agentIds) {
    const knownStateKeys = new Set<string>();
    for (const entry of await listSessionTranscriptCorpusEntriesForAgent(agentId, {
      includeRetainedSqlite: true,
    })) {
      knownStateKeys.add(sessionIngestionStateKeyFromCorpus(entry));
      const source = sessionIngestionSourceFromCorpus(entry);
      if (!source) {
        continue;
      }
      if (
        // Dreaming learns only from the live corpus. Retained reset/delete
        // archives stay in the shared corpus for memory_search.
        entry.artifactKind !== "active-session" ||
        isCheckpointSessionTranscriptPath(entry.sessionFile)
      ) {
        continue;
      }
      sources.push(source);
    }
    // Complete corpus enumeration proves which owned checkpoints are stale;
    // foreign backfill checkpoints belong to a separate lifecycle.
    for (const stateKey of Object.keys(nextFiles)) {
      if (stateKey.startsWith(`${agentId}:`) && !knownStateKeys.has(stateKey)) {
        delete nextFiles[stateKey];
      }
    }
  }
  const sortedSources = sources.toSorted((a, b) => {
    if (a.agentId !== b.agentId) {
      return a.agentId.localeCompare(b.agentId);
    }
    return a.sessionPath.localeCompare(b.sessionPath);
  });

  const totalCap = SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP;
  let remaining = totalCap;
  const perFileCap = Math.min(
    SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
    Math.max(
      SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
      Math.ceil(totalCap / Math.max(1, sortedSources.length)),
    ),
  );
  for (const source of sortedSources) {
    if (remaining <= 0) {
      break;
    }
    const fileCap = Math.max(1, Math.min(perFileCap, remaining));
    const scan = await scanSessionIngestionSource({
      source,
      previous: params.state.files[source.stateKey],
      seenMessages: nextSeenMessages,
      timezone: params.timezone,
      maxCandidates: fileCap,
      classifyDay: (day) => (isDayWithinLookback(day, cutoffMs) ? "include" : "skip"),
    });
    if (scan.status === "absent") {
      delete nextFiles[source.stateKey];
      continue;
    }
    if (scan.fileState) {
      nextFiles[source.stateKey] = scan.fileState;
    }
    if (scan.status !== "scanned") {
      continue;
    }
    for (const candidate of scan.candidates) {
      const bucket = batchByDay.get(candidate.day) ?? [];
      bucket.push(candidate);
      batchByDay.set(candidate.day, bucket);
    }
    if (scan.candidates.length > 0) {
      const previousSeen = nextSeenMessages[source.scope] ?? [];
      nextSeenMessages[source.scope] = mergeTrackedMessageHashes(
        previousSeen,
        scan.candidates.map((candidate) => candidate.hash),
      );
      remaining -= scan.candidates.length;
    }
  }
  const trimmedSeenMessages = trimTrackedSessionScopes(nextSeenMessages);
  const batches: DailyIngestionBatch[] = [];
  for (const day of [...batchByDay.keys()].toSorted()) {
    const lines = batchByDay.get(day) ?? [];
    if (lines.length === 0) {
      continue;
    }
    const results = await appendSessionCorpusLines({
      workspaceDir: params.workspaceDir,
      day,
      lines,
    });
    if (results.length > 0) {
      batches.push({ day, results });
    }
  }

  const nextState = { version: 3 as const, files: nextFiles, seenMessages: trimmedSeenMessages };
  return {
    batches,
    nextState,
    changed: JSON.stringify(nextState) !== JSON.stringify(params.state),
  };
}

async function ingestSessionTranscriptSignals(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  primaryWorkspaceDir?: string;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
}): Promise<void> {
  const state = await readSessionIngestionState(params.workspaceDir);
  const collected = await collectSessionIngestionBatches({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    primaryWorkspaceDir: params.primaryWorkspaceDir,
    lookbackDays: params.lookbackDays,
    nowMs: params.nowMs,
    timezone: params.timezone,
    state,
  });
  const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_sessions__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: ingestionDayBucket,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
  }
  if (collected.changed) {
    await writeSessionIngestionState(params.workspaceDir, collected.nextState);
  }
}

type DailyIngestionCollectionResult = {
  batches: DailyIngestionBatch[];
  nextState: DailyIngestionState;
  changed: boolean;
};

const DEFAULT_DAILY_INGESTION_LOOKBACK_DAYS = 14;

function dailyIngestionLookbackDays(phaseLookbackDays: number): number {
  // Three-day recurrence gates need enough daily-note history to observe a
  // repeated claim even when light/REM intentionally use shorter phase windows.
  return Math.max(DEFAULT_DAILY_INGESTION_LOOKBACK_DAYS, phaseLookbackDays);
}

async function collectDailyIngestionBatches(params: {
  workspaceDir: string;
  lookbackDays: number;
  limit: number;
  nowMs: number;
  ingestionDreamingDay: string;
  state: DailyIngestionState;
}): Promise<DailyIngestionCollectionResult> {
  const provenanceEntries = await readMemoryCoreWorkspaceEntries<{
    fileHash: string;
    originClass: "agent" | "untrusted";
    observedAt: number;
  }>({ namespace: DREAMING_DAILY_PROVENANCE_NAMESPACE, workspaceDir: params.workspaceDir });
  const provenanceByPath = new Map(provenanceEntries.map((entry) => [entry.key, entry.value]));
  const memoryDir = path.join(params.workspaceDir, "memory");
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch((err: unknown) => {
    if (extractErrorCode(err) === "ENOENT") {
      return [] as Dirent[];
    }
    throw err;
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = parseDailyMemoryFileName(entry.name);
      if (!file) {
        return null;
      }
      if (!isDayWithinLookback(file.day, cutoffMs)) {
        return null;
      }
      return file;
    })
    .filter((entry): entry is DailyMemoryFile => entry !== null)
    .toSorted(compareDailyMemoryFilesByNewestDay);

  const batches: DailyIngestionBatch[] = [];
  const nextFiles: Record<string, DailyIngestionFileState> = {};
  let changed = false;
  const totalCap = Math.max(20, params.limit * 4);
  const perFileCap = Math.max(6, Math.ceil(totalCap / Math.max(1, Math.max(files.length, 1))));
  let total = 0;
  for (const file of files) {
    const relativePath = `memory/${file.fileName}`;
    const filePath = path.join(memoryDir, file.fileName);
    const stat = await fs.stat(filePath).catch((err: unknown) => {
      if (extractErrorCode(err) === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!stat) {
      continue;
    }
    const fingerprint: DailyIngestionFileState = {
      mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)),
      size: Math.floor(Math.max(0, stat.size)),
    };
    nextFiles[relativePath] = fingerprint;
    const previous = params.state.files[relativePath];
    const unchanged =
      previous !== undefined &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size;
    const previousDreamingDay = normalizeMemoryDay(previous?.lastDreamingDayIngested);
    if (unchanged && previousDreamingDay === params.ingestionDreamingDay) {
      nextFiles[relativePath] = {
        ...fingerprint,
        lastDreamingDayIngested: previousDreamingDay,
      };
      continue;
    }
    changed = true;

    const raw = await fs.readFile(filePath, "utf-8").catch((err: unknown) => {
      if (extractErrorCode(err) === "ENOENT") {
        return "";
      }
      throw err;
    });
    if (!raw) {
      continue;
    }
    const recordedProvenance = provenanceByPath.get(relativePath);
    // Workspace daily notes are owner-controlled and default to 'agent' (hand
    // edits, imports, and pre-existing notes must stay promotable), except a
    // file the flush explicitly quarantined remains untrusted across edits.
    const results = buildDailyIngestionResults({
      raw,
      path: relativePath,
      limit: Math.min(perFileCap, totalCap - total),
      defaultObservedAt: fingerprint.mtimeMs,
      ...(recordedProvenance ? { recorded: recordedProvenance } : {}),
    });
    if (results.length === 0) {
      continue;
    }
    batches.push({ day: file.day, results });
    total += results.length;
    nextFiles[relativePath] = {
      ...fingerprint,
      lastDreamingDayIngested: params.ingestionDreamingDay,
    };
    if (total >= totalCap) {
      break;
    }
  }

  if (!changed) {
    const previousKeys = Object.keys(params.state.files);
    const nextKeys = Object.keys(nextFiles);
    if (
      previousKeys.length !== nextKeys.length ||
      previousKeys.some((key) => !Object.hasOwn(nextFiles, key))
    ) {
      changed = true;
    }
  }

  return {
    batches,
    nextState: {
      version: 1,
      files: nextFiles,
    },
    changed,
  };
}

async function ingestDailyMemorySignals(params: {
  workspaceDir: string;
  lookbackDays: number;
  limit: number;
  nowMs: number;
  timezone?: string;
}): Promise<void> {
  const state = await readDailyIngestionState(params.workspaceDir);
  const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
  const collected = await collectDailyIngestionBatches({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.lookbackDays,
    limit: params.limit,
    nowMs: params.nowMs,
    ingestionDreamingDay: ingestionDayBucket,
    state,
  });
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      // The ingestion checkpoint already prevents duplicate unchanged files.
      // File days remain the recurrence buckets; later changed-file ingestions
      // still add a signal instead of being mistaken for the original pass.
      dedupeByQueryPerDay: false,
      dayBucket: batch.day,
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
  }
  if (collected.changed) {
    await writeDailyIngestionState(params.workspaceDir, collected.nextState);
  }
}

export async function seedHistoricalDailyMemorySignals(params: {
  workspaceDir: string;
  filePaths: string[];
  limit: number;
  nowMs: number;
  timezone?: string;
}): Promise<{
  importedFileCount: number;
  importedSignalCount: number;
  skippedPaths: string[];
}> {
  const normalizedPaths = uniqueStrings(normalizeStringEntries(params.filePaths));
  if (normalizedPaths.length === 0) {
    return {
      importedFileCount: 0,
      importedSignalCount: 0,
      skippedPaths: [],
    };
  }
  const provenanceEntries = await readMemoryCoreWorkspaceEntries<{
    fileHash: string;
    originClass: "agent" | "untrusted";
    observedAt: number;
  }>({ namespace: DREAMING_DAILY_PROVENANCE_NAMESPACE, workspaceDir: params.workspaceDir });
  const provenanceByPath = new Map(provenanceEntries.map((entry) => [entry.key, entry.value]));

  const resolved = normalizedPaths
    .map((filePath) => {
      const fileName = path.basename(filePath);
      const file = parseDailyMemoryFileName(fileName);
      if (!file) {
        return { filePath, fileName, relativePath: "", file: null as DailyMemoryFile | null };
      }
      return {
        filePath,
        fileName,
        relativePath: resolveWorkspaceMemoryRelativePath(params.workspaceDir, filePath),
        file,
      };
    })
    .toSorted((a, b) => {
      if (a.file && b.file) {
        return compareDailyMemoryFilesByNewestDay(a.file, b.file);
      }
      if (a.file) {
        return -1;
      }
      if (b.file) {
        return 1;
      }
      return a.filePath.localeCompare(b.filePath);
    });

  const valid = resolved.filter(
    (
      entry,
    ): entry is {
      filePath: string;
      fileName: string;
      relativePath: string;
      file: DailyMemoryFile;
    } => Boolean(entry.file),
  );
  const skippedPaths = resolved.filter((entry) => !entry.file).map((entry) => entry.filePath);
  const totalCap = Math.max(20, params.limit * 4);
  const perFileCap = Math.max(6, Math.ceil(totalCap / Math.max(1, valid.length)));
  let importedSignalCount = 0;
  let importedFileCount = 0;

  for (const entry of valid) {
    if (importedSignalCount >= totalCap) {
      break;
    }
    const raw = await fs.readFile(entry.filePath, "utf-8").catch((err: unknown) => {
      if (extractErrorCode(err) === "ENOENT") {
        skippedPaths.push(entry.filePath);
        return "";
      }
      throw err;
    });
    if (!raw) {
      continue;
    }
    const recordedProvenance = provenanceByPath.get(entry.relativePath);
    // Same owner-controlled default as live daily ingestion above: workspace
    // notes are 'agent' unless the flush explicitly recorded a downgrade.
    const results = buildDailyIngestionResults({
      raw,
      path: entry.relativePath,
      limit: Math.min(perFileCap, totalCap - importedSignalCount),
      defaultObservedAt: params.nowMs,
      ...(recordedProvenance ? { recorded: recordedProvenance } : {}),
    });
    if (results.length === 0) {
      continue;
    }
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${entry.file.day}`,
      results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: formatMemoryDreamingDay(params.nowMs, params.timezone),
      nowMs: params.nowMs,
      timezone: params.timezone,
    });
    importedSignalCount += results.length;
    importedFileCount += 1;
  }

  return {
    importedFileCount,
    importedSignalCount,
    skippedPaths,
  };
}

function entryAverageScore(entry: ShortTermRecallEntry): number {
  const signalCount = Math.max(
    0,
    Math.floor(entry.recallCount ?? 0) +
      Math.floor(entry.dailyCount ?? 0) +
      Math.floor(entry.groundedCount ?? 0),
  );
  return signalCount > 0 ? Math.max(0, Math.min(1, entry.totalScore / signalCount)) : 0;
}

// Use the shared CJK-aware similarity helper so close-but-not-identical CJK
// snippets do not slip past the dedupe threshold via the old ASCII-only path.
function dedupeEntries(entries: ShortTermRecallEntry[], threshold: number): ShortTermRecallEntry[] {
  const deduped: ShortTermRecallEntry[] = [];
  for (const entry of entries) {
    const duplicate = deduped.find(
      (candidate) =>
        candidate.path === entry.path &&
        snippetSimilarity(candidate.snippet, entry.snippet) >= threshold,
    );
    if (duplicate) {
      if (entry.recallCount > duplicate.recallCount) {
        duplicate.recallCount = entry.recallCount;
      }
      duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
      duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
      duplicate.queryHashes = uniqueStrings([...duplicate.queryHashes, ...entry.queryHashes]);
      duplicate.recallDays = [
        ...new Set([...duplicate.recallDays, ...entry.recallDays]),
      ].toSorted();
      duplicate.conceptTags = uniqueStrings([...duplicate.conceptTags, ...entry.conceptTags]);
      duplicate.lastRecalledAt =
        compareStoreTimestampDesc(entry.lastRecalledAt, duplicate.lastRecalledAt) < 0
          ? entry.lastRecalledAt
          : duplicate.lastRecalledAt;
      continue;
    }
    deduped.push({ ...entry });
  }
  return deduped;
}

function normalizeDiaryCoverageText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function isEntryCoveredByRecentDiary(
  entry: ShortTermRecallEntry,
  recentDiaryEntries: readonly string[],
): boolean {
  const snippet = normalizeDiaryCoverageText(entry.snippet);
  if (!snippet) {
    return false;
  }
  return recentDiaryEntries.some((diaryEntry) => {
    const diaryText = normalizeDiaryCoverageText(diaryEntry);
    return (
      diaryText.includes(snippet) ||
      snippetSimilarity(entry.snippet, diaryEntry) >= LIGHT_DIARY_SNIPPET_SIMILARITY_THRESHOLD
    );
  });
}

function prioritizeLightEntriesByDiaryCoverage(
  entries: ShortTermRecallEntry[],
  recentDiaryEntries: readonly string[],
): ShortTermRecallEntry[] {
  if (recentDiaryEntries.length === 0) {
    return entries;
  }
  const fresh: ShortTermRecallEntry[] = [];
  const covered: ShortTermRecallEntry[] = [];
  for (const entry of entries) {
    if (isEntryCoveredByRecentDiary(entry, recentDiaryEntries)) {
      covered.push(entry);
    } else {
      fresh.push(entry);
    }
  }
  return [...fresh, ...covered];
}

function buildLightDreamingBody(entries: ShortTermRecallEntry[]): string[] {
  if (entries.length === 0) {
    return ["- No notable updates."];
  }
  const lines: string[] = [];
  for (const entry of entries) {
    const snippet = entry.snippet || "(no snippet captured)";
    lines.push(`- Candidate: ${snippet}`);
    lines.push(`  - confidence: ${entryAverageScore(entry).toFixed(2)}`);
    lines.push(`  - evidence: ${entry.path}:${entry.startLine}-${entry.endLine}`);
    lines.push(`  - recalls: ${entry.recallCount}`);
    lines.push(`  - status: staged`);
  }
  return lines;
}

type RemTruthSelection = {
  key: string;
  snippet: string;
  confidence: number;
  evidence: string;
};

type RemTruthCandidate = Omit<RemTruthSelection, "key">;

export type RemDreamingPreview = {
  sourceEntryCount: number;
  reflections: string[];
  candidateTruths: RemTruthCandidate[];
  candidateKeys: string[];
  bodyLines: string[];
};

function calculateCandidateTruthConfidence(entry: ShortTermRecallEntry): number {
  const recallStrength = Math.min(1, Math.log1p(entry.recallCount) / Math.log1p(6));
  const averageScore = entryAverageScore(entry);
  const consolidation = Math.min(1, (entry.recallDays?.length ?? 0) / 3);
  const conceptual = Math.min(1, (entry.conceptTags?.length ?? 0) / 6);
  return Math.max(
    0,
    Math.min(
      1,
      averageScore * 0.45 + recallStrength * 0.25 + consolidation * 0.2 + conceptual * 0.1,
    ),
  );
}

function selectRemCandidateTruths(
  entries: ShortTermRecallEntry[],
  limit: number,
): RemTruthSelection[] {
  if (limit <= 0) {
    return [];
  }
  return dedupeEntries(
    entries.filter((entry) => !entry.promotedAt),
    0.88,
  )
    .map((entry) => ({
      key: entry.key,
      snippet: entry.snippet || "(no snippet captured)",
      confidence: calculateCandidateTruthConfidence(entry),
      evidence: `${entry.path}:${entry.startLine}-${entry.endLine}`,
    }))
    .filter((entry) => entry.confidence >= 0.45)
    .toSorted((a, b) => b.confidence - a.confidence || a.snippet.localeCompare(b.snippet))
    .slice(0, limit);
}

function buildRemReflections(
  entries: ShortTermRecallEntry[],
  limit: number,
  minPatternStrength: number,
): string[] {
  const tagStats = new Map<string, { count: number; evidence: Set<string> }>();
  for (const entry of entries) {
    for (const tag of entry.conceptTags) {
      if (!tag || REM_REFLECTION_TAG_BLACKLIST.has(tag.toLowerCase())) {
        continue;
      }
      const stat = tagStats.get(tag) ?? { count: 0, evidence: new Set<string>() };
      stat.count += 1;
      stat.evidence.add(`${entry.path}:${entry.startLine}-${entry.endLine}`);
      tagStats.set(tag, stat);
    }
  }

  const ranked = [...tagStats.entries()]
    .map(([tag, stat]) => {
      const strength = Math.min(1, (stat.count / Math.max(1, entries.length)) * 2);
      return { tag, strength, stat };
    })
    .filter((entry) => entry.strength >= minPatternStrength)
    .toSorted(
      (a, b) =>
        b.strength - a.strength || b.stat.count - a.stat.count || a.tag.localeCompare(b.tag),
    )
    .slice(0, limit);

  if (ranked.length === 0) {
    return ["- No strong patterns surfaced."];
  }

  const lines: string[] = [];
  for (const entry of ranked) {
    lines.push(`- Theme: \`${entry.tag}\` kept surfacing across ${entry.stat.count} memories.`);
    lines.push(`  - confidence: ${entry.strength.toFixed(2)}`);
    lines.push(`  - evidence: ${[...entry.stat.evidence].slice(0, 3).join(", ")}`);
    lines.push(`  - note: reflection`);
  }
  return lines;
}

export function previewRemDreaming(params: {
  entries: ShortTermRecallEntry[];
  limit: number;
  minPatternStrength: number;
}): RemDreamingPreview {
  const reflections = buildRemReflections(params.entries, params.limit, params.minPatternStrength);
  const candidateSelections = selectRemCandidateTruths(
    params.entries,
    Math.max(1, Math.min(3, params.limit)),
  );
  const candidateTruths = candidateSelections.map((entry) => ({
    snippet: entry.snippet,
    confidence: entry.confidence,
    evidence: entry.evidence,
  }));
  const candidateKeys = uniqueStrings(candidateSelections.map((entry) => entry.key));
  const bodyLines = [
    "### Reflections",
    ...reflections,
    "",
    "### Possible Lasting Truths",
    ...(candidateTruths.length > 0
      ? candidateTruths.map(
          (entry) =>
            `- ${entry.snippet} [confidence=${entry.confidence.toFixed(2)} evidence=${entry.evidence}]`,
        )
      : ["- No strong candidate truths surfaced."]),
  ];
  return {
    sourceEntryCount: params.entries.length,
    reflections,
    candidateTruths,
    candidateKeys,
    bodyLines,
  };
}

async function runLightDreaming(params: {
  agentId?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
  primaryWorkspaceDir?: string;
  config: LightDreamingConfig;
  logger: Logger;
  subagent?: DreamNarrativeRequest["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<DreamNarrativeOutcome> {
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  await ingestDailyMemorySignals({
    workspaceDir: params.workspaceDir,
    lookbackDays: dailyIngestionLookbackDays(params.config.lookbackDays),
    limit: params.config.limit,
    nowMs,
    timezone: params.config.timezone,
  });
  await ingestSessionTranscriptSignals({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    primaryWorkspaceDir: params.primaryWorkspaceDir,
    lookbackDays: params.config.lookbackDays,
    nowMs,
    timezone: params.config.timezone,
  });
  const recentEntries = await filterLiveShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    entries: await filterFreshLightDreamingEntries({
      workspaceDir: params.workspaceDir,
      nowMs,
      entries: filterRecallEntriesWithinLookback({
        entries: await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs }),
        nowMs,
        lookbackDays: params.config.lookbackDays,
      }),
    }),
  });
  const rankedEntries = dedupeEntries(
    recentEntries.toSorted((a, b) => {
      const byTime = compareStoreTimestampDesc(a.lastRecalledAt, b.lastRecalledAt);
      if (byTime !== 0) {
        return byTime;
      }
      return b.recallCount - a.recallCount;
    }),
    params.config.dedupeSimilarity,
  );
  const recentDiaryEntries = await readRecentDreamDiaryEntries({
    workspaceDir: params.workspaceDir,
    limit: LIGHT_DIARY_HISTORY_LIMIT,
  });
  const entries = prioritizeLightEntriesByDiaryCoverage(rankedEntries, recentDiaryEntries);
  const capped = entries.slice(0, params.config.limit);
  const bodyLines = buildLightDreamingBody(capped);
  await writeDailyDreamingPhaseBlock({
    workspaceDir: params.workspaceDir,
    phase: "light",
    bodyLines,
    nowMs,
    timezone: params.config.timezone,
    storage: params.config.storage,
  });
  await recordDreamingPhaseSignals({
    workspaceDir: params.workspaceDir,
    phase: "light",
    keys: capped.map((entry) => entry.key),
    nowMs,
  });
  if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") {
    params.logger.info(
      `memory-core: light dreaming staged ${Math.min(entries.length, params.config.limit)} candidate(s) [workspace=${params.workspaceDir}].`,
    );
  }
  // Generate dream diary narrative from the staged entries.
  if (params.subagent && capped.length > 0) {
    const themes = uniqueStrings(capped.flatMap((e) => e.conceptTags).filter(Boolean));
    const data: NarrativePhaseData = {
      phase: "light",
      snippets: capped.map((e) => e.snippet).filter(Boolean),
      currentDate: formatMemoryDreamingDay(nowMs, params.config.timezone),
      ...(themes.length > 0 ? { themes } : {}),
      ...(recentDiaryEntries.length > 0 ? { recentDiaryEntries } : {}),
    };
    return await runDreamNarrative({
      agentId: params.agentId,
      subagent: params.subagent,
      workspaceDir: params.workspaceDir,
      data,
      nowMs,
      timezone: params.config.timezone,
      model: params.config.execution?.model,
      logger: params.logger,
      detached: params.detachNarratives,
    });
  }
  return { status: "skipped" };
}

async function runRemDreaming(params: {
  agentId?: string;
  workspaceDir: string;
  cfg?: OpenClawConfig;
  primaryWorkspaceDir?: string;
  config: RemDreamingConfig;
  logger: Logger;
  subagent?: DreamNarrativeRequest["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<DreamNarrativeOutcome> {
  const nowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  await ingestDailyMemorySignals({
    workspaceDir: params.workspaceDir,
    lookbackDays: dailyIngestionLookbackDays(params.config.lookbackDays),
    limit: params.config.limit,
    nowMs,
    timezone: params.config.timezone,
  });
  await ingestSessionTranscriptSignals({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    primaryWorkspaceDir: params.primaryWorkspaceDir,
    lookbackDays: params.config.lookbackDays,
    nowMs,
    timezone: params.config.timezone,
  });
  const allEntries = await filterLiveShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    entries: filterRecallEntriesWithinLookback({
      entries: await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs }),
      nowMs,
      lookbackDays: params.config.lookbackDays,
    }),
  });
  // Prefer entries staged by light sleep so REM synthesises from the
  // sequential light→REM pipeline instead of rescanning the full store.
  const lightKeys = await readLightStagedKeys({
    workspaceDir: params.workspaceDir,
    nowMs,
  });
  const stagedEntries =
    lightKeys.size > 0 ? allEntries.filter((entry) => lightKeys.has(entry.key)) : [];
  const entries = stagedEntries.length > 0 ? stagedEntries : allEntries;
  const preview = previewRemDreaming({
    entries,
    limit: params.config.limit,
    minPatternStrength: params.config.minPatternStrength,
  });
  await writeDailyDreamingPhaseBlock({
    workspaceDir: params.workspaceDir,
    phase: "rem",
    bodyLines: preview.bodyLines,
    nowMs,
    timezone: params.config.timezone,
    storage: params.config.storage,
  });
  if (stagedEntries.length > 0) {
    await recordRemConsideredPhaseSignals({
      workspaceDir: params.workspaceDir,
      keys: stagedEntries.map((entry) => entry.key),
      nowMs,
    });
  }
  await recordDreamingPhaseSignals({
    workspaceDir: params.workspaceDir,
    phase: "rem",
    keys: preview.candidateKeys,
    nowMs,
  });
  if (params.config.enabled && entries.length > 0 && params.config.storage.mode !== "separate") {
    params.logger.info(
      `memory-core: REM dreaming wrote reflections from ${entries.length} recent memory trace(s) [workspace=${params.workspaceDir}].`,
    );
  }
  // Generate dream diary narrative from REM reflections.
  if (params.subagent && entries.length > 0) {
    const snippets = preview.candidateTruths.map((t) => t.snippet).filter(Boolean);
    const themes = preview.reflections.filter(
      (r) => !r.startsWith("- No strong") && !r.startsWith("  -"),
    );
    const data: NarrativePhaseData = {
      phase: "rem",
      snippets:
        snippets.length > 0
          ? snippets
          : entries
              .slice(0, 8)
              .map((e) => e.snippet)
              .filter(Boolean),
      ...(themes.length > 0 ? { themes } : {}),
    };
    return await runDreamNarrative({
      agentId: params.agentId,
      subagent: params.subagent,
      workspaceDir: params.workspaceDir,
      data,
      nowMs,
      timezone: params.config.timezone,
      model: params.config.execution?.model,
      logger: params.logger,
      detached: params.detachNarratives,
    });
  }
  return { status: "skipped" };
}

type DreamingSweepPhaseResult = {
  degradedPhases: number;
  pendingNarratives: number;
};

export async function runDreamingSweepPhases(params: {
  /**
   * Agent that owns this workspace; narrative subagent sessions are stored under it.
   * Absent only when no roster or triggering agent can be attributed, which downgrades
   * narratives to the local diary fallback without stopping the sweep.
   */
  agentId?: string;
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  cfg?: OpenClawConfig;
  logger: Logger;
  subagent?: DreamNarrativeRequest["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<DreamingSweepPhaseResult> {
  // Normalize nowMs once so all phase timestamps and narrative session keys are consistent.
  const sweepNowMs =
    typeof params.nowMs === "number" && Number.isFinite(params.nowMs) ? params.nowMs : Date.now();
  let degradedPhases = 0;
  let pendingNarratives = 0;
  const recordNarrativeOutcome = (outcome: DreamNarrativeOutcome): void => {
    if (outcome.status === "degraded") {
      degradedPhases += 1;
    } else if (outcome.status === "pending") {
      pendingNarratives += 1;
    }
  };

  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  if (light.enabled && light.limit > 0) {
    try {
      recordNarrativeOutcome(
        await runLightDreaming({
          agentId: params.agentId,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          config: light,
          logger: params.logger,
          subagent: params.subagent,
          nowMs: sweepNowMs,
          detachNarratives: params.detachNarratives,
        }),
      );
    } catch (err) {
      await appendFailedDreamingEvent({
        workspaceDir: params.workspaceDir,
        phase: "light",
        error: formatErrorMessage(err),
        storageMode: light.storage.mode,
        nowMs: sweepNowMs,
        logger: params.logger,
      });
      throw err;
    }
  }

  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg,
  });
  if (rem.enabled && rem.limit > 0) {
    try {
      recordNarrativeOutcome(
        await runRemDreaming({
          agentId: params.agentId,
          workspaceDir: params.workspaceDir,
          cfg: params.cfg,
          config: rem,
          logger: params.logger,
          subagent: params.subagent,
          nowMs: sweepNowMs,
          detachNarratives: params.detachNarratives,
        }),
      );
    } catch (err) {
      await appendFailedDreamingEvent({
        workspaceDir: params.workspaceDir,
        phase: "rem",
        error: formatErrorMessage(err),
        storageMode: rem.storage.mode,
        nowMs: sweepNowMs,
        logger: params.logger,
      });
      throw err;
    }
  }
  return { degradedPhases, pendingNarratives };
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
