// Gateway session compaction checkpoint manager.
// Captures, trims, forks, and cleans transcript checkpoints around compaction.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  migrateSessionEntries,
  SessionManager,
  type FileEntry as SessionFileEntry,
} from "../agents/sessions/session-manager.js";
import type {
  SessionCompactionCheckpoint,
  SessionCompactionCheckpointReason,
  SessionEntry,
} from "../config/sessions.js";
import { isCompactionCheckpointTranscriptFileName } from "../config/sessions/artifacts.js";
import { readFileRangeAsync } from "../config/sessions/file-range.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  branchSessionFromCompactionCheckpoint,
  loadSessionEntry,
  loadTranscriptEventsSync,
  restoreSessionFromCompactionCheckpoint,
  type SessionCompactionCheckpointMutationResult,
  updateSessionEntry,
} from "../config/sessions/session-accessor.js";
import {
  branchSqliteCompactionCheckpointSession,
  restoreSqliteCompactionCheckpointSession,
} from "../config/sessions/session-accessor.sqlite.js";
import type { SessionTranscriptRuntimeTarget } from "../config/sessions/session-accessor.types.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import { scanSessionTranscriptTree } from "../config/sessions/transcript-tree.js";
import { CURRENT_SESSION_VERSION } from "../config/sessions/version.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildCheckpointSessionResetPatch } from "./session-compaction-checkpoint-entry.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";

const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25;
const MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION = 128 * 1024 * 1024;

export type CapturedCompactionCheckpointSnapshot = {
  sessionId: string;
  sessionFile?: string;
  leafId: string;
  entryId?: string;
};

type SessionLeafState = {
  leafId: string | null;
  entryId: string;
};

type SessionManagerCheckpointView = Pick<SessionManager, "getLeafId"> &
  Partial<Pick<SessionManager, "getEntries" | "getSessionId">>;

export function resolveCompactionCheckpointTranscriptPosition(params: {
  preferredLeafId?: string | null;
  transcriptState?: SessionLeafState | null;
}): { leafId?: string; entryId?: string } {
  const leafId = params.preferredLeafId ?? params.transcriptState?.leafId ?? undefined;
  const entryId = params.transcriptState?.entryId ?? leafId;
  return {
    ...(leafId ? { leafId } : {}),
    ...(entryId ? { entryId } : {}),
  };
}

type ForkedCompactionCheckpointTranscript = {
  sessionId: string;
  sessionFile: string;
};

type CompactionCheckpointForkedTranscript = ForkedCompactionCheckpointTranscript & {
  totalTokens?: number;
};

type CompactionCheckpointTranscriptForkResult =
  | { status: "created"; transcript: CompactionCheckpointForkedTranscript }
  | { status: "missing-boundary" }
  | { status: "failed" };

type CompactionCheckpointSessionMutationResult = SessionCompactionCheckpointMutationResult;

type BranchCheckpointSessionParams = {
  agentId?: string;
  storePath: string;
  sourceKey: string;
  sourceStoreKey?: string;
  nextKey: string;
  checkpointId: string;
};

type RestoreCheckpointSessionParams = {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  sessionStoreKey?: string;
  checkpointId: string;
};

type PersistSessionCompactionCheckpointParams = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  reason: SessionCompactionCheckpointReason;
  snapshot: CapturedCompactionCheckpointSnapshot;
  summary?: string;
  firstKeptEntryId?: string;
  tokensBefore?: number;
  tokensAfter?: number;
  postSessionFile?: string;
  postLeafId?: string;
  postEntryId?: string;
  createdAt?: number;
};

/**
 * Storage boundary for compaction checkpoint capture, persistence, branch,
 * restore, and cleanup operations.
 */
