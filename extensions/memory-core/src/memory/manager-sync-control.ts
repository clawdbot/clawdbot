import type { DatabaseSync } from "node:sqlite";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createSubsystemLogger,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import type { MemorySyncProgressUpdate } from "openclaw/plugin-sdk/memory-core-host-engine-storage";

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
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) => Promise<void>;
  openDatabase: () => DatabaseSync;
  closeDatabase: (db: DatabaseSync) => void;
  resetVectorState: () => void;
  ensureSchema: () => void;
  readMeta: () => { vectorDims?: number } | undefined;
};

export function isMemoryReadonlyDbError(err: unknown): boolean {
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

export function extractMemoryErrorReason(err: unknown): string {
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
  params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  },
): Promise<void> {
  try {
    await state.runSync(params);
    return;
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
    getQueuedSessionFiles: () => Set<string>;
    getQueuedSessionSync: () => Promise<void> | null;
    setQueuedSessionSync: (value: Promise<void> | null) => void;
    sync: (params?: {
      reason?: string;
      force?: boolean;
      sessionFiles?: string[];
      progress?: (update: MemorySyncProgressUpdate) => void;
    }) => Promise<void>;
  },
  sessionFiles?: string[],
): Promise<void> {
  const queuedSessionFiles = state.getQueuedSessionFiles();
  for (const sessionFile of sessionFiles ?? []) {
    const trimmed = sessionFile.trim();
    if (trimmed) {
      queuedSessionFiles.add(trimmed);
    }
  }
  if (queuedSessionFiles.size === 0) {
    return state.getSyncing() ?? Promise.resolve();
  }
  if (!state.getQueuedSessionSync()) {
    state.setQueuedSessionSync(
      (async () => {
        try {
          await state.getSyncing()?.catch(() => undefined);
          while (!state.isClosed() && state.getQueuedSessionFiles().size > 0) {
            const pendingSessionFiles = Array.from(state.getQueuedSessionFiles());
            state.getQueuedSessionFiles().clear();
            await state.sync({
              reason: "queued-session-files",
              sessionFiles: pendingSessionFiles,
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

export function _createMemorySyncControlConfigForTests(
  workspaceDir: string,
  indexPath: string,
): OpenClawConfig {
  return {
    agents: {
      defaults: {
        workspace: workspaceDir,
        memorySearch: {
          provider: "openai",
          model: "mock-embed",
          store: { path: indexPath, vector: { enabled: false } },
          cache: { enabled: false },
          query: { minScore: 0, hybrid: { enabled: false } },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      list: [{ id: "main", default: true }],
    },
  } as OpenClawConfig;
}
