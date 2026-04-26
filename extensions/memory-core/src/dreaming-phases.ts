import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/memory-core";
import {
  buildSessionEntry,
  listSessionFilesForAgent,
  loadSessionTranscriptClassificationForAgent,
  normalizeSessionTranscriptPathForComparison,
  parseUsageCountedSessionIdFromFileName,
  sessionPathForFile,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import {
  formatMemoryDreamingDay,
  resolveMemoryDreamingWorkspaces,
  resolveMemoryLightDreamingConfig,
  resolveMemoryRemDreamingConfig,
} from "openclaw/plugin-sdk/memory-core-host-status";
import { writeDailyDreamingPhaseBlock } from "./dreaming-markdown.js";
import {
  buildNarrativeSessionKey,
  generateAndAppendDreamNarrative,
  type NarrativePhaseData,
} from "./dreaming-narrative.js";
import { asRecord, formatErrorMessage, normalizeTrimmedString } from "./dreaming-shared.js";
import {
  filterLiveShortTermRecallEntries,
  readShortTermRecallEntries,
  recordDreamingPhaseSignals,
  recordShortTermRecalls,
  type ShortTermRecallEntry,
} from "./short-term-promotion.js";

type Logger = Pick<OpenClawPluginApi["logger"], "info" | "warn" | "error">;
type DreamingHostConfig = unknown;
type DreamingPhaseStorageConfig = {
  timezone?: string;
  storage: { mode: "inline" | "separate" | "both"; separateReports: boolean };
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
type RunPhaseIfTriggeredParams = {
  cleanedBody: string;
  trigger?: string;
  workspaceDir?: string;
  cfg?: DreamingHostConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  eventText: string;
} & (
  | {
      phase: "light";
      config: LightDreamingConfig;
    }
  | {
      phase: "rem";
      config: RemDreamingConfig;
    }
);
const LIGHT_SLEEP_EVENT_TEXT = "__openclaw_memory_core_light_sleep__";
const REM_SLEEP_EVENT_TEXT = "__openclaw_memory_core_rem_sleep__";
const DAILY_MEMORY_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const DAILY_INGESTION_STATE_RELATIVE_PATH = path.join("memory", ".dreams", "daily-ingestion.json");
const DAILY_INGESTION_SCORE = 0.62;
const DAILY_INGESTION_MAX_SNIPPET_CHARS = 280;
const DAILY_INGESTION_MIN_SNIPPET_CHARS = 8;
const DAILY_INGESTION_MAX_CHUNK_LINES = 4;
const SESSION_INGESTION_STATE_RELATIVE_PATH = path.join(
  "memory",
  ".dreams",
  "session-ingestion.json",
);
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const SESSION_INGESTION_SCORE = 0.58;
const SESSION_INGESTION_MAX_SNIPPET_CHARS = 280;
const SESSION_INGESTION_MIN_SNIPPET_CHARS = 12;
const SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP = 240;
const SESSION_INGESTION_MAX_MESSAGES_PER_FILE = 80;
const SESSION_INGESTION_MIN_MESSAGES_PER_FILE = 12;
const SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION = 4096;
const SESSION_INGESTION_MAX_TRACKED_SCOPES = 2048;
const SESSION_CHECKPOINT_TRANSCRIPT_FILENAME_RE = /\.checkpoint\..+\.jsonl$/i;
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

function resolveWorkspaces(params: {
  cfg?: DreamingHostConfig;
  fallbackWorkspaceDir?: string;
}): string[] {
  const workspaceCandidates = params.cfg
    ? resolveMemoryDreamingWorkspaces(
        params.cfg as Parameters<typeof resolveMemoryDreamingWorkspaces>[0],
      ).map((entry) => entry.workspaceDir)
    : [];
  const seen = new Set<string>();
  const workspaces = workspaceCandidates.filter((workspaceDir) => {
    if (seen.has(workspaceDir)) {
      return false;
    }
    seen.add(workspaceDir);
    return true;
  });
  const fallbackWorkspaceDir = normalizeTrimmedString(params.fallbackWorkspaceDir);
  if (workspaces.length === 0 && fallbackWorkspaceDir) {
    workspaces.push(fallbackWorkspaceDir);
  }
  return workspaces;
}

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
  return heading.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
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
  return withoutListMarker.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ");
}

type DailySnippetChunk = {
  startLine: number;
  endLine: number;
  snippet: string;
};

const REM_REFLECTION_TAG_BLACKLIST = new Set(["assistant", "user", "system", "subagent", "the"]);

function buildDailyChunkSnippet(
  heading: string | null,
  chunkLines: string[],
  chunkKind: "list" | "paragraph" | null,
): string {
  const joiner = chunkKind === "list" ? "; " : " ";
  const body = chunkLines.join(joiner).trim();
  const prefixed = heading ? `${heading}: ${body}` : body;
  return prefixed.slice(0, DAILY_INGESTION_MAX_SNIPPET_CHARS).replace(/\s+/g, " ").trim();
}

function buildDailySnippetChunks(lines: string[], limit: number): DailySnippetChunk[] {
  const chunks: DailySnippetChunk[] = [];
  let activeHeading: string | null = null;
  let chunkLines: string[] = [];
  let chunkKind: "list" | "paragraph" | null = null;
  let chunkStartLine = 0;
  let chunkEndLine = 0;

  const flushChunk = () => {
    if (chunkLines.length === 0) {
      chunkKind = null;
      chunkStartLine = 0;
      chunkEndLine = 0;
      return;
    }

    const snippet = buildDailyChunkSnippet(activeHeading, chunkLines, chunkKind);
    if (snippet.length >= DAILY_INGESTION_MIN_SNIPPET_CHARS) {
      chunks.push({
        startLine: chunkStartLine,
        endLine: chunkEndLine,
        snippet,
      });
    }

    chunkLines = [];
    chunkKind = null;
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
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--")) {
      flushChunk();
      continue;
    }

    const snippet = normalizeDailySnippet(line);
    if (!snippet) {
      flushChunk();
      continue;
    }

    const nextKind = /^([-*+]\s+|\d+\.\s+)/.test(trimmed) ? "list" : "paragraph";
    const nextChunkLines = chunkLines.length === 0 ? [snippet] : [...chunkLines, snippet];
    const candidateSnippet = buildDailyChunkSnippet(activeHeading, nextChunkLines, nextKind);
    const shouldSplit =
      chunkLines.length > 0 &&
      (chunkKind !== nextKind ||
        chunkLines.length >= DAILY_INGESTION_MAX_CHUNK_LINES ||
        candidateSnippet.length > DAILY_INGESTION_MAX_SNIPPET_CHARS);

    if (shouldSplit) {
      flushChunk();
    }

    if (chunkLines.length === 0) {
      chunkStartLine = index + 1;
      chunkKind = nextKind;
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

function entryWithinLookback(entry: ShortTermRecallEntry, cutoffMs: number): boolean {
  const byDay = (entry.recallDays ?? []).some((day) => isDayWithinLookback(day, cutoffMs));
  if (byDay) {
    return true;
  }
  const lastRecalledAtMs = Date.parse(entry.lastRecalledAt);
  return Number.isFinite(lastRecalledAtMs) && lastRecalledAtMs >= cutoffMs;
}

type DailyIngestionBatch = {
  day: string;
  results: MemorySearchResult[];
};

type DailyIngestionFileState = {
  mtimeMs: number;
  size: number;
};

type DailyIngestionState = {
  version: 1;
  files: Record<string, DailyIngestionFileState>;
};

function resolveDailyIngestionStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, DAILY_INGESTION_STATE_RELATIVE_PATH);
}

function normalizeDailyIngestionState(raw: unknown): DailyIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  if (!filesRaw) {
    return {
      version: 1,
      files: {},
    };
  }
  const files: Record<string, DailyIngestionFileState> = {};
  for (const [key, value] of Object.entries(filesRaw)) {
    const file = asRecord(value);
    if (!file || typeof key !== "string" || key.trim().length === 0) {
      continue;
    }
    const mtimeMs = Number(file.mtimeMs);
    const size = Number(file.size);
    if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
      continue;
    }
    files[key] = {
      mtimeMs: Math.floor(mtimeMs),
      size: Math.floor(size),
    };
  }
  return {
    version: 1,
    files,
  };
}