type CompactionCheckpointStore = {
  /** Captures the pre-compaction transcript identity without copying rows/files. */
  captureSnapshot: typeof captureCompactionCheckpointSnapshotAsync;
  /** Persists checkpoint metadata and prunes checkpoint artifacts owned by this store. */
  persistCheckpoint: (
    params: PersistSessionCompactionCheckpointParams,
  ) => Promise<SessionCompactionCheckpoint | null>;
  /** Cleans unpersisted legacy snapshot artifacts after failed persistence. */
  cleanupSnapshot: typeof cleanupCompactionCheckpointSnapshot;
  /**
   * Creates a checkpoint branch and records its session entry in one logical
   * store mutation.
   */
  branchCheckpointSession: (
    params: BranchCheckpointSessionParams,
  ) => Promise<CompactionCheckpointSessionMutationResult>;
  /**
   * Restores a checkpoint and replaces the current session entry in one logical
   * store mutation.
   */
  restoreCheckpointSession: (
    params: RestoreCheckpointSessionParams,
  ) => Promise<CompactionCheckpointSessionMutationResult>;
};

function checkpointSnapshotPath(checkpoint: SessionCompactionCheckpoint): string | undefined {
  return checkpoint.preCompaction.sessionFile?.trim() || undefined;
}

function checkpointSnapshotBytes(
  checkpoint: SessionCompactionCheckpoint,
  snapshotBytesByPath: ReadonlyMap<string, number>,
): number {
  const sessionFile = checkpointSnapshotPath(checkpoint);
  if (!sessionFile) {
    return 0;
  }
  const bytes = snapshotBytesByPath.get(sessionFile);
  return typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
}

function trimSessionCheckpoints(
  checkpoints: SessionCompactionCheckpoint[] | undefined,
  snapshotBytesByPath: ReadonlyMap<string, number> = new Map(),
): {
  kept: SessionCompactionCheckpoint[] | undefined;
  removed: SessionCompactionCheckpoint[];
} {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { kept: undefined, removed: [] };
  }
  const countTrimmed = checkpoints.slice(-MAX_COMPACTION_CHECKPOINTS_PER_SESSION);
  const countRemoved = checkpoints.slice(0, Math.max(0, checkpoints.length - countTrimmed.length));
  const keptNewestFirst: SessionCompactionCheckpoint[] = [];
  const byteRemovedNewestFirst: SessionCompactionCheckpoint[] = [];
  let retainedBytes = 0;
  for (let index = countTrimmed.length - 1; index >= 0; index -= 1) {
    const checkpoint = countTrimmed[index];
    if (!checkpoint) {
      continue;
    }
    const checkpointBytes = checkpointSnapshotBytes(checkpoint, snapshotBytesByPath);
    const keepNewestCheckpoint = keptNewestFirst.length === 0;
    if (
      keepNewestCheckpoint ||
      retainedBytes + checkpointBytes <= MAX_COMPACTION_CHECKPOINT_RETAINED_BYTES_PER_SESSION
    ) {
      keptNewestFirst.push(checkpoint);
      retainedBytes += checkpointBytes;
    } else {
      byteRemovedNewestFirst.push(checkpoint);
    }
  }
  const kept = keptNewestFirst.toReversed();
  return {
    kept: kept.length > 0 ? kept : undefined,
    removed: [...countRemoved, ...byteRemovedNewestFirst.toReversed()],
  };
}

function sessionStoreCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return Array.isArray(entry?.compactionCheckpoints) ? [...entry.compactionCheckpoints] : [];
}

async function statCheckpointSnapshotBytes(
  checkpoints: readonly SessionCompactionCheckpoint[],
): Promise<Map<string, number>> {
  const bytesByPath = new Map<string, number>();
  await Promise.all(
    checkpoints.map(async (checkpoint) => {
      const sessionFile = checkpointSnapshotPath(checkpoint);
      if (!sessionFile || bytesByPath.has(sessionFile)) {
        return;
      }
      try {
        const stat = await fs.stat(sessionFile);
        bytesByPath.set(sessionFile, stat.isFile() ? stat.size : 0);
      } catch {
        bytesByPath.set(sessionFile, 0);
      }
    }),
  );
  return bytesByPath;
}

/** Resolve the stored checkpoint reason from compaction trigger state. */
export function resolveSessionCompactionCheckpointReason(params: {
  trigger?: "budget" | "overflow" | "manual";
  timedOut?: boolean;
}): SessionCompactionCheckpointReason {
  if (params.trigger === "manual") {
    return "manual";
  }
  if (params.timedOut) {
    return "timeout-retry";
  }
  if (params.trigger === "overflow") {
    return "overflow-retry";
  }
  return "auto-threshold";
}

