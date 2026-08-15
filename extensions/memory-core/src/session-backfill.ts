import fs from "node:fs/promises";
import path from "node:path";
import { listSessionTranscriptCorpusEntriesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import type { SessionIngestionFileState } from "./dreaming-ingestion-state.js";
import { removeBackfillDiaryEntries, writeBackfillDiaryEntries } from "./dreaming-narrative.js";
import { previewGroundedRemMarkdown } from "./rem-evidence.js";
import type {
  SessionBackfillDay,
  SessionBackfillExecution,
  SessionBackfillResult,
} from "./session-backfill-contract.js";
import {
  drainSessionBackfill,
  markSessionBackfillRewindBaseline,
  recordSessionBackfillRewindBatch,
  resetSessionBackfillIngestionState,
  rewindSessionBackfillIngestionState,
} from "./session-backfill-lifecycle.js";
import { normalizeSessionBackfillSelection } from "./session-backfill-selection.js";
import {
  SESSION_INGESTION_MAX_MESSAGES_PER_FILE,
  SESSION_INGESTION_MAX_MESSAGES_PER_SWEEP,
  SESSION_INGESTION_MIN_MESSAGES_PER_FILE,
  SESSION_INGESTION_SCORE,
  SESSION_CORPUS_RELATIVE_DIR,
  appendSessionCorpusLines,
  foreignSessionIngestionSource,
  mergeTrackedMessageHashes,
  readSessionIngestionState,
  scanSessionIngestionSource,
  sessionIngestionSourceFromCorpus,
  trimTrackedSessionScopes,
  writeSessionIngestionState,
  type SessionIngestionCandidate,
  type SessionIngestionSource,
} from "./session-ingestion.js";
import {
  readShortTermRecallEntries,
  recordGroundedShortTermCandidates,
  removeGroundedShortTermCandidates,
} from "./short-term-promotion.js";

const SESSION_BACKFILL_QUERY_PREFIX = "__dreaming_session_backfill__";
const TOP_CANDIDATE_LIMIT = 5;
const MAX_SESSION_BACKFILL_APPLY_BATCHES = 10_000;

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

type SessionBackfillCandidate = SessionIngestionCandidate;

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

type RunSessionBackfillParams = {
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

async function listSessionBackfillSources(params: {
  agentId: string;
  archiveFiles: string[];
}): Promise<SessionIngestionSource[]> {
  const corpus = await listSessionTranscriptCorpusEntriesForAgent(params.agentId, {
    includeRetainedSqlite: true,
  });
  const sources = corpus
    .map(sessionIngestionSourceFromCorpus)
    .filter(
      (entry): entry is SessionIngestionSource =>
        entry !== null &&
        !entry.buildOptions.generatedByDreamingNarrative &&
        !entry.buildOptions.generatedByCronRun,
    );
  const canonicalPaths = new Set(sources.map((entry) => path.resolve(entry.absolutePath)));
  for (const archiveFile of params.archiveFiles) {
    // Foreign files do not inherit canonical session identity from a matching basename.
    const source = foreignSessionIngestionSource(params.agentId, archiveFile);
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
  sources: SessionIngestionSource[];
  files: Record<string, SessionIngestionFileState>;
  seenMessages: Record<string, string[]>;
  from?: string;
  to?: string;
  timezone?: string;
}) {
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
    const scan = await scanSessionIngestionSource({
      source,
      previous: params.files[source.stateKey],
      seenMessages: params.seenMessages,
      timezone: params.timezone,
      verifyContent: true,
      classifyDay: (day) =>
        (params.from === undefined || day >= params.from) &&
        (params.to === undefined || day <= params.to)
          ? "include"
          : "block",
      // Canonical parsing emits `agent` only inside an authenticated owner
      // turn; replies to non-owner input retain the turn's untrusted taint.
      acceptProvenance: (provenance) =>
        provenance.originClass === "owner" || provenance.originClass === "agent",
    });
    if (scan.status !== "scanned" || !scan.fileState) {
      continue;
    }
    candidates.push(
      ...scan.candidates.toSorted(compareSessionBackfillCandidates).slice(0, perFileCap),
    );
    scans.push({
      candidates: scan.candidates,
      contentHash: scan.fileState.contentHash,
      lineCount: scan.fileState.lineCount,
      mtimeMs: scan.fileState.mtimeMs,
      ...(scan.progressBlockIndex !== undefined
        ? { progressBlockIndex: scan.progressBlockIndex }
        : {}),
      scannedEndIndex: scan.scannedEndIndex,
      size: scan.fileState.size,
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
    const [diary, staged] = await Promise.all([
      removeBackfillDiaryEntries({ workspaceDir }),
      removeGroundedShortTermCandidates({ workspaceDir }),
    ]);
    const rewind = await rewindSessionBackfillIngestionState({
      workspaceDir,
      agentId: params.agentId,
    });
    if (!rewind.completeCoverage && (diary.removed > 0 || staged.removed > 0)) {
      // Applies from before the rewind journal shipped have no owned offsets to restore.
      // Without this agent-scoped reset, rollback deletes artifacts but re-apply finds nothing.
      await resetSessionBackfillIngestionState({ workspaceDir, agentId: params.agentId });
    }
    await markSessionBackfillRewindBaseline({ workspaceDir, agentId: params.agentId });
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
    await recordSessionBackfillRewindBatch({
      workspaceDir,
      candidates: selectedDays.flatMap((day) =>
        day.candidates.map((candidate) => ({
          contentIndex: candidate.contentIndex,
          hash: candidate.hash,
          scope: candidate.scope,
          stateKey: candidate.stateKey,
        })),
      ),
    });
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

// The CLI owns drain-to-completion. Cursor-driven clients must keep using
// executeSessionBackfillBatch so one request remains one bounded transaction.
export async function runSessionBackfill(
  params: RunSessionBackfillParams,
): Promise<SessionBackfillResult> {
  if (!params.apply || params.rollback) {
    return (await executeSessionBackfillCore(params)).result;
  }

  return await drainSessionBackfill({
    executeBatch: () => executeSessionBackfillCore(params),
    maxBatches: MAX_SESSION_BACKFILL_APPLY_BATCHES,
    topCandidateLimit: TOP_CANDIDATE_LIMIT,
  });
}

export async function executeSessionBackfillBatch(
  params: RunSessionBackfillParams,
): Promise<SessionBackfillExecution> {
  return await executeSessionBackfillCore(params);
}