async function readDailyIngestionState(workspaceDir: string): Promise<DailyIngestionState> {
  const statePath = resolveDailyIngestionStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeDailyIngestionState(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || err instanceof SyntaxError) {
      return { version: 1, files: {} };
    }
    throw err;
  }
}

async function writeDailyIngestionState(
  workspaceDir: string,
  state: DailyIngestionState,
): Promise<void> {
  const statePath = resolveDailyIngestionStatePath(workspaceDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, statePath);
}

type SessionIngestionFileState = {
  mtimeMs: number;
  size: number;
  contentHash: string;
  lineCount: number;
  lastContentLine: number;
};

type SessionIngestionState = {
  version: 3;
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
};

type SessionIngestionMessage = {
  day: string;
  snippet: string;
  rendered: string;
};

type SessionIngestionCollectionResult = {
  batches: DailyIngestionBatch[];
  nextState: SessionIngestionState;
  changed: boolean;
};

function normalizeWorkspaceKey(workspaceDir: string): string {
  const resolved = path.resolve(workspaceDir).replace(/\\/g, "/");
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function resolveSessionIngestionStatePath(workspaceDir: string): string {
  return path.join(workspaceDir, SESSION_INGESTION_STATE_RELATIVE_PATH);
}

function normalizeSessionIngestionState(raw: unknown): SessionIngestionState {
  const record = asRecord(raw);
  const filesRaw = asRecord(record?.files);
  const files: Record<string, SessionIngestionFileState> = {};
  if (filesRaw) {
    for (const [key, value] of Object.entries(filesRaw)) {
      const file = asRecord(value);
      if (!file || key.trim().length === 0) {
        continue;
      }
      const mtimeMs = Number(file.mtimeMs);
      const size = Number(file.size);
      if (!Number.isFinite(mtimeMs) || mtimeMs < 0 || !Number.isFinite(size) || size < 0) {
        continue;
      }
      const lineCountRaw = Number(file.lineCount);
      const lastContentLineRaw = Number(file.lastContentLine);
      const lineCount =
        Number.isFinite(lineCountRaw) && lineCountRaw >= 0 ? Math.floor(lineCountRaw) : 0;
      const lastContentLine =
        Number.isFinite(lastContentLineRaw) && lastContentLineRaw >= 0
          ? Math.floor(lastContentLineRaw)
          : 0;
      files[key] = {
        mtimeMs: Math.floor(mtimeMs),
        size: Math.floor(size),
        contentHash: typeof file.contentHash === "string" ? file.contentHash.trim() : "",
        lineCount,
        lastContentLine: Math.min(lineCount, lastContentLine),
      };
    }
  }
  const seenMessagesRaw = asRecord(record?.seenMessages);
  const seenMessages: Record<string, string[]> = {};
  if (seenMessagesRaw) {
    for (const [scope, value] of Object.entries(seenMessagesRaw)) {
      if (scope.trim().length === 0 || !Array.isArray(value)) {
        continue;
      }
      const unique = [
        ...new Set(value.filter((entry): entry is string => typeof entry === "string")),
      ]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
      if (unique.length > 0) {
        seenMessages[scope] = unique;
      }
    }
  }
  return { version: 3, files, seenMessages };
}

async function readSessionIngestionState(workspaceDir: string): Promise<SessionIngestionState> {
  const statePath = resolveSessionIngestionStatePath(workspaceDir);
  try {
    const raw = await fs.readFile(statePath, "utf-8");
    return normalizeSessionIngestionState(JSON.parse(raw) as unknown);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT" || err instanceof SyntaxError) {
      return { version: 3, files: {}, seenMessages: {} };
    }
    throw err;
  }
}