const SESSION_HEADER_READ_MAX_BYTES = 64 * 1024;
const SESSION_TAIL_READ_INITIAL_BYTES = 64 * 1024;

async function readSessionHeaderFromTranscriptAsync(
  sessionFile: string,
): Promise<{ id: string; cwd?: string } | null> {
  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fileHandle = await fs.open(sessionFile, "r");
    const buffer = await readFileRangeAsync(fileHandle, 0, SESSION_HEADER_READ_MAX_BYTES);
    if (buffer.length <= 0) {
      return null;
    }
    const chunk = buffer.toString("utf-8");
    const firstLine = chunk
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0);
    if (!firstLine) {
      return null;
    }
    const parsed = JSON.parse(firstLine) as { type?: unknown; id?: unknown; cwd?: unknown };
    if (parsed.type !== "session" || typeof parsed.id !== "string" || !parsed.id.trim()) {
      return null;
    }
    return {
      id: parsed.id.trim(),
      ...(typeof parsed.cwd === "string" && parsed.cwd.trim() ? { cwd: parsed.cwd } : {}),
    };
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }
  }
}

async function readSessionIdFromTranscriptHeaderAsync(sessionFile: string): Promise<string | null> {
  return (await readSessionHeaderFromTranscriptAsync(sessionFile))?.id ?? null;
}

function parseTranscriptLine(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readTranscriptEntriesForForkAsync(params: {
  sessionFile: string;
  stopAfterEntryId?: string;
}): Promise<SessionFileEntry[] | null> {
  const entries: SessionFileEntry[] = [];
  const stopAfterEntryId = params.stopAfterEntryId?.trim();
  let foundStopEntry = false;
  try {
    for await (const line of streamSessionTranscriptLines(params.sessionFile)) {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          continue;
        }
        entries.push(parsed as SessionFileEntry);
        if (
          stopAfterEntryId &&
          (parsed as { type?: unknown; id?: unknown }).type !== "session" &&
          (parsed as { id?: unknown }).id === stopAfterEntryId
        ) {
          foundStopEntry = true;
          break;
        }
      } catch {
        // Match session runtime's loader: malformed JSONL entries are ignored.
      }
    }
  } catch {
    return null;
  }
  const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
  if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
    return null;
  }
  if (stopAfterEntryId && !foundStopEntry) {
    return null;
  }
  return entries;
}

function trimTranscriptEntriesThroughLeaf(
  entries: SessionFileEntry[],
  leafId: string | undefined,
): SessionFileEntry[] | null {
  const normalizedLeafId = leafId?.trim();
  if (!normalizedLeafId) {
    return entries;
  }
  const leafIndex = entries.findIndex(
    (entry, index) => index > 0 && (entry as { id?: unknown }).id === normalizedLeafId,
  );
  if (leafIndex < 1) {
    return null;
  }
  return entries.slice(0, leafIndex + 1);
}

