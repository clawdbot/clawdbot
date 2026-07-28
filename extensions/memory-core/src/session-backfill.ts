import fs from "node:fs/promises";
import path from "node:path";
import {
  buildSessionEntry,
  listSessionTranscriptCorpusEntriesForAgent,
  sessionPathForFile,
  type SessionTranscriptCorpusEntry,
} from "openclaw/plugin-sdk/memory-core-host-engine-qmd";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { SessionIngestionFileState } from "./dreaming-ingestion-state.js";
import { removeBackfillDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-narrative.js";
import {
  SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
  SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP,
  SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
  SESSION_INGESTION_MIN_SNIPPET_CHARS,
  SESSION_INGESTION_SCORE,
  appendSessionCorpusLines,
  buildSessionFileScopeKey,
  buildSessionRenderedLine,
  buildSqliteDreamingSessionPath,
  buildSessionStateKey,
  hashSessionMessageId,
  mergeTrackedMessageHashes,
  normalizeSessionCorpusSnippet,
  readSessionIngestionState,
  trimTrackedSessionScopes,
  writeSessionIngestionState,
  type SessionIngestionMessage,
} from "./dreaming-phases.js";
import { previewGroundedRemMarkdown } from "./rem-evidence.js";
import {
  readShortTermRecallEntries,
  recordGroundedShortTermCandidates,
  removeGroundedShortTermCandidates,
} from "./short-term-promotion.js";

const DEFAULT_SESSION_BACKFILL_LIMIT_DAYS = 92;
const SESSION_BACKFILL_QUERY_PREFIX = "__dreaming_session_backfill__";
const SESSION_CORPUS_RELATIVE_DIR = path.join("memory", ".dreams", "session-corpus");
const TOP_CANDIDATE_LIMIT = 5;
const MEMORY_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

export type MemorySessionBackfillOptions = {
  agent?: string;
  from?: string;
  to?: string;
  limitDays?: number;
  rem?: boolean;
  apply?: boolean;
  rollback?: boolean;
  archiveFiles?: string[];
  json?: boolean;
};

type SessionBackfillSource = {
  agentId: string;
  absolutePath: string;
  foreign: boolean;
  sessionPath: string;
  stateKey: string;
  scope: string;
  legacyScope?: string;
  sessionId?: string;
  sessionKey?: string;
  storePath?: string;
  updatedAtMs?: number;
  generatedByDreamingNarrative?: boolean;
  generatedByCronRun?: boolean;
  sessionKind: "interactive";
};

type SessionBackfillCandidate = SessionIngestionMessage & {
  hash: string;
  contentIndex: number;
  legacyHash?: string;
  lineNumber: number;
  scope: string;
};

type SessionBackfillScan = {
  candidates: SessionBackfillCandidate[];
  contentHash: string;
  lineCount: number;
  mtimeMs: number;
  progressBlockIndex?: number;
  scannedEndIndex: number;
  size: number;
  stateKey: string;
};

type SessionBackfillCollection = {
  byDay: Map<string, SessionBackfillCandidate[]>;
  scans: SessionBackfillScan[];
};

type SessionBackfillDay = {
  day: string;
  candidateCount: number;
  topCandidates: string[];
};

export type SessionBackfillResult = {
  agentId: string;
  workspaceDir: string;
  applied: boolean;
  rem: boolean;
  days: SessionBackfillDay[];
  candidateCount: number;
  stagedEntries: number;
  writtenDiaryEntries: number;
  replacedDiaryEntries: number;
  rollback?: {
    removedDiaryEntries: number;
    removedStagedEntries: number;
  };
};

type SessionBackfillContinuation = {
  advanced: boolean;
  hasMore: boolean;
};

type SessionBackfillExecution = {
  result: SessionBackfillResult;
  continuation: SessionBackfillContinuation;
};

export type RunSessionBackfillParams = {
  agentId: string;
  workspaceDir: string;
  from?: string;
  to?: string;
  limitDays?: number;
  rem?: boolean;
  apply?: boolean;
  rollback?: boolean;
  archiveFiles?: string[];
  nowMs?: number;
  timezone?: string;
};

function normalizeMemoryDay(value: string | undefined, flag: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const day = value.trim();
  if (!MEMORY_DAY_RE.test(day)) {
    throw new Error(`${flag} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) {
    throw new Error(`${flag} must be a valid calendar day.`);
  }
  return day;
}

function resolveLimitDays(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SESSION_BACKFILL_LIMIT_DAYS;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("--limit-days must be a positive integer.");
  }
  return value;
}

export function normalizeSessionBackfillSelection(
  params: Pick<RunSessionBackfillParams, "from" | "to" | "limitDays">,
  labels: { from: string; to: string; limitDays: string } = {
    from: "--from",
    to: "--to",
    limitDays: "--limit-days",
  },
): { from?: string; to?: string; limitDays: number } {
  const from = normalizeMemoryDay(params.from, labels.from);
  const to = normalizeMemoryDay(params.to, labels.to);
  if (from !== undefined && to !== undefined && from > to) {
    throw new Error(`${labels.from} must not be after ${labels.to}.`);
  }
  let limitDays: number;
  try {
    limitDays = resolveLimitDays(params.limitDays);
  } catch {
    throw new Error(`${labels.limitDays} must be a positive integer.`);
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    limitDays,
  };
}

function sourceFromCorpusEntry(entry: SessionTranscriptCorpusEntry): SessionBackfillSource | null {
  if (
    entry.sessionKind !== "interactive" ||
    entry.generatedByDreamingNarrative ||
    entry.generatedByCronRun
  ) {
    return null;
  }
  const sessionPath =
    entry.transcriptSource === "sqlite"
      ? buildSqliteDreamingSessionPath(entry.agentId, entry.sessionId)
      : sessionPathForFile(entry.sessionFile);
  return {
    agentId: entry.agentId,
    absolutePath: entry.sessionFile,
    foreign: false,
    sessionPath,
    stateKey: buildSessionStateKey(entry.agentId, sessionPath),
    scope:
      entry.transcriptSource === "sqlite"
        ? `${entry.agentId}:${sessionPath}`
        : buildSessionFileScopeKey(entry.agentId, entry.sessionFile),
    ...(entry.transcriptSource === "sqlite"
      ? { legacyScope: `${entry.agentId}:${entry.sessionId}` }
      : {}),
    ...(entry.transcriptSource === "sqlite" ? { sessionId: entry.sessionId } : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.storePath ? { storePath: entry.storePath } : {}),
    ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
    ...(entry.generatedByDreamingNarrative
      ? { generatedByDreamingNarrative: entry.generatedByDreamingNarrative }
      : {}),
    ...(entry.generatedByCronRun ? { generatedByCronRun: entry.generatedByCronRun } : {}),
    sessionKind: "interactive",
  };
}

function sourceFromArchiveFile(agentId: string, archiveFile: string): SessionBackfillSource {
  const absolutePath = path.resolve(archiveFile);
  const sessionPath = sessionPathForFile(absolutePath);
  return {
    agentId,
    absolutePath,
    foreign: true,
    sessionPath,
    stateKey: `session-backfill:${absolutePath.replaceAll("\\", "/")}`,
    // Foreign files do not inherit canonical session identity from a matching basename.
    scope: `archive:${agentId}:${absolutePath.replaceAll("\\", "/")}`,
    sessionKind: "interactive",
  };
}

async function listSessionBackfillSources(params: {
  agentId: string;
  archiveFiles: string[];
}): Promise<SessionBackfillSource[]> {
  const corpus = await listSessionTranscriptCorpusEntriesForAgent(params.agentId, {
    includeRetainedSqlite: true,
  });
  const sources = corpus
    .map(sourceFromCorpusEntry)
    .filter((entry): entry is SessionBackfillSource => entry !== null);
  const canonicalPaths = new Set(sources.map((entry) => path.resolve(entry.absolutePath)));
  for (const archiveFile of params.archiveFiles) {
    const source = sourceFromArchiveFile(params.agentId, archiveFile);
    if (!canonicalPaths.has(source.absolutePath)) {
      sources.push(source);
      canonicalPaths.add(source.absolutePath);
    }
  }
  return sources.toSorted((a, b) =>
    a.sessionPath === b.sessionPath
      ? a.absolutePath.localeCompare(b.absolutePath)
      : a.sessionPath.localeCompare(b.sessionPath),
  );
}

function candidateDayInRange(
  day: string,
  from: string | undefined,
  to: string | undefined,
): boolean {
  return (from === undefined || day >= from) && (to === undefined || day <= to);
}

function compareSessionBackfillCandidates(
  a: SessionBackfillCandidate,
  b: SessionBackfillCandidate,
): number {
  if (a.day !== b.day) {
    return a.day.localeCompare(b.day);
  }
  if (a.provenance.observedAt !== b.provenance.observedAt) {
    return a.provenance.observedAt - b.provenance.observedAt;
  }
  if (a.scope !== b.scope) {
    return a.scope.localeCompare(b.scope);
  }
  return a.lineNumber - b.lineNumber;
}

async function collectSessionBackfillCandidates(params: {
  sources: SessionBackfillSource[];
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
  from?: string;
  to?: string;
  timezone?: string;
}): Promise<SessionBackfillCollection> {
  const candidates: SessionBackfillCandidate[] = [];
  const scans: SessionBackfillScan[] = [];
  const perFileCap = Math.min(
    SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
    Math.max(
      SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
      Math.ceil(SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP / Math.max(1, params.sources.length)),
    ),
  );

  for (const source of params.sources) {
    const entry = await buildSessionEntry(source.absolutePath, {
      agentId: source.agentId,
      sessionKind: source.sessionKind,
      ...(source.generatedByDreamingNarrative !== undefined
        ? { generatedByDreamingNarrative: source.generatedByDreamingNarrative }
        : {}),
      ...(source.generatedByCronRun !== undefined
        ? { generatedByCronRun: source.generatedByCronRun }
        : {}),
      ...(source.sessionKey !== undefined ? { sessionKey: source.sessionKey } : {}),
      ...(source.sessionId !== undefined ? { sessionId: source.sessionId } : {}),
      ...(source.storePath !== undefined ? { storePath: source.storePath } : {}),
      ...(source.updatedAtMs !== undefined ? { updatedAtMs: source.updatedAtMs } : {}),
    });
    if (!entry || entry.generatedByDreamingNarrative || entry.generatedByCronRun) {
      continue;
    }
    const seen = new Set(params.seenMessages[source.scope] ?? []);
    const legacySeen = source.legacyScope
      ? new Set(params.seenMessages[source.legacyScope] ?? [])
      : undefined;
    const lines = entry.content.length > 0 ? entry.content.split("\n") : [];
    const previous = params.files[source.stateKey];
    const unchanged =
      previous?.mtimeMs === Math.floor(entry.mtimeMs) &&
      previous.size === Math.floor(entry.size) &&
      previous.contentHash === entry.hash &&
      previous.lineCount === lines.length;
    const startIndex = unchanged ? Math.min(previous.lastContentLine, lines.length) : 0;
    const sourceCandidates: SessionBackfillCandidate[] = [];
    let progressBlockIndex: number | undefined;
    let scannedEndIndex = startIndex;
    for (let index = startIndex; index < lines.length; index += 1) {
      scannedEndIndex = index + 1;
      const snippet = normalizeSessionCorpusSnippet(lines[index] ?? "");
      if (snippet.length < SESSION_INGESTION_MIN_SNIPPET_CHARS) {
        continue;
      }
      const lineNumber = entry.lineMap[index] ?? index + 1;
      const timestampMs = entry.messageTimestampsMs[index] ?? 0;
      const parsedProvenance = entry.lineProvenance[index] ?? {
        originClass: "untrusted" as const,
        sessionKind: "interactive" as const,
        observedAt: timestampMs || entry.mtimeMs,
      };
      // Foreign JSONL is caller-controlled, so embedded owner metadata is not
      // authenticated. Only the canonical session store can establish trust.
      const provenance = source.foreign
        ? { ...parsedProvenance, originClass: "untrusted" as const }
        : parsedProvenance;
      // Canonical parsing emits `agent` only inside an authenticated owner
      // turn; replies to non-owner input retain the turn's untrusted taint.
      if (provenance.originClass !== "owner" && provenance.originClass !== "agent") {
        continue;
      }
      const day = formatMemoryDreamingDay(
        timestampMs > 0 ? timestampMs : entry.mtimeMs,
        params.timezone,
      );
      if (!candidateDayInRange(day, params.from, params.to)) {
        progressBlockIndex ??= index;
        continue;
      }
      const dedupeBasis = timestampMs > 0 ? `ts:${Math.floor(timestampMs)}` : `line:${lineNumber}`;
      const hash = hashSessionMessageId(`${source.scope}\n${dedupeBasis}\n${snippet}`);
      const legacyHash = source.legacyScope
        ? hashSessionMessageId(`${source.legacyScope}\n${dedupeBasis}\n${snippet}`)
        : undefined;
      if (seen.has(hash) || (legacyHash !== undefined && legacySeen?.has(legacyHash))) {
        continue;
      }
      const rendered = buildSessionRenderedLine({
        agentId: source.agentId,
        sessionPath: source.sessionPath,
        lineNumber,
        snippet,
      });
      const candidate = {
        contentIndex: index,
        day,
        hash,
        ...(legacyHash ? { legacyHash } : {}),
        lineNumber,
        provenance,
        rendered,
        scope: source.scope,
        snippet,
      } satisfies SessionBackfillCandidate;
      sourceCandidates.push(candidate);
      seen.add(hash);
    }
    candidates.push(
      ...sourceCandidates.toSorted(compareSessionBackfillCandidates).slice(0, perFileCap),
    );
    scans.push({
      candidates: sourceCandidates,
      contentHash: entry.hash,
      lineCount: lines.length,
      mtimeMs: Math.floor(entry.mtimeMs),
      ...(progressBlockIndex !== undefined ? { progressBlockIndex } : {}),
      scannedEndIndex,
      size: Math.floor(entry.size),
      stateKey: source.stateKey,
    });
  }
  const selected = candidates
    .toSorted(compareSessionBackfillCandidates)
    .slice(0, SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP);
  const byDay = new Map<string, SessionBackfillCandidate[]>();
  for (const candidate of selected) {
    const bucket = byDay.get(candidate.day) ?? [];
    bucket.push(candidate);
    byDay.set(candidate.day, bucket);
  }
  return { byDay, scans };
}

function mergeSessionBackfillFileProgress(params: {
  current: Record<string, SessionIngestionFileState>;
  scans: SessionBackfillScan[];
  selectedDays: Array<{ candidates: SessionBackfillCandidate[] }>;
}): Record<string, SessionIngestionFileState> {
  const selectedHashes = new Set(
    params.selectedDays.flatMap((day) => day.candidates.map((candidate) => candidate.hash)),
  );
  const files = { ...params.current };
  for (const scan of params.scans) {
    const firstUnselected = scan.candidates.find(
      (candidate) => !selectedHashes.has(candidate.hash),
    );
    const progressStops = [
      scan.scannedEndIndex,
      ...(firstUnselected ? [firstUnselected.contentIndex] : []),
      ...(scan.progressBlockIndex !== undefined ? [scan.progressBlockIndex] : []),
    ];
    files[scan.stateKey] = {
      mtimeMs: scan.mtimeMs,
      size: scan.size,
      contentHash: scan.contentHash,
      lineCount: scan.lineCount,
      lastContentLine: Math.min(...progressStops),
    };
  }
  return files;
}

function summarizeDay(day: string, candidates: SessionBackfillCandidate[]): SessionBackfillDay {
  return {
    day,
    candidateCount: candidates.length,
    topCandidates: candidates.slice(0, TOP_CANDIDATE_LIMIT).map((entry) => entry.snippet),
  };
}

function buildSummaryDiaryLines(day: SessionBackfillDay): string[] {
  return [
    `Session backfill found ${day.candidateCount} trusted candidate${day.candidateCount === 1 ? "" : "s"}.`,
    ...day.topCandidates.map((candidate) => `- ${candidate}`),
  ];
}

function groundedMarkdownToDiaryLines(markdown: string): string[] {
  return markdown
    .split(/\r?\n/)
    .map((line) => line.replace(/^##\s+/, "").trimEnd())
    .filter((line, index, lines) => !(line.length === 0 && lines[index - 1]?.length === 0));
}

async function buildRemDiaryEntries(params: {
  days: Array<{ day: string; candidates: SessionBackfillCandidate[] }>;
}): Promise<Array<{ isoDay: string; sourcePath: string; bodyLines: string[] }>> {
  const scratchDir = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-session-backfill-"),
  );
  try {
    const entries: Array<{ isoDay: string; sourcePath: string; bodyLines: string[] }> = [];
    for (const day of params.days) {
      const results = await appendSessionCorpusLines({
        workspaceDir: scratchDir,
        day: day.day,
        lines: day.candidates,
      });
      if (results.length === 0) {
        continue;
      }
      const corpusPath = path.join(scratchDir, SESSION_CORPUS_RELATIVE_DIR, `${day.day}.txt`);
      const inputPath = path.join(scratchDir, "memory", `${day.day}.md`);
      const corpus = await fs.readFile(corpusPath, "utf-8");
      await fs.writeFile(inputPath, `## Session transcript\n\n${corpus}`);
      const preview = await previewGroundedRemMarkdown({
        workspaceDir: scratchDir,
        inputPaths: [inputPath],
      });
      const file = preview.files.at(0);
      const hasGroundedContent = Boolean(
        file &&
        (file.facts.length > 0 ||
          file.reflections.length > 0 ||
          file.memoryImplications.length > 0 ||
          file.candidates.length > 0),
      );
      entries.push({
        isoDay: day.day,
        sourcePath: results[0]?.path ?? `memory/.dreams/session-corpus/${day.day}.txt`,
        bodyLines:
          hasGroundedContent && file
            ? groundedMarkdownToDiaryLines(file.renderedMarkdown)
            : buildSummaryDiaryLines(summarizeDay(day.day, day.candidates)),
      });
    }
    return entries;
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true });
  }
}