async function writeSessionIngestionState(
  workspaceDir: string,
  state: SessionIngestionState,
): Promise<void> {
  const statePath = resolveSessionIngestionStatePath(workspaceDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const tmpPath = `${statePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fs.rename(tmpPath, statePath);
}

function trimTrackedSessionScopes(
  seenMessages: Record<string, string[]>,
): Record<string, string[]> {
  const keys = Object.keys(seenMessages);
  if (keys.length <= SESSION_INGESTION_MAX_TRACKED_SCOPES) {
    return seenMessages;
  }
  const keep = new Set(keys.toSorted().slice(-SESSION_INGESTION_MAX_TRACKED_SCOPES));
  const next: Record<string, string[]> = {};
  for (const [scope, hashes] of Object.entries(seenMessages)) {
    if (keep.has(scope)) {
      next[scope] = hashes;
    }
  }
  return next;
}

function normalizeSessionCorpusSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS);
}

function hashSessionMessageId(value: string): string {
  return createHash("sha1").update(value).digest("hex");
}

function buildSessionScopeKey(agentId: string, absolutePath: string): string {
  const fileName = path.basename(absolutePath);
  const logicalSessionId = parseUsageCountedSessionIdFromFileName(fileName) ?? fileName;
  return `${agentId}:${logicalSessionId}`;
}

function mergeTrackedMessageHashes(existing: string[], additions: string[]): string[] {
  if (additions.length === 0) {
    return existing;
  }
  const seen = new Set(existing);
  const next = existing.slice();
  for (const hash of additions) {
    if (!seen.has(hash)) {
      seen.add(hash);
      next.push(hash);
    }
  }
  if (next.length <= SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION) {
    return next;
  }
  return next.slice(-SESSION_INGESTION_MAX_TRACKED_MESSAGES_PER_SESSION);
}

function areStringArraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return false;
    }
  }
  return true;
}

function buildSessionStateKey(agentId: string, absolutePath: string): string {
  return `${agentId}:${sessionPathForFile(absolutePath)}`;
}

function isCheckpointSessionTranscriptPath(absolutePath: string): boolean {
  return SESSION_CHECKPOINT_TRANSCRIPT_FILENAME_RE.test(path.basename(absolutePath));
}

function buildSessionRenderedLine(params: {
  agentId: string;
  sessionPath: string;
  lineNumber: number;
  snippet: string;
}): string {
  const source = `${params.agentId}/${params.sessionPath}#L${params.lineNumber}`;
  return `[${source}] ${params.snippet}`.slice(0, SESSION_INGESTION_MAX_SNIPPET_CHARS + 64);
}

function resolveSessionAgentsForWorkspace(cfg: DreamingHostConfig, workspaceDir: string): string[] {
  if (!cfg) {
    return [];
  }
  const target = normalizeWorkspaceKey(workspaceDir);
  const workspaces = resolveMemoryDreamingWorkspaces(
    cfg as Parameters<typeof resolveMemoryDreamingWorkspaces>[0],
  );
  const match = workspaces.find((entry) => normalizeWorkspaceKey(entry.workspaceDir) === target);
  if (!match) {
    return [];
  }
  return match.agentIds
    .filter((agentId, index, all) => agentId.trim().length > 0 && all.indexOf(agentId) === index)
    .toSorted();
}

async function appendSessionCorpusLines(params: {
  workspaceDir: string;
  day: string;
  lines: SessionIngestionMessage[];
}): Promise<MemorySearchResult[]> {
  if (params.lines.length === 0) {
    return [];
  }
  const relativePath = path.posix.join("memory", ".dreams", "session-corpus", `${params.day}.txt`);
  const absolutePath = path.join(
    params.workspaceDir,
    SESSION_CORPUS_RELATIVE_DIR,
    `${params.day}.txt`,
  );
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  let existing = "";
  try {
    existing = await fs.readFile(absolutePath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }
  const normalizedExisting = existing.replace(/\r\n/g, "\n");
  const existingLineCount =
    normalizedExisting.length === 0
      ? 0
      : normalizedExisting.endsWith("\n")
        ? normalizedExisting.slice(0, -1).split("\n").length
        : normalizedExisting.split("\n").length;
  const payload = `${params.lines.map((entry) => entry.rendered).join("\n")}\n`;
  await fs.appendFile(absolutePath, payload, "utf-8");
  return params.lines.map((entry, index) => {
    const lineNumber = existingLineCount + index + 1;
    return {
      path: relativePath,
      startLine: lineNumber,
      endLine: lineNumber,
      score: SESSION_INGESTION_SCORE,
      snippet: entry.snippet,
      source: "memory",
    };
  });
}

async function collectSessionIngestionBatches(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
  state: SessionIngestionState;
}): Promise<SessionIngestionCollectionResult> {
  if (!params.cfg) {
    return {
      batches: [],
      nextState: { version: 3, files: {}, seenMessages: {} },
      changed:
        Object.keys(params.state.files).length > 0 ||
        Object.keys(params.state.seenMessages).length > 0,
    };
  }
  const agentIds = resolveSessionAgentsForWorkspace(params.cfg, params.workspaceDir);
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  const batchByDay = new Map<string, SessionIngestionMessage[]>();
  const nextFiles: Record<string, SessionIngestionFileState> = {};
  const nextSeenMessages: Record<string, string[]> = { ...params.state.seenMessages };
  let changed = false;

  const sessionFiles: Array<{
    agentId: string;
    absolutePath: string;
    generatedByDreamingNarrative: boolean;
    generatedByCronRun: boolean;
    sessionPath: string;
  }> = [];
  for (const agentId of agentIds) {
    const files = await listSessionFilesForAgent(agentId);
    const transcriptClassification =
      files.length > 0
        ? loadSessionTranscriptClassificationForAgent(agentId)
        : {
            dreamingNarrativeTranscriptPaths: new Set<string>(),
            cronRunTranscriptPaths: new Set<string>(),
          };
    for (const absolutePath of files) {
      if (isCheckpointSessionTranscriptPath(absolutePath)) {
        continue;
      }
      const normalizedPath = normalizeSessionTranscriptPathForComparison(absolutePath);
      sessionFiles.push({
        agentId,
        absolutePath,
        generatedByDreamingNarrative:
          transcriptClassification.dreamingNarrativeTranscriptPaths.has(normalizedPath),
        generatedByCronRun: transcriptClassification.cronRunTranscriptPaths.has(normalizedPath),
        sessionPath: sessionPathForFile(absolutePath),
      });
    }
  }

  const sortedFiles = sessionFiles.toSorted((a, b) => {
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
      Math.ceil(totalCap / Math.max(1, sortedFiles.length)),
    ),
  );

  for (const file of sortedFiles) {
    if (remaining <= 0) {
      break;
    }
    const stateKey = buildSessionStateKey(file.agentId, file.absolutePath);
    const previous = params.state.files[stateKey];
    const stat = await fs.stat(file.absolutePath).catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return null;
      }
      throw err;
    });
    if (!stat) {
      if (previous) {
        changed = true;
      }
      continue;
    }
    const fingerprint = {
      mtimeMs: Math.floor(Math.max(0, stat.mtimeMs)),
      size: Math.floor(Math.max(0, stat.size)),
    };
    const cursorAtEnd = previous !== undefined && previous.lastContentLine >= previous.lineCount;
    const unchanged =
      Boolean(previous) &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash.length > 0 &&
      cursorAtEnd;
    if (unchanged) {
      nextFiles[stateKey] = previous!;
      continue;
    }

    const entry = await buildSessionEntry(file.absolutePath, {
      generatedByDreamingNarrative: file.generatedByDreamingNarrative,
      generatedByCronRun: file.generatedByCronRun,
    });
    if (!entry) {
      continue;
    }
    if (entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
      nextFiles[stateKey] = {
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
        contentHash: entry.hash.trim(),
        lineCount: entry.lineMap.length,
        lastContentLine: entry.lineMap.length,
      };
      if (
        !previous ||
        previous.mtimeMs !== fingerprint.mtimeMs ||
        previous.size !== fingerprint.size ||
        previous.contentHash !== entry.hash.trim() ||
        previous.lineCount !== entry.lineMap.length ||
        previous.lastContentLine !== entry.lineMap.length
      ) {
        changed = true;
      }
      continue;
    }
    const contentHash = entry.hash.trim();
    if (
      previous &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash === contentHash &&
      previous.lineCount === entry.lineMap.length &&
      previous.lastContentLine >= previous.lineCount
    ) {
      nextFiles[stateKey] = previous;
      continue;
    }

    const sessionScope = buildSessionScopeKey(file.agentId, file.absolutePath);
    const previousSeen = nextSeenMessages[sessionScope] ?? [];
    let seenSet = new Set(previousSeen);
    const newSeenHashes: string[] = [];

    const lines = entry.content.length > 0 ? entry.content.split("\n") : [];
    const lineCount = lines.length;
    let cursor =
      previous &&
      previous.mtimeMs === fingerprint.mtimeMs &&
      previous.size === fingerprint.size &&
      previous.contentHash === contentHash &&
      previous.lineCount === lineCount
        ? Math.max(0, Math.min(previous.lastContentLine, lineCount))
        : 0;

    const fileCap = Math.max(1, Math.min(perFileCap, remaining));
    let fileCount = 0;
    let lastScannedContentLine = cursor;
    for (let index = cursor; index < lines.length; index += 1) {
      if (fileCount >= fileCap || remaining <= 0) {
        break;
      }
      lastScannedContentLine = index + 1;
      const rawSnippet = lines[index] ?? "";
      const snippet = normalizeSessionCorpusSnippet(rawSnippet);
      if (snippet.length < SESSION_INGESTION_MIN_SNIPPET_CHARS) {
        continue;
      }
      const lineNumber = entry.lineMap[index] ?? index + 1;
      const messageTimestampMs = entry.messageTimestampsMs[index] ?? 0;
      const day = formatMemoryDreamingDay(
        messageTimestampMs > 0 ? messageTimestampMs : fingerprint.mtimeMs,
        params.timezone,
      );
      if (!isDayWithinLookback(day, cutoffMs)) {
        continue;
      }
      const dedupeBasis =
        messageTimestampMs > 0 ? `ts:${Math.floor(messageTimestampMs)}` : `line:${lineNumber}`;
      const messageHash = hashSessionMessageId(`${sessionScope}\n${dedupeBasis}\n${snippet}`);
      if (seenSet.has(messageHash)) {
        continue;
      }
      const rendered = buildSessionRenderedLine({
        agentId: file.agentId,
        sessionPath: file.sessionPath,
        lineNumber,
        snippet,
      });
      const bucket = batchByDay.get(day) ?? [];
      bucket.push({ day, snippet, rendered });
      batchByDay.set(day, bucket);
      seenSet.add(messageHash);
      newSeenHashes.push(messageHash);
      fileCount += 1;
      remaining -= 1;
    }

    if (lastScannedContentLine < cursor) {
      lastScannedContentLine = cursor;
    }
    cursor = Math.max(0, Math.min(lastScannedContentLine, lineCount));

    nextFiles[stateKey] = {
      mtimeMs: fingerprint.mtimeMs,
      size: fingerprint.size,
      contentHash,
      lineCount,
      lastContentLine: cursor,
    };
    const mergedSeen = mergeTrackedMessageHashes(previousSeen, newSeenHashes);
    nextSeenMessages[sessionScope] = mergedSeen;
    if (!areStringArraysEqual(mergedSeen, previousSeen)) {
      changed = true;
    }
    if (
      !previous ||
      previous.mtimeMs !== fingerprint.mtimeMs ||
      previous.size !== fingerprint.size ||
      previous.contentHash !== contentHash ||
      previous.lineCount !== lineCount ||
      previous.lastContentLine !== cursor
    ) {
      changed = true;
    }
  }

  for (const [key, state] of Object.entries(params.state.files)) {
    if (!Object.hasOwn(nextFiles, key)) {
      changed = true;
      continue;
    }
    const next = nextFiles[key];
    if (!next || next.mtimeMs !== state.mtimeMs || next.size !== state.size) {
      changed = true;
    }
    if (
      next &&
      typeof state.contentHash === "string" &&
      state.contentHash.trim().length > 0 &&
      next.contentHash !== state.contentHash
    ) {
      changed = true;
    }
    if (
      !next ||
      next.lineCount !== state.lineCount ||
      next.lastContentLine !== state.lastContentLine
    ) {
      changed = true;
    }
  }

  const trimmedSeenMessages = trimTrackedSessionScopes(nextSeenMessages);
  for (const [scope, hashes] of Object.entries(trimmedSeenMessages)) {
    const previous = params.state.seenMessages[scope] ?? [];
    if (!areStringArraysEqual(previous, hashes)) {
      changed = true;
    }
  }
  for (const scope of Object.keys(params.state.seenMessages)) {
    if (!Object.hasOwn(trimmedSeenMessages, scope)) {
      changed = true;
    }
  }

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

  return {
    batches,
    nextState: { version: 3, files: nextFiles, seenMessages: trimmedSeenMessages },
    changed,
  };
}