export async function readSessionLeafStateFromTranscriptAsync(
  sessionFile: string,
  maxBytes = MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES,
): Promise<{ entryId: string; leafId: string | null } | null> {
  const sqliteMarker = parseSqliteSessionFileMarker(sessionFile);
  if (sqliteMarker) {
    const records = loadTranscriptEventsSync(sqliteMarker).filter(
      (event): event is Record<string, unknown> =>
        Boolean(event) && typeof event === "object" && !Array.isArray(event),
    );
    return readSessionLeafStateFromRecords(records);
  }

  let fileHandle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    fileHandle = await fs.open(sessionFile, "r");
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return null;
    }

    const requestedMaxBytes = Number.isFinite(maxBytes)
      ? Math.max(1024, Math.floor(maxBytes))
      : MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES;
    const maxReadableBytes = Math.min(stat.size, requestedMaxBytes);
    let readLength = Math.min(maxReadableBytes, SESSION_TAIL_READ_INITIAL_BYTES);
    while (readLength > 0) {
      const readStart = Math.max(0, stat.size - readLength);
      const buffer = await readFileRangeAsync(fileHandle, readStart, readLength);
      const lines = buffer.toString("utf-8").split(/\r?\n/);
      // If we did not read from the beginning, the first line may be a suffix of
      // a larger JSONL entry. Ignore it and grow the window if no complete entry
      // is found.
      const candidateLines = readStart > 0 ? lines.slice(1) : lines;
      const records: Record<string, unknown>[] = [];
      let latestEntryId: string | undefined;
      for (const candidateLine of candidateLines) {
        const line = candidateLine.trim();
        if (!line) {
          continue;
        }
        const parsed = parseTranscriptLine(line);
        if (!parsed) {
          continue;
        }
        records.push(parsed);
        if (parsed.type === "session") {
          continue;
        }
        const entryId = typeof parsed.id === "string" ? parsed.id.trim() : "";
        if (entryId) {
          latestEntryId = entryId;
        }
      }
      const tree = scanSessionTranscriptTree(records);
      if (latestEntryId && tree.hasLeafUpdate && (!tree.hasInvalidLeafControl || readStart === 0)) {
        return { entryId: latestEntryId, leafId: tree.leafId };
      }

      if (readStart === 0) {
        return null;
      }
      const nextReadLength = Math.min(maxReadableBytes, readLength * 2);
      if (nextReadLength === readLength) {
        // The selected leaf can precede the bounded window on very large
        // transcripts. Keep a stable raw truncation point; reopening the full
        // fork will resolve its actual active branch.
        return latestEntryId ? { entryId: latestEntryId, leafId: latestEntryId } : null;
      }
      readLength = nextReadLength;
    }
  } catch {
    return null;
  } finally {
    if (fileHandle) {
      await fileHandle.close().catch(() => undefined);
    }
  }
  return null;
}

function readSessionLeafStateFromRecords(
  records: readonly Record<string, unknown>[],
): { entryId: string; leafId: string | null } | null {
  let latestEntryId: string | undefined;
  for (const record of records) {
    if (record.type === "session") {
      continue;
    }
    const entryId = typeof record.id === "string" ? record.id.trim() : "";
    if (entryId) {
      latestEntryId = entryId;
    }
  }
  if (!latestEntryId) {
    return null;
  }
  const tree = scanSessionTranscriptTree(records);
  return { entryId: latestEntryId, leafId: tree.leafId };
}

async function forkCompactionCheckpointTranscriptAsync(params: {
  sourceFile: string;
  sourceLeafId?: string;
  targetCwd?: string;
  sessionDir?: string;
}): Promise<ForkedCompactionCheckpointTranscript | null> {
  const sourceFile = params.sourceFile.trim();
  if (!sourceFile) {
    return null;
  }
  const sourceHeader = await readSessionHeaderFromTranscriptAsync(sourceFile);
  if (!sourceHeader) {
    return null;
  }
  const entries = await readTranscriptEntriesForForkAsync({
    sessionFile: sourceFile,
    stopAfterEntryId: params.sourceLeafId,
  });
  if (!entries) {
    return null;
  }
  migrateSessionEntries(entries);
  const forkEntries = trimTranscriptEntriesThroughLeaf(entries, params.sourceLeafId);
  if (!forkEntries) {
    return null;
  }

  const targetCwd = params.targetCwd ?? sourceHeader.cwd ?? process.cwd();
  const sessionDir = params.sessionDir ?? path.dirname(sourceFile);
  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const fileTimestamp = timestamp.replace(/[:.]/g, "-");
  const sessionFile = path.join(sessionDir, `${fileTimestamp}_${sessionId}.jsonl`);
  const header = {
    type: "session",
    version: CURRENT_SESSION_VERSION,
    id: sessionId,
    timestamp,
    cwd: targetCwd,
    parentSession: sourceFile,
  };

  try {
    await fs.mkdir(sessionDir, { recursive: true });
    const lines = [JSON.stringify(header)];
    for (const entry of forkEntries) {
      if ((entry as { type?: unknown }).type !== "session") {
        lines.push(JSON.stringify(entry));
      }
    }
    await fs.writeFile(sessionFile, `${lines.join("\n")}\n`, { encoding: "utf-8", flag: "wx" });
    return { sessionId, sessionFile };
  } catch {
    try {
      await fs.unlink(sessionFile);
    } catch {
      // Best-effort cleanup for partial fork files.
    }
    return null;
  }
}

