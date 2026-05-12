import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  CURRENT_SESSION_VERSION,
  migrateSessionEntries,
  SessionManager,
  type FileEntry as PiSessionFileEntry,
} from "@earendil-works/pi-coding-agent";
import { updateSessionStore } from "../config/sessions.js";
import type {
  SessionCompactionCheckpoint,
  SessionCompactionCheckpointReason,
  SessionEntry,
} from "../config/sessions.js";
import { isCompactionCheckpointTranscriptFileName } from "../config/sessions/artifacts.js";
import { streamSessionTranscriptLines } from "../config/sessions/transcript-stream.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";

const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25;
export const MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES = 64 * 1024 * 1024;

export type CapturedCompactionCheckpointSnapshot = {
  sessionId: string;
  sessionFile: string;
  leafId: string;
};

type ForkedCompactionCheckpointTranscript = {
  sessionId: string;
  sessionFile: string;
};

function trimSessionCheckpoints(checkpoints: SessionCompactionCheckpoint[] | undefined): {
  kept: SessionCompactionCheckpoint[] | undefined;
  removed: SessionCompactionCheckpoint[];
} {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) {
    return { kept: undefined, removed: [] };
  }
  const kept = checkpoints.slice(-MAX_COMPACTION_CHECKPOINTS_PER_SESSION);
  return {
    kept,
    removed: checkpoints.slice(0, Math.max(0, checkpoints.length - kept.length)),
  };
}

function sessionStoreCheckpoints(
  entry: Pick<SessionEntry, "compactionCheckpoints"> | undefined,
): SessionCompactionCheckpoint[] {
  return Array.isArray(entry?.compactionCheckpoints) ? [...entry.compactionCheckpoints] : [];
}

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

type AsyncTranscriptFileHandle = Awaited<ReturnType<typeof fs.open>>;

async function readFileRangeAsync(
  fileHandle: AsyncTranscriptFileHandle,
  position: number,
  length: number,
): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const { bytesRead } = await fileHandle.read(buffer, offset, length - offset, position + offset);
    if (bytesRead <= 0) {
      break;
    }
    offset += bytesRead;
  }
  return offset === length ? buffer : buffer.subarray(0, offset);
}