function uniqueGroundedItems(results: MemorySearchResult[]): MemorySearchResult[] {
  const seen = new Set<string>();
  return results.flatMap((result) => {
    const snippet = result.snippet.replace(/^(?:Assistant|User):\s*/i, "").trim();
    const key = snippet.replace(/\s+/g, " ").toLowerCase();
    if (!key || seen.has(key)) {
      return [];
    }
    seen.add(key);
    return [{ ...result, snippet }];
  });
}

async function applySessionBackfillDays(params: {
  workspaceDir: string;
  days: Array<{ day: string; candidates: SessionBackfillCandidate[] }>;
  nowMs: number;
  timezone?: string;
}): Promise<number> {
  const before = await readShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  for (const day of params.days) {
    const results = await appendSessionCorpusLines({
      workspaceDir: params.workspaceDir,
      day: day.day,
      lines: day.candidates,
    });
    const grounded = uniqueGroundedItems(results);
    if (grounded.length === 0) {
      continue;
    }
    // Standard grounded staging owns claim identity. Exact duplicates are
    // collapsed here; claim-hash keying also converges the same fact across sources.
    await recordGroundedShortTermCandidates({
      workspaceDir: params.workspaceDir,
      query: `${SESSION_BACKFILL_QUERY_PREFIX}:${day.day}`,
      items: grounded.map((result) => ({
        path: result.path,
        startLine: result.startLine,
        endLine: result.endLine,
        snippet: result.snippet,
        score: SESSION_INGESTION_SCORE,
        dayBucket: day.day,
      })),
      dedupeByQueryPerDay: true,
      nowMs: params.nowMs,
      ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
    });
  }
  const after = await readShortTermRecallEntries({
    workspaceDir: params.workspaceDir,
    nowMs: params.nowMs,
  });
  return Math.max(0, after.length - before.length);
}