function resolveCheckpointTranscriptForkSource(
  checkpoint: SessionCompactionCheckpoint,
): { sourceFile: string; sourceLeafId?: string; totalTokens?: number } | null {
  const preCompactionFile = checkpoint.preCompaction.sessionFile?.trim();
  if (preCompactionFile) {
    return {
      sourceFile: preCompactionFile,
      sourceLeafId: checkpoint.preCompaction.entryId ?? checkpoint.preCompaction.leafId,
      totalTokens: checkpoint.tokensBefore,
    };
  }

  const postCompactionFile = checkpoint.postCompaction.sessionFile?.trim();
  if (!postCompactionFile) {
    return null;
  }
  const postCompactionLeafId =
    checkpoint.postCompaction.entryId ?? checkpoint.postCompaction.leafId;
  if (!postCompactionLeafId) {
    return null;
  }
  return {
    sourceFile: postCompactionFile,
    sourceLeafId: postCompactionLeafId,
    totalTokens: checkpoint.tokensAfter,
  };
}

async function forkCheckpointTranscriptFromStoredBoundary(params: {
  checkpoint: SessionCompactionCheckpoint;
  sessionDir?: string;
  targetCwd?: string;
}): Promise<CompactionCheckpointTranscriptForkResult> {
  const forkSource = resolveCheckpointTranscriptForkSource(params.checkpoint);
  if (!forkSource) {
    return { status: "missing-boundary" };
  }
  const forked = await forkCompactionCheckpointTranscriptAsync({
    sourceFile: forkSource.sourceFile,
    sourceLeafId: forkSource.sourceLeafId,
    sessionDir: params.sessionDir ?? path.dirname(forkSource.sourceFile),
    ...(params.targetCwd ? { targetCwd: params.targetCwd } : {}),
  });
  if (!forked) {
    return { status: "failed" };
  }
  return {
    status: "created",
    transcript: {
      ...forked,
      ...(typeof forkSource.totalTokens === "number"
        ? { totalTokens: forkSource.totalTokens }
        : {}),
    },
  };
}

function cloneCheckpointSessionEntry(params: {
  currentEntry: SessionEntry;
  nextSessionId: string;
  nextSessionFile: string;
  label?: string;
  parentSessionKey?: string;
  totalTokens?: number;
  preserveCompactionCheckpoints?: boolean;
  preserveManagementState?: boolean;
}): SessionEntry {
  return {
    ...params.currentEntry,
    ...buildCheckpointSessionResetPatch({
      entry: params.currentEntry,
      sessionId: params.nextSessionId,
      sessionFile: params.nextSessionFile,
    }),
    inputTokens: undefined,
    outputTokens: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
    estimatedCostUsd: undefined,
    totalTokens:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? params.totalTokens
        : undefined,
    totalTokensFresh:
      typeof params.totalTokens === "number" && Number.isFinite(params.totalTokens)
        ? true
        : undefined,
    label: params.label ?? params.currentEntry.label,
    parentSessionKey: params.parentSessionKey ?? params.currentEntry.parentSessionKey,
    archivedAt: params.preserveManagementState ? params.currentEntry.archivedAt : undefined,
    pinnedAt: params.preserveManagementState ? params.currentEntry.pinnedAt : undefined,
    icon: params.preserveManagementState ? params.currentEntry.icon : undefined,
    compactionCheckpoints: params.preserveCompactionCheckpoints
      ? params.currentEntry.compactionCheckpoints
      : undefined,
  };
}