async function ingestSessionTranscriptSignals(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  lookbackDays: number;
  nowMs: number;
  timezone?: string;
}): Promise<void> {
  const state = await readSessionIngestionState(params.workspaceDir);
  const collected = await collectSessionIngestionBatches({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
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

async function collectDailyIngestionBatches(params: {
  workspaceDir: string;
  lookbackDays: number;
  limit: number;
  nowMs: number;
  state: DailyIngestionState;
}): Promise<DailyIngestionCollectionResult> {
  const memoryDir = path.join(params.workspaceDir, "memory");
  const cutoffMs = calculateLookbackCutoffMs(params.nowMs, params.lookbackDays);
  const entries = await fs.readdir(memoryDir, { withFileTypes: true }).catch((err: unknown) => {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return [] as Dirent[];
    }
    throw err;
  });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const match = entry.name.match(DAILY_MEMORY_FILENAME_RE);
      if (!match) {
        return null;
      }
      const day = match[1];
      if (!isDayWithinLookback(day, cutoffMs)) {
        return null;
      }
      return { fileName: entry.name, day };
    })
    .filter((entry): entry is { fileName: string; day: string } => entry !== null)
    .toSorted((a, b) => b.day.localeCompare(a.day));

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
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
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
    if (!unchanged) {
      changed = true;
    } else {
      continue;
    }

    const raw = await fs.readFile(filePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        return "";
      }
      throw err;
    });
    if (!raw) {
      continue;
    }
    const lines = stripManagedDailyDreamingLines(raw.split(/\r?\n/));
    const chunks = buildDailySnippetChunks(lines, perFileCap);
    const results: MemorySearchResult[] = [];
    for (const chunk of chunks) {
      results.push({
        path: relativePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: DAILY_INGESTION_SCORE,
        snippet: chunk.snippet,
        source: "memory",
      });
      if (results.length >= perFileCap || total + results.length >= totalCap) {
        break;
      }
    }
    if (results.length === 0) {
      continue;
    }
    batches.push({ day: file.day, results });
    total += results.length;
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
  const collected = await collectDailyIngestionBatches({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.lookbackDays,
    limit: params.limit,
    nowMs: params.nowMs,
    state,
  });
  const ingestionDayBucket = formatMemoryDreamingDay(params.nowMs, params.timezone);
  for (const batch of collected.batches) {
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${batch.day}`,
      results: batch.results,
      signalType: "daily",
      dedupeByQueryPerDay: true,
      dayBucket: ingestionDayBucket,
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
  const normalizedPaths = [
    ...new Set(params.filePaths.map((entry) => entry.trim()).filter(Boolean)),
  ];
  if (normalizedPaths.length === 0) {
    return {
      importedFileCount: 0,
      importedSignalCount: 0,
      skippedPaths: [],
    };
  }

  const resolved = normalizedPaths
    .map((filePath) => {
      const fileName = path.basename(filePath);
      const match = fileName.match(DAILY_MEMORY_FILENAME_RE);
      if (!match) {
        return { filePath, day: null as string | null };
      }
      return { filePath, day: match[1] ?? null };
    })
    .toSorted((a, b) => {
      if (a.day && b.day) {
        return b.day.localeCompare(a.day);
      }
      if (a.day) {
        return -1;
      }
      if (b.day) {
        return 1;
      }
      return a.filePath.localeCompare(b.filePath);
    });

  const valid = resolved.filter((entry): entry is { filePath: string; day: string } =>
    Boolean(entry.day),
  );
  const skippedPaths = resolved.filter((entry) => !entry.day).map((entry) => entry.filePath);
  const totalCap = Math.max(20, params.limit * 4);
  const perFileCap = Math.max(6, Math.ceil(totalCap / Math.max(1, valid.length)));
  let importedSignalCount = 0;
  let importedFileCount = 0;

  for (const entry of valid) {
    if (importedSignalCount >= totalCap) {
      break;
    }
    const raw = await fs.readFile(entry.filePath, "utf-8").catch((err: unknown) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        skippedPaths.push(entry.filePath);
        return "";
      }
      throw err;
    });
    if (!raw) {
      continue;
    }
    const lines = stripManagedDailyDreamingLines(raw.split(/\r?\n/));
    const chunks = buildDailySnippetChunks(lines, perFileCap);
    const results: MemorySearchResult[] = [];
    for (const chunk of chunks) {
      results.push({
        path: `memory/${entry.day}.md`,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        score: DAILY_INGESTION_SCORE,
        snippet: chunk.snippet,
        source: "memory",
      });
      if (results.length >= perFileCap || importedSignalCount + results.length >= totalCap) {
        break;
      }
    }
    if (results.length === 0) {
      continue;
    }
    await recordShortTermRecalls({
      workspaceDir: params.workspaceDir,
      query: `__dreaming_daily__:${entry.day}`,
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

function tokenizeSnippet(snippet: string): Set<string> {
  return new Set(
    snippet
      .toLowerCase()
      .split(/[^a-z0-9]+/i)
      .map((token) => token.trim())
      .filter(Boolean),
  );
}

function jaccardSimilarity(left: string, right: string): number {
  const leftTokens = tokenizeSnippet(left);
  const rightTokens = tokenizeSnippet(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) {
    return left.trim().toLowerCase() === right.trim().toLowerCase() ? 1 : 0;
  }
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return union > 0 ? intersection / union : 0;
}

function dedupeEntries(entries: ShortTermRecallEntry[], threshold: number): ShortTermRecallEntry[] {
  const deduped: ShortTermRecallEntry[] = [];
  for (const entry of entries) {
    const duplicate = deduped.find(
      (candidate) =>
        candidate.path === entry.path &&
        jaccardSimilarity(candidate.snippet, entry.snippet) >= threshold,
    );
    if (duplicate) {
      if (entry.recallCount > duplicate.recallCount) {
        duplicate.recallCount = entry.recallCount;
      }
      duplicate.totalScore = Math.max(duplicate.totalScore, entry.totalScore);
      duplicate.maxScore = Math.max(duplicate.maxScore, entry.maxScore);
      duplicate.queryHashes = [...new Set([...duplicate.queryHashes, ...entry.queryHashes])];
      duplicate.recallDays = [
        ...new Set([...duplicate.recallDays, ...entry.recallDays]),
      ].toSorted();
      duplicate.conceptTags = [...new Set([...duplicate.conceptTags, ...entry.conceptTags])];
      duplicate.lastRecalledAt =
        Date.parse(entry.lastRecalledAt) > Date.parse(duplicate.lastRecalledAt)
          ? entry.lastRecalledAt
          : duplicate.lastRecalledAt;
      continue;
    }
    deduped.push({ ...entry });
  }
  return deduped;
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
  const candidateKeys = [...new Set(candidateSelections.map((entry) => entry.key))];
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
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  config: LightDreamingConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const cutoffMs = calculateLookbackCutoffMs(nowMs, params.config.lookbackDays);
  await ingestDailyMemorySignals({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.config.lookbackDays,
    limit: params.config.limit,
    nowMs,
    timezone: params.config.timezone,
  });
  await ingestSessionTranscriptSignals({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    lookbackDays: params.config.lookbackDays,
    nowMs,
    timezone: params.config.timezone,
  });
  const recentEntries = await filterLiveShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    entries: (
      await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs })
    ).filter((entry) => entryWithinLookback(entry, cutoffMs)),
  });
  const entries = dedupeEntries(
    recentEntries
      .toSorted((a, b) => {
        const byTime = Date.parse(b.lastRecalledAt) - Date.parse(a.lastRecalledAt);
        if (byTime !== 0) {
          return byTime;
        }
        return b.recallCount - a.recallCount;
      })
      .slice(0, params.config.limit),
    params.config.dedupeSimilarity,
  );
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
    const themes = [...new Set(capped.flatMap((e) => e.conceptTags).filter(Boolean))];
    const data: NarrativePhaseData = {
      phase: "light",
      snippets: capped.map((e) => e.snippet).filter(Boolean),
      ...(themes.length > 0 ? { themes } : {}),
    };
    if (params.detachNarratives) {
      queueMicrotask(() => {
        void generateAndAppendDreamNarrative({
          subagent: params.subagent!,
          workspaceDir: params.workspaceDir,
          data,
          nowMs,
          timezone: params.config.timezone,
          logger: params.logger,
        }).catch(() => undefined);
      });
    } else {
      await generateAndAppendDreamNarrative({
        subagent: params.subagent,
        workspaceDir: params.workspaceDir,
        data,
        nowMs,
        timezone: params.config.timezone,
        logger: params.logger,
      });
    }
  }
}

async function runRemDreaming(params: {
  workspaceDir: string;
  cfg?: DreamingHostConfig;
  config: RemDreamingConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<void> {
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  const cutoffMs = calculateLookbackCutoffMs(nowMs, params.config.lookbackDays);
  await ingestDailyMemorySignals({
    workspaceDir: params.workspaceDir,
    lookbackDays: params.config.lookbackDays,
    limit: params.config.limit,
    nowMs,
    timezone: params.config.timezone,
  });
  await ingestSessionTranscriptSignals({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    lookbackDays: params.config.lookbackDays,
    nowMs,
    timezone: params.config.timezone,
  });
  const entries = await filterLiveShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    entries: (
      await readShortTermRecallEntries({ workspaceDir: params.workspaceDir, nowMs })
    ).filter((entry) => entryWithinLookback(entry, cutoffMs)),
  });
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
    if (params.detachNarratives) {
      queueMicrotask(() => {
        void generateAndAppendDreamNarrative({
          subagent: params.subagent!,
          workspaceDir: params.workspaceDir,
          data,
          nowMs,
          timezone: params.config.timezone,
          logger: params.logger,
        }).catch(() => undefined);
      });
    } else {
      await generateAndAppendDreamNarrative({
        subagent: params.subagent,
        workspaceDir: params.workspaceDir,
        data,
        nowMs,
        timezone: params.config.timezone,
        logger: params.logger,
      });
    }
  }
}

async function deleteNarrativeSessionBestEffort(
  subagent: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"],
  sessionKey: string,
): Promise<void> {
  try {
    await subagent.deleteSession({ sessionKey });
  } catch {
    // Cleanup is best-effort; request-scoped runtimes can throw synchronously.
  }
}

export async function runDreamingSweepPhases(params: {
  workspaceDir: string;
  pluginConfig?: Record<string, unknown>;
  cfg?: DreamingHostConfig;
  logger: Logger;
  subagent?: Parameters<typeof generateAndAppendDreamNarrative>[0]["subagent"];
  detachNarratives?: boolean;
  nowMs?: number;
}): Promise<void> {
  // Normalize nowMs once so all phase timestamps and narrative session keys are consistent.
  const sweepNowMs: number = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();

  const light = resolveMemoryLightDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg as Parameters<typeof resolveMemoryLightDreamingConfig>[0]["cfg"],
  });
  if (light.enabled && light.limit > 0) {
    await runLightDreaming({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      config: light,
      logger: params.logger,
      subagent: params.subagent,
      nowMs: sweepNowMs,
      detachNarratives: params.detachNarratives,
    });
    // Defensive cleanup: ensure the light-phase narrative session is deleted even if
    // generateAndAppendDreamNarrative's primary cleanup was skipped due to an error.
    // Skip when narratives are detached: the queued subagent run hasn't read the
    // session yet, so eager cleanup would race the writer and silently drop the
    // diary entry. The narrative function does its own cleanup in finally{}.
    if (params.subagent && !params.detachNarratives) {
      const lightSessionKey = buildNarrativeSessionKey({
        workspaceDir: params.workspaceDir,
        phase: "light",
        nowMs: sweepNowMs,
      });
      await deleteNarrativeSessionBestEffort(params.subagent, lightSessionKey);
    }
  }

  const rem = resolveMemoryRemDreamingConfig({
    pluginConfig: params.pluginConfig,
    cfg: params.cfg as Parameters<typeof resolveMemoryRemDreamingConfig>[0]["cfg"],
  });
  if (rem.enabled && rem.limit > 0) {
    await runRemDreaming({
      workspaceDir: params.workspaceDir,
      cfg: params.cfg,
      config: rem,
      logger: params.logger,
      subagent: params.subagent,
      nowMs: sweepNowMs,
      detachNarratives: params.detachNarratives,
    });
    // Defensive cleanup: ensure the REM-phase narrative session is deleted.
    // Skip when narratives are detached (see light-phase comment above).
    if (params.subagent && !params.detachNarratives) {
      const remSessionKey = buildNarrativeSessionKey({
        workspaceDir: params.workspaceDir,
        phase: "rem",
        nowMs: sweepNowMs,
      });
      await deleteNarrativeSessionBestEffort(params.subagent, remSessionKey);
    }
  }
}

async function runPhaseIfTriggered(
  params: RunPhaseIfTriggeredParams,
): Promise<{ handled: true; reason: string } | undefined> {
  const hasEventToken = params.cleanedBody.trim().split(/\s+/).includes(params.eventText);
  if (params.trigger !== "heartbeat" || !hasEventToken) {
    return undefined;
  }
  if (!params.config.enabled) {
    return { handled: true, reason: `memory-core: ${params.phase} dreaming disabled` };
  }
  const workspaces = resolveWorkspaces({
    cfg: params.cfg,
    fallbackWorkspaceDir: params.workspaceDir,
  });
  if (workspaces.length === 0) {
    params.logger.warn(
      `memory-core: ${params.phase} dreaming skipped because no memory workspace is available.`,
    );
    return { handled: true, reason: `memory-core: ${params.phase} dreaming missing workspace` };
  }
  if (params.config.limit === 0) {
    params.logger.info(`memory-core: ${params.phase} dreaming skipped because limit=0.`);
    return { handled: true, reason: `memory-core: ${params.phase} dreaming disabled by limit` };
  }
  for (const workspaceDir of workspaces) {
    try {
      if (params.phase === "light") {
        await runLightDreaming({
          workspaceDir,
          cfg: params.cfg,
          config: params.config,
          logger: params.logger,
          subagent: params.subagent,
        });
      } else {
        await runRemDreaming({
          workspaceDir,
          cfg: params.cfg,
          config: params.config,
          logger: params.logger,
          subagent: params.subagent,
        });
      }
    } catch (err) {
      params.logger.error(
        `memory-core: ${params.phase} dreaming failed for workspace ${workspaceDir}: ${formatErrorMessage(err)}`,
      );
    }
  }
  return { handled: true, reason: `memory-core: ${params.phase} dreaming processed` };
}

/**
 * @deprecated Unified dreaming registration lives in registerShortTermPromotionDreaming().
 */
export function registerMemoryDreamingPhases(_api: OpenClawPluginApi): void {
  // LEGACY(memory-v1): kept as a no-op compatibility shim while the unified
  // dreaming controller owns startup reconciliation and heartbeat triggers.
}

export const __testing = {
  runPhaseIfTriggered,
  previewRemDreaming,
  constants: {
    LIGHT_SLEEP_EVENT_TEXT,
    REM_SLEEP_EVENT_TEXT,
  },
};
