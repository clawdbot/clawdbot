import { createHash } from "node:crypto";
import { readSessionIngestionState, writeSessionIngestionState } from "./dreaming-phases.js";
import {
  clearMemoryCoreWorkspaceNamespace,
  readMemoryCoreWorkspaceEntries,
  SESSION_BACKFILL_REWIND_NAMESPACE,
  writeMemoryCoreWorkspaceEntry,
} from "./dreaming-state.js";
import type {
  SessionBackfillExecution,
  SessionBackfillResult,
} from "./session-backfill-contract.js";

const DEFAULT_SESSION_BACKFILL_LIMIT_DAYS = 92;
const MEMORY_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

type SessionBackfillRewindCandidate = {
  contentIndex: number;
  hash: string;
  scope: string;
  stateKey: string;
};

type SessionBackfillRewindBatch = {
  version: 1;
  candidates: SessionBackfillRewindCandidate[];
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

export function normalizeSessionBackfillSelection(
  params: { from?: string; to?: string; limitDays?: number },
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
  const limitDays = params.limitDays ?? DEFAULT_SESSION_BACKFILL_LIMIT_DAYS;
  if (!Number.isInteger(limitDays) || limitDays <= 0) {
    throw new Error(`${labels.limitDays} must be a positive integer.`);
  }
  return {
    ...(from !== undefined ? { from } : {}),
    ...(to !== undefined ? { to } : {}),
    limitDays,
  };
}

export async function recordSessionBackfillRewindBatch(params: {
  workspaceDir: string;
  candidates: SessionBackfillRewindCandidate[];
}): Promise<void> {
  if (params.candidates.length === 0) {
    return;
  }
  const key = createHash("sha256").update(JSON.stringify(params.candidates)).digest("hex");
  await writeMemoryCoreWorkspaceEntry<SessionBackfillRewindBatch>({
    namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
    workspaceDir: params.workspaceDir,
    key,
    value: { version: 1, candidates: params.candidates },
  });
}

function isSessionBackfillRewindCandidate(value: unknown): value is SessionBackfillRewindCandidate {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    Number.isInteger(candidate.contentIndex) &&
    (candidate.contentIndex as number) >= 0 &&
    typeof candidate.hash === "string" &&
    candidate.hash.length > 0 &&
    typeof candidate.scope === "string" &&
    candidate.scope.length > 0 &&
    typeof candidate.stateKey === "string" &&
    candidate.stateKey.length > 0
  );
}

export async function rewindSessionBackfillIngestionState(workspaceDir: string): Promise<void> {
  const entries = await readMemoryCoreWorkspaceEntries<SessionBackfillRewindBatch>({
    namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
    workspaceDir,
  });
  const candidates = entries.flatMap((entry) =>
    entry.value?.version === 1 && Array.isArray(entry.value.candidates)
      ? entry.value.candidates.filter(isSessionBackfillRewindCandidate)
      : [],
  );
  if (candidates.length === 0) {
    await clearMemoryCoreWorkspaceNamespace({
      namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
      workspaceDir,
    });
    return;
  }

  const state = await readSessionIngestionState(workspaceDir);
  const removedHashesByScope = new Map<string, Set<string>>();
  const rewindLineByStateKey = new Map<string, number>();
  for (const candidate of candidates) {
    const hashes = removedHashesByScope.get(candidate.scope) ?? new Set<string>();
    hashes.add(candidate.hash);
    removedHashesByScope.set(candidate.scope, hashes);
    rewindLineByStateKey.set(
      candidate.stateKey,
      Math.min(
        rewindLineByStateKey.get(candidate.stateKey) ?? candidate.contentIndex,
        candidate.contentIndex,
      ),
    );
  }

  const seenMessages = { ...state.seenMessages };
  for (const [scope, removedHashes] of removedHashesByScope) {
    const remaining = (seenMessages[scope] ?? []).filter((hash) => !removedHashes.has(hash));
    if (remaining.length > 0) {
      seenMessages[scope] = remaining;
    } else {
      delete seenMessages[scope];
    }
  }
  const files = { ...state.files };
  // Rollback intentionally reopens only the journaled backfill range. Every
  // non-backfill hash stays tracked, so later live-ingestion work remains skipped.
  for (const [stateKey, lastContentLine] of rewindLineByStateKey) {
    const current = files[stateKey];
    if (current) {
      files[stateKey] = {
        ...current,
        lastContentLine: Math.min(current.lastContentLine, lastContentLine),
      };
    }
  }
  await writeSessionIngestionState(workspaceDir, { ...state, files, seenMessages });
  await clearMemoryCoreWorkspaceNamespace({
    namespace: SESSION_BACKFILL_REWIND_NAMESPACE,
    workspaceDir,
  });
}

export async function drainSessionBackfill(params: {
  executeBatch: () => Promise<SessionBackfillExecution>;
  maxBatches: number;
  topCandidateLimit: number;
}): Promise<SessionBackfillResult> {
  const batches: SessionBackfillExecution[] = [];
  for (let batch = 1; batch <= params.maxBatches; batch += 1) {
    const execution = await params.executeBatch();
    batches.push(execution);
    if (!execution.continuation.hasMore) {
      return aggregateSessionBackfillBatches(batches, params.topCandidateLimit);
    }
    if (!execution.continuation.advanced) {
      throw new Error(
        `Memory session-backfill stopped after ${batch} batches because the ingestion cursor did not advance.`,
      );
    }
  }
  throw new Error(`Memory session-backfill exceeded the ${params.maxBatches}-batch safety limit.`);
}

function aggregateSessionBackfillBatches(
  executions: SessionBackfillExecution[],
  topCandidateLimit: number,
): SessionBackfillResult {
  const first = executions[0]?.result;
  if (!first) {
    throw new Error("Memory session-backfill completed without executing a batch.");
  }
  const days = new Map<string, SessionBackfillResult["days"][number]>();
  for (const execution of executions) {
    for (const day of execution.result.days) {
      const current = days.get(day.day);
      days.set(day.day, {
        day: day.day,
        candidateCount: (current?.candidateCount ?? 0) + day.candidateCount,
        topCandidates: [...(current?.topCandidates ?? []), ...day.topCandidates].slice(
          0,
          topCandidateLimit,
        ),
      });
    }
  }
  return {
    ...first,
    days: [...days.values()].toSorted((a, b) => a.day.localeCompare(b.day)),
    candidateCount: executions.reduce((sum, execution) => sum + execution.result.candidateCount, 0),
    stagedEntries: executions.reduce((sum, execution) => sum + execution.result.stagedEntries, 0),
    writtenDiaryEntries: executions.reduce(
      (sum, execution) => sum + execution.result.writtenDiaryEntries,
      0,
    ),
    replacedDiaryEntries: executions.reduce(
      (sum, execution) => sum + execution.result.replacedDiaryEntries,
      0,
    ),
    batchCount: executions.length,
    batches: executions.map((execution, index) => ({
      batch: index + 1,
      days: execution.result.days.length,
      candidates: execution.result.candidateCount,
      stagedEntries: execution.result.stagedEntries,
    })),
  };
}