async function branchCheckpointSessionFromStoredBoundary(
  params: BranchCheckpointSessionParams,
): Promise<CompactionCheckpointSessionMutationResult> {
  if (
    shouldRouteCheckpointSessionMutationToSqlite({
      checkpointId: params.checkpointId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sourceStoreKey ?? params.sourceKey,
      storePath: params.storePath,
    })
  ) {
    return await branchSqliteCompactionCheckpointSession({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      storePath: params.storePath,
      sourceKey: params.sourceKey,
      nextKey: params.nextKey,
      checkpointId: params.checkpointId,
      ...(params.sourceStoreKey ? { sourceStoreKey: params.sourceStoreKey } : {}),
    });
  }
  return await branchSessionFromCompactionCheckpoint({
    storePath: params.storePath,
    sourceKey: params.sourceKey,
    nextKey: params.nextKey,
    checkpointId: params.checkpointId,
    ...(params.sourceStoreKey ? { sourceStoreKey: params.sourceStoreKey } : {}),
    forkTranscriptFromCheckpoint: async (checkpoint) =>
      await forkCheckpointTranscriptFromStoredBoundary({ checkpoint }),
    buildEntry: ({ currentEntry, forkedTranscript }) => {
      const label = currentEntry.label?.trim()
        ? `${currentEntry.label.trim()} (checkpoint)`
        : "Checkpoint branch";
      return cloneCheckpointSessionEntry({
        currentEntry,
        nextSessionId: forkedTranscript.sessionId,
        nextSessionFile: forkedTranscript.sessionFile,
        label,
        parentSessionKey: params.sourceKey,
        totalTokens: forkedTranscript.totalTokens,
      });
    },
  });
}

async function restoreCheckpointSessionFromStoredBoundary(
  params: RestoreCheckpointSessionParams,
): Promise<CompactionCheckpointSessionMutationResult> {
  if (
    shouldRouteCheckpointSessionMutationToSqlite({
      checkpointId: params.checkpointId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      sessionKey: params.sessionStoreKey ?? params.sessionKey,
      storePath: params.storePath,
    })
  ) {
    return await restoreSqliteCompactionCheckpointSession({
      ...(params.agentId ? { agentId: params.agentId } : {}),
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      checkpointId: params.checkpointId,
      ...(params.sessionStoreKey ? { sessionStoreKey: params.sessionStoreKey } : {}),
    });
  }
  return await restoreSessionFromCompactionCheckpoint({
    storePath: params.storePath,
    sessionKey: params.sessionKey,
    checkpointId: params.checkpointId,
    ...(params.sessionStoreKey ? { sessionStoreKey: params.sessionStoreKey } : {}),
    forkTranscriptFromCheckpoint: async (checkpoint) =>
      await forkCheckpointTranscriptFromStoredBoundary({ checkpoint }),
    buildEntry: ({ currentEntry, forkedTranscript }) =>
      cloneCheckpointSessionEntry({
        currentEntry,
        nextSessionId: forkedTranscript.sessionId,
        nextSessionFile: forkedTranscript.sessionFile,
        totalTokens: forkedTranscript.totalTokens,
        preserveCompactionCheckpoints: true,
        preserveManagementState: true,
      }),
  });
}

function shouldRouteCheckpointSessionMutationToSqlite(params: {
  agentId?: string;
  checkpointId: string;
  sessionKey: string;
  storePath: string;
}): boolean {
  const entry = loadSessionEntry({
    ...(params.agentId ? { agentId: params.agentId } : {}),
    sessionKey: params.sessionKey,
    storePath: params.storePath,
  });
  if (!entry) {
    return false;
  }
  return true;
}

/**
 * Creates the current file-backed compaction checkpoint domain store.
 *
 * The branch/restore operations own the transcript fork plus session entry
 * update so a SQLite implementation can copy transcript rows and update
 * `session_nodes.entry_json` inside one write transaction.
 */
export function createFileBackedCompactionCheckpointStore(): CompactionCheckpointStore {
  return {
    captureSnapshot: captureCompactionCheckpointSnapshotAsync,
    persistCheckpoint: persistSessionCompactionCheckpoint,
    cleanupSnapshot: cleanupCompactionCheckpointSnapshot,
    branchCheckpointSession: branchCheckpointSessionFromStoredBoundary,
    restoreCheckpointSession: restoreCheckpointSessionFromStoredBoundary,
  };
}

/**
 * Capture the stable pre-compaction identity without duplicating the transcript.
 * Branch/restore uses the compacted successor transcript, while legacy
 * checkpoints that already have a snapshot file keep working.
 */