async function executeSessionBackfillCore(
  params: RunSessionBackfillParams,
): Promise<SessionBackfillExecution> {
  const workspaceDir = params.workspaceDir.trim();
  if (!workspaceDir) {
    throw new Error("Memory session-backfill requires a resolvable workspace directory.");
  }
  if (params.rem && params.apply) {
    throw new Error("Memory session-backfill --rem cannot be combined with --apply.");
  }
  const nowMs = Number.isFinite(params.nowMs) ? (params.nowMs as number) : Date.now();
  if (params.rollback) {
    // Backfill diary markers and grounded-only candidates are a shared artifact
    // class with rem-backfill; the stable removal APIs intentionally clear both.
    // Ingestion cursors and hashes remain: rollback must not re-ingest tracked messages.
    const [diary, staged] = await Promise.all([
      removeBackfillDiaryEntries({ workspaceDir }),
      removeGroundedShortTermCandidates({ workspaceDir }),
    ]);
    return {
      result: {
        agentId: params.agentId,
        workspaceDir,
        applied: false,
        rem: false,
        days: [],
        candidateCount: 0,
        stagedEntries: 0,
        writtenDiaryEntries: 0,
        replacedDiaryEntries: 0,
        rollback: {
          removedDiaryEntries: diary.removed,
          removedStagedEntries: staged.removed,
        },
      },
      continuation: { advanced: false, hasMore: false },
    };
  }

  const { from, to, limitDays } = normalizeSessionBackfillSelection(params);
  const state = await readSessionIngestionState(workspaceDir);
  const sources = await listSessionBackfillSources({
    agentId: params.agentId,
    archiveFiles: params.archiveFiles ?? [],
  });
  const collected = await collectSessionBackfillCandidates({
    sources,
    files: state.files,
    seenMessages: state.seenMessages,
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
  });
  const selectedDays = [...collected.byDay.keys()]
    .toSorted()
    .slice(0, limitDays)
    .map((day) => ({ day, candidates: collected.byDay.get(day) ?? [] }));
  const days = selectedDays.map((entry) => summarizeDay(entry.day, entry.candidates));
  const candidateCount = days.reduce((sum, day) => sum + day.candidateCount, 0);
  // Scans retain every unseen in-range candidate before batch caps, so comparing their full
  // hash set with the selected batch makes continuation authoritative across day/file caps.
  const selectedHashes = new Set(
    selectedDays.flatMap((day) => day.candidates.map((candidate) => candidate.hash)),
  );
  const continuation = {
    advanced: Boolean(params.apply) && candidateCount > 0,
    hasMore: collected.scans.some((scan) =>
      scan.candidates.some((candidate) => !selectedHashes.has(candidate.hash)),
    ),
  };
  let writtenDiaryEntries = 0;
  let replacedDiaryEntries = 0;
  let stagedEntries = 0;

  if (selectedDays.length > 0 && (params.rem || params.apply)) {
    const diaryEntries = params.rem
      ? await buildRemDiaryEntries({ days: selectedDays })
      : selectedDays.map((entry) => ({
          isoDay: entry.day,
          sourcePath: `memory/.dreams/session-corpus/${entry.day}.txt`,
          bodyLines: buildSummaryDiaryLines(summarizeDay(entry.day, entry.candidates)),
        }));
    const diary = await writeBackfillDiaryEntries({
      workspaceDir,
      entries: diaryEntries,
      preserveExisting: true,
      ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
    });
    writtenDiaryEntries = diary.written;
    replacedDiaryEntries = diary.replaced;
  }

  if (params.apply) {
    if (selectedDays.length > 0) {
      stagedEntries = await applySessionBackfillDays({
        workspaceDir,
        days: selectedDays,
        nowMs,
        ...(params.timezone !== undefined ? { timezone: params.timezone } : {}),
      });
    }
    const nextSeenMessages = { ...state.seenMessages };
    for (const { candidates } of selectedDays) {
      const hashesByScope = new Map<string, string[]>();
      for (const candidate of candidates) {
        const hashes = hashesByScope.get(candidate.scope) ?? [];
        hashes.push(candidate.hash);
        hashesByScope.set(candidate.scope, hashes);
      }
      for (const [scope, hashes] of hashesByScope) {
        nextSeenMessages[scope] = mergeTrackedMessageHashes(nextSeenMessages[scope] ?? [], hashes);
      }
    }
    await writeSessionIngestionState(workspaceDir, {
      ...state,
      files: mergeSessionBackfillFileProgress({
        current: state.files,
        scans: collected.scans,
        selectedDays,
      }),
      seenMessages: trimTrackedSessionScopes(nextSeenMessages),
    });
  }

  return {
    result: {
      agentId: params.agentId,
      workspaceDir,
      applied: Boolean(params.apply),
      rem: Boolean(params.rem),
      days,
      candidateCount,
      stagedEntries,
      writtenDiaryEntries,
      replacedDiaryEntries,
    },
    continuation,
  };
}

export async function executeSessionBackfill(
  params: RunSessionBackfillParams,
): Promise<SessionBackfillResult> {
  return (await executeSessionBackfillCore(params)).result;
}

export async function executeSessionBackfillBatch(
  params: RunSessionBackfillParams,
): Promise<SessionBackfillExecution> {
  return await executeSessionBackfillCore(params);
}

// Preserve the CLI-facing name while every caller shares the same executor.
export { executeSessionBackfill as runSessionBackfill };