async function readSessionHeaderFromTranscriptAsync(
  sessionFile: string,
): Promise<{ id: string; cwd?: string } | null> {
  let fileHandle: AsyncTranscriptFileHandle | undefined;
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

function parseTranscriptLineId(
  line: string,
): { kind: "session" } | { kind: "entry"; id: string } | null {
  try {
    const parsed = JSON.parse(line) as { type?: unknown; id?: unknown };
    if (parsed.type === "session") {
      return { kind: "session" };
    }
    if (typeof parsed.id === "string" && parsed.id.trim()) {
      return { kind: "entry", id: parsed.id.trim() };
    }
  } catch {
    return null;
  }
  return null;
}

async function readTranscriptEntriesForForkAsync(
  sessionFile: string,
): Promise<PiSessionFileEntry[] | null> {
  const entries: PiSessionFileEntry[] = [];
  try {
    for await (const line of streamSessionTranscriptLines(sessionFile)) {
      try {
        entries.push(JSON.parse(line) as PiSessionFileEntry);
      } catch {
        // Match pi-coding-agent's loader: malformed JSONL entries are ignored.
      }
    }
  } catch {
    return null;
  }
  const firstEntry = entries[0] as { type?: unknown; id?: unknown } | undefined;
  if (firstEntry?.type !== "session" || typeof firstEntry.id !== "string") {
    return null;
  }
  return entries;
}

export async function readSessionLeafIdFromTranscriptAsync(
  sessionFile: string,
  maxBytes = MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES,
): Promise<string | null> {
  let fileHandle: AsyncTranscriptFileHandle | undefined;
  try {
    fileHandle = await fs.open(sessionFile, "r");
    const stat = await fileHandle.stat();
    if (!stat.isFile() || stat.size <= 0) {
      return null;
    }

    const requestedMaxBytes = Number.isFinite(maxBytes)
      ? Math.max(1024, Math.floor(maxBytes))
      : MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES;
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
      for (let i = candidateLines.length - 1; i >= 0; i -= 1) {
        const line = candidateLines[i]?.trim();
        if (!line) {
          continue;
        }
        const parsed = parseTranscriptLineId(line);
        if (!parsed) {
          continue;
        }
        if (parsed.kind === "session") {
          return null;
        }
        return parsed.id;
      }

      if (readStart === 0) {
        return null;
      }
      const nextReadLength = Math.min(maxReadableBytes, readLength * 2);
      if (nextReadLength === readLength) {
        return null;
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

export async function forkCompactionCheckpointTranscriptAsync(params: {
  sourceFile: string;
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
  const entries = await readTranscriptEntriesForForkAsync(sourceFile);
  if (!entries) {
    return null;
  }
  migrateSessionEntries(entries);

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
    for (const entry of entries) {
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

/**
 * Capture a bounded pre-compaction transcript snapshot without blocking the
 * Gateway event loop on synchronous file reads/copies.
 */
export async function captureCompactionCheckpointSnapshotAsync(params: {
  sessionManager?: Pick<SessionManager, "getLeafId">;
  sessionFile: string;
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
  const maxBytes = params.maxBytes ?? MAX_COMPACTION_CHECKPOINT_SNAPSHOT_BYTES;
  try {
    const stat = await fs.stat(sessionFile);
    if (!stat.isFile() || stat.size > maxBytes) {
      return null;
    }
  } catch {
    return null;
  }
  const parsedSessionFile = path.parse(sessionFile);
  const snapshotFile = path.join(
    parsedSessionFile.dir,
    `${parsedSessionFile.name}.checkpoint.${randomUUID()}${parsedSessionFile.ext || ".jsonl"}`,
  );
  try {
    await fs.copyFile(sessionFile, snapshotFile);
  } catch {
    return null;
  }
  const sessionId = await readSessionIdFromTranscriptHeaderAsync(snapshotFile);
  const leafId = liveLeafId ?? (await readSessionLeafIdFromTranscriptAsync(snapshotFile, maxBytes));
  if (!sessionId || !leafId) {
    try {
      await fs.unlink(snapshotFile);
    } catch {
      // Best-effort cleanup if the copied transcript cannot be validated.
    }
    return null;
  }
  return {
    sessionId,
    sessionFile: snapshotFile,
    leafId,
  };
}

export async function cleanupCompactionCheckpointSnapshot(
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
  currentSnapshotFile: string;
}): Promise<void> {
  if (params.removed.length === 0) {
    return;
  }
  const retainedPaths = new Set(
    (params.retained ?? [])
      .map((checkpoint) => checkpoint.preCompaction.sessionFile?.trim())
      .filter((filePath): filePath is string => Boolean(filePath)),
  );
  const snapshotDir = path.resolve(path.dirname(params.currentSnapshotFile));
  for (const checkpoint of params.removed) {
    const sessionFile = checkpoint.preCompaction.sessionFile?.trim();
    if (!sessionFile || retainedPaths.has(sessionFile)) {
      continue;
    }
    const resolvedSessionFile = path.resolve(sessionFile);
    if (
      path.dirname(resolvedSessionFile) !== snapshotDir ||
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

export async function persistSessionCompactionCheckpoint(params: {
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
}): Promise<SessionCompactionCheckpoint | null> {
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
      sessionFile: params.snapshot.sessionFile,
      leafId: params.snapshot.leafId,
    },
    postCompaction: {
      sessionId: params.sessionId,
      ...(params.postSessionFile?.trim() ? { sessionFile: params.postSessionFile.trim() } : {}),
      ...(params.postLeafId?.trim() ? { leafId: params.postLeafId.trim() } : {}),
      ...(params.postEntryId?.trim() ? { entryId: params.postEntryId.trim() } : {}),
    },
  };

  let stored = false;
  let trimmedCheckpoints:
    | {
        kept: SessionCompactionCheckpoint[] | undefined;
        removed: SessionCompactionCheckpoint[];
      }
    | undefined;
  await updateSessionStore(target.storePath, (store) => {
    const existing = store[target.canonicalKey];
    if (!existing?.sessionId) {
      return;
    }
    const checkpoints = sessionStoreCheckpoints(existing);
    checkpoints.push(checkpoint);
    trimmedCheckpoints = trimSessionCheckpoints(checkpoints);
    store[target.canonicalKey] = {
      ...existing,
      updatedAt: Math.max(existing.updatedAt ?? 0, createdAt),
      compactionCheckpoints: trimmedCheckpoints.kept,
    };
    stored = true;
  });

  if (!stored) {
    log.warn("skipping compaction checkpoint persist: session not found", {
      sessionKey: params.sessionKey,
    });
    return null;
  }
  await cleanupTrimmedCompactionCheckpointFiles({
    removed: trimmedCheckpoints?.removed ?? [],
    retained: trimmedCheckpoints?.kept,
    currentSnapshotFile: params.snapshot.sessionFile,
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