async function captureCompactionCheckpointSnapshotAsync(params: {
  sessionManager?: SessionManagerCheckpointView;
  sessionFile: string;
  sessionTarget?: SessionTranscriptRuntimeTarget;
  maxBytes?: number;
}): Promise<CapturedCompactionCheckpointSnapshot | null> {
  const getLeafId =
    params.sessionManager && typeof params.sessionManager.getLeafId === "function"
      ? params.sessionManager.getLeafId.bind(params.sessionManager)
      : null;
  const sessionFile = params.sessionFile.trim();
  if (!sessionFile || (params.sessionManager && !getLeafId)) {
    return null;
  }
  const liveLeafId = getLeafId ? getLeafId() : undefined;
  if (getLeafId && !liveLeafId) {
    return null;
  }
  const maxBytes = params.maxBytes ?? MAX_COMPACTION_CHECKPOINT_LEAF_SCAN_BYTES;
  const sqliteTarget = params.sessionTarget ?? parseSqliteSessionFileMarker(sessionFile);
  if (sqliteTarget) {
    if (typeof params.sessionManager?.getEntries !== "function") {
      return null;
    }
    const entryRecords = params.sessionManager.getEntries() as unknown as Record<string, unknown>[];
    const transcriptState = readSessionLeafStateFromRecords(entryRecords);
    const position = resolveCompactionCheckpointTranscriptPosition({
      preferredLeafId: liveLeafId,
      transcriptState,
    });
    const leafId = position.leafId;
    if (!leafId) {
      return null;
    }
    return {
      sessionId:
        typeof params.sessionManager.getSessionId === "function"
          ? params.sessionManager.getSessionId()
          : sqliteTarget.sessionId,
      leafId,
      ...(position.entryId ? { entryId: position.entryId } : {}),
    };
  }
  const sessionId = await readSessionIdFromTranscriptHeaderAsync(sessionFile);
  const transcriptState = await readSessionLeafStateFromTranscriptAsync(sessionFile, maxBytes);
  const position = resolveCompactionCheckpointTranscriptPosition({
    preferredLeafId: liveLeafId,
    transcriptState,
  });
  const leafId = position.leafId;
  if (!sessionId || !leafId) {
    return null;
  }
  return {
    sessionId,
    leafId,
    ...(position.entryId ? { entryId: position.entryId } : {}),
  };
}

async function cleanupCompactionCheckpointSnapshot(
  snapshot: CapturedCompactionCheckpointSnapshot | null | undefined,
): Promise<void> {
  if (!snapshot?.sessionFile) {
    return;
  }
  try {
    await fs.unlink(snapshot.sessionFile);
  } catch {
    // Best-effort cleanup; retained snapshots are harmless and easier to debug.
  }
}

async function cleanupTrimmedCompactionCheckpointFiles(params: {
  removed: SessionCompactionCheckpoint[];
  retained: SessionCompactionCheckpoint[] | undefined;
  artifactDir?: string;
}): Promise<void> {
  if (params.removed.length === 0 || !params.artifactDir) {
    return;
  }
  const artifactDir = path.resolve(params.artifactDir);
  const retainedPaths = new Set(
    (params.retained ?? [])
      .map((checkpoint) => checkpoint.preCompaction.sessionFile?.trim())
      .filter((filePath): filePath is string => Boolean(filePath)),
  );
  for (const checkpoint of params.removed) {
    const sessionFile = checkpoint.preCompaction.sessionFile?.trim();
    if (!sessionFile || retainedPaths.has(sessionFile)) {
      continue;
    }
    const resolvedSessionFile = path.resolve(sessionFile);
    if (
      path.dirname(resolvedSessionFile) !== artifactDir ||
      !isCompactionCheckpointTranscriptFileName(path.basename(resolvedSessionFile))
    ) {
      continue;
    }
    try {
      await fs.unlink(resolvedSessionFile);
    } catch {
      // Best-effort cleanup; disk budget can still collect old checkpoint artifacts.
    }
  }
}

