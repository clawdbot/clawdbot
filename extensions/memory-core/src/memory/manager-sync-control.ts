// Memory Core plugin module implements manager sync control behavior.
import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type {
  MemorySessionSyncTarget,
  MemorySyncParams,
  MemorySyncProgressUpdate,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

const log = createSubsystemLogger("memory");

export type MemoryReadonlyRecoveryState = {
  closed: boolean;
  db: DatabaseSync;
  vector: {
    dims?: number;
  };
  readonlyRecoveryAttempts: number;
  readonlyRecoverySuccesses: number;
  readonlyRecoveryFailures: number;
  readonlyRecoveryLastError?: string;
  runSync: (params?: {
    reason?: string;
    force?: boolean;
    sessions?: MemorySessionSyncTarget[];
    archiveFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) => Promise<void>;
  openDatabase: () => DatabaseSync;
  closeDatabase: (db: DatabaseSync) => void;
  resetVectorState: () => void;
  ensureSchema: () => void;
  readMeta: () => { vectorDims?: number } | undefined;
};

function isMemoryReadonlyDbError(err: unknown): boolean {
  const readonlyPattern =
    /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
  const messages = new Set<string>();

  const pushValue = (value: unknown): void => {
    if (typeof value !== "string") {
      return;
    }
    const normalized = value.trim();
    if (!normalized) {
      return;
    }
    messages.add(normalized);
  };

  pushValue(formatErrorMessage(err));
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    pushValue(record.message);
    pushValue(record.code);
    pushValue(record.name);
    if (record.cause && typeof record.cause === "object") {
      const cause = record.cause as Record<string, unknown>;
      pushValue(cause.message);
      pushValue(cause.code);
      pushValue(cause.name);
    }
  }

  return [...messages].some((value) => readonlyPattern.test(value));
}

function extractMemoryErrorReason(err: unknown): string {
  if (err instanceof Error && err.message.trim()) {
    return err.message;
  }
  if (err && typeof err === "object") {
    const record = err as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) {
      return record.message;
    }
    if (typeof record.code === "string" && record.code.trim()) {
      return record.code;
    }
  }
  return String(err);
}

export async function runMemorySyncWithReadonlyRecovery(
  state: MemoryReadonlyRecoveryState,
  params?: MemorySyncParams,
): Promise<void> {
  try {
    await state.runSync(params);
  } catch (err) {
    if (!isMemoryReadonlyDbError(err) || state.closed) {
      throw err;
    }
    const reason = extractMemoryErrorReason(err);
    state.readonlyRecoveryAttempts += 1;
    state.readonlyRecoveryLastError = reason;
    log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
    try {
      state.closeDatabase(state.db);
    } catch {}
    const previousVectorDims = state.vector.dims;
    state.db = state.openDatabase();
    state.resetVectorState();
    state.ensureSchema();
    const meta = state.readMeta();
    state.vector.dims = meta?.vectorDims ?? previousVectorDims;
    try {
      await state.runSync(params);
      state.readonlyRecoverySuccesses += 1;
    } catch (retryErr) {
      state.readonlyRecoveryFailures += 1;
      throw retryErr;
    }
  }
}

export function enqueueMemoryTargetedSessionSync(
  state: {
    isClosed: () => boolean;
    getSyncing: () => Promise<void> | null;
    getQueuedArchiveFiles: () => Set<string>;
    getQueuedSessions: () => Map<string, MemorySessionSyncTarget>;
    getQueuedSessionSync: () => Promise<void> | null;
    setQueuedSessionSync: (value: Promise<void> | null) => void;
    sync: (params?: MemorySyncParams) => Promise<void>;
  },
  targets?: Pick<MemorySyncParams, "sessions" | "archiveFiles">,
): Promise<void> {
  const queuedArchiveFiles = state.getQueuedArchiveFiles();
  for (const sessionFile of targets?.archiveFiles ?? []) {
    const trimmed = sessionFile.trim();
    if (trimmed) {
      queuedArchiveFiles.add(trimmed);
    }
  }
  const queuedSessions = state.getQueuedSessions();
  for (const session of targets?.sessions ?? []) {
    const normalized = normalizeQueuedMemorySessionSyncTarget(session);
    if (normalized) {
      queuedSessions.set(memorySessionSyncTargetKey(normalized), normalized);
    }
  }
  if (queuedArchiveFiles.size === 0 && queuedSessions.size === 0) {
    return state.getSyncing() ?? Promise.resolve();
  }
  if (!state.getQueuedSessionSync()) {
    state.setQueuedSessionSync(
      (async () => {
        try {
          await state.getSyncing()?.catch(() => undefined);
          while (
            !state.isClosed() &&
            (state.getQueuedArchiveFiles().size > 0 || state.getQueuedSessions().size > 0)
          ) {
            const pendingArchiveFiles = Array.from(state.getQueuedArchiveFiles());
            const pendingSessions = Array.from(state.getQueuedSessions().values());
            state.getQueuedArchiveFiles().clear();
            state.getQueuedSessions().clear();
            await state.sync({
              reason: "queued-sessions",
              sessions: pendingSessions,
              archiveFiles: pendingArchiveFiles,
            });
          }
        } finally {
          state.setQueuedSessionSync(null);
        }
      })(),
    );
  }
  return state.getQueuedSessionSync() ?? Promise.resolve();
}

function normalizeQueuedMemorySessionSyncTarget(
  target: MemorySessionSyncTarget,
): MemorySessionSyncTarget | null {
  const sessionId = target.sessionId.trim();
  if (!sessionId) {
    return null;
  }
  const agentId = target.agentId?.trim();
  const sessionKey = target.sessionKey?.trim();
  return {
    ...(agentId ? { agentId } : {}),
    sessionId,
    ...(sessionKey ? { sessionKey } : {}),
  };
}

function memorySessionSyncTargetKey(target: MemorySessionSyncTarget): string {
  return [target.agentId ?? "", target.sessionId, target.sessionKey ?? ""].join("\0");
}
