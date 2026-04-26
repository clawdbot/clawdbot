import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { updateSessionStore } from "../config/sessions.js";
import type {
  SessionCompactionCheckpoint,
  SessionCompactionCheckpointReason,
  SessionEntry,
} from "../config/sessions.js";
import { isCompactionCheckpointTranscriptFileName } from "../config/sessions/artifacts.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";

const log = createSubsystemLogger("gateway/session-compaction-checkpoints");
const MAX_COMPACTION_CHECKPOINTS_PER_SESSION = 25;

export type CapturedCompactionCheckpointSnapshot = {
  sessionId: string;
  sessionFile: string;
  leafId: string;
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

export function captureCompactionCheckpointSnapshot(params: {
  sessionManager: Pick<SessionManager, "getLeafId">;
  sessionFile: string;
}): CapturedCompactionCheckpointSnapshot | null {
  const getLeafId =
    params.sessionManager && typeof params.sessionManager.getLeafId === "function"
      ? params.sessionManager.getLeafId.bind(params.sessionManager)
      : null;
  const sessionFile = params.sessionFile.trim();
  if (!getLeafId || !sessionFile) {
    return null;
  }
  const leafId = getLeafId();
  if (!leafId) {
    return null;
  }
  const parsedSessionFile = path.parse(sessionFile);
  const snapshotFile = path.join(
    parsedSessionFile.dir,
    `${parsedSessionFile.name}.checkpoint.${randomUUID()}${parsedSessionFile.ext || ".jsonl"}`,
  );
  try {
    fsSync.copyFileSync(sessionFile, snapshotFile);
  } catch {
    return null;
  }
  let snapshotSession: SessionManager;
  try {
    snapshotSession = SessionManager.open(snapshotFile, path.dirname(snapshotFile));
  } catch {
    try {
      fsSync.unlinkSync(snapshotFile);
    } catch {
      // Best-effort cleanup if the copied transcript cannot be reopened.
    }
    return null;
  }
  const getSessionId =
    snapshotSession && typeof snapshotSession.getSessionId === "function"
      ? snapshotSession.getSessionId.bind(snapshotSession)
      : null;
  if (!getSessionId) {
    return null;
  }
  return {
    sessionId: getSessionId(),
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