async function persistSessionCompactionCheckpoint(
  params: PersistSessionCompactionCheckpointParams,
): Promise<SessionCompactionCheckpoint | null> {
  const snapshotSessionFile = params.snapshot.sessionFile?.trim();
  const postSessionFile = params.postSessionFile?.trim();
  const snapshotSqliteMarker = parseSqliteSessionFileMarker(snapshotSessionFile);
  const postSqliteMarker = parseSqliteSessionFileMarker(postSessionFile);
  const snapshotArtifactFile = snapshotSqliteMarker ? undefined : snapshotSessionFile;
  const postArtifactFile = postSqliteMarker ? undefined : postSessionFile;
  const postSourceLeafId = params.postEntryId?.trim() || params.postLeafId?.trim();
  if (!snapshotArtifactFile && !postSourceLeafId) {
    log.warn("skipping compaction checkpoint persist: missing stable fork source", {
      sessionKey: params.sessionKey,
    });
    return null;
  }

  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.sessionKey,
  });
  const createdAt = params.createdAt ?? Date.now();
  const checkpoint: SessionCompactionCheckpoint = {
    checkpointId: randomUUID(),
    sessionKey: target.canonicalKey,
    sessionId: params.sessionId,
    createdAt,
    reason: params.reason,
    ...(typeof params.tokensBefore === "number" ? { tokensBefore: params.tokensBefore } : {}),
    ...(typeof params.tokensAfter === "number" ? { tokensAfter: params.tokensAfter } : {}),
    ...(params.summary?.trim() ? { summary: params.summary.trim() } : {}),
    ...(params.firstKeptEntryId?.trim()
      ? { firstKeptEntryId: params.firstKeptEntryId.trim() }
      : {}),
    preCompaction: {
      sessionId: params.snapshot.sessionId,
      ...(snapshotArtifactFile ? { sessionFile: snapshotArtifactFile } : {}),
      leafId: params.snapshot.leafId,
      ...(params.snapshot.entryId?.trim() ? { entryId: params.snapshot.entryId.trim() } : {}),
    },
    postCompaction: {
      sessionId: params.sessionId,
      ...(postArtifactFile ? { sessionFile: postArtifactFile } : {}),
      ...(params.postLeafId?.trim() ? { leafId: params.postLeafId.trim() } : {}),
      ...(params.postEntryId?.trim() ? { entryId: params.postEntryId.trim() } : {}),
    },
  };

  let trimmedCheckpoints:
    | {
        kept: SessionCompactionCheckpoint[] | undefined;
        removed: SessionCompactionCheckpoint[];
      }
    | undefined;
  let stored = false;
  const updatedEntry = await updateSessionEntry(
    {
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
    },
    async (existing) => {
      if (!existing.sessionId) {
        return null;
      }
      const checkpoints = sessionStoreCheckpoints(existing);
      checkpoints.push(checkpoint);
      const snapshotBytesByPath = await statCheckpointSnapshotBytes(checkpoints);
      trimmedCheckpoints = trimSessionCheckpoints(checkpoints, snapshotBytesByPath);
      stored = true;
      return {
        updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
        compactionCheckpoints: trimmedCheckpoints.kept,
      };
    },
  );

  if (!updatedEntry || !stored) {
    log.warn("skipping compaction checkpoint persist: session not found", {
      sessionKey: params.sessionKey,
    });
    return null;
  }
  const checkpointArtifactFile = snapshotArtifactFile || postArtifactFile || "";
  await cleanupTrimmedCompactionCheckpointFiles({
    removed: trimmedCheckpoints?.removed ?? [],
    retained: trimmedCheckpoints?.kept,
    ...(checkpointArtifactFile ? { artifactDir: path.dirname(checkpointArtifactFile) } : {}),
  });
  return checkpoint;
}

export function listSessionCompactionCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return sessionStoreCheckpoints(entry).toSorted((a, b) => b.createdAt - a.createdAt);
}

export function getSessionCompactionCheckpoint(params: {
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined;
  checkpointId: string;
}): SessionCompactionCheckpoint | undefined {
  const checkpointId = params.checkpointId.trim();
  if (!checkpointId) {
    return undefined;
  }
  return listSessionCompactionCheckpoints(params.entry).find(
    (checkpoint) => checkpoint.checkpointId === checkpointId,
  );
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
