// Transcript projection reconciliation owner. Gateway startup awaits it;
// request paths may only schedule it and return a bounded retryable response.
import { randomInt } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import {
  resolveSqliteTranscriptReadScope,
  runExclusiveSqliteSessionWrite,
  toDatabaseOptions,
} from "./session-accessor.sqlite-scope.js";
import {
  deleteOrphanedTranscriptIndexRowsInTransaction,
  listSessionsNeedingTranscriptIndexReconcile,
  sessionTranscriptIndexNeedsReconcile,
} from "./session-transcript-index.js";
import {
  appendPreparedSessionTranscriptProjectionChunkInTransaction,
  claimPreparedSessionTranscriptProjectionInTransaction,
  deletePreparedSessionTranscriptProjectionChunkInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  type PreparedSessionTranscriptProjectionMetadata,
} from "./session-transcript-projection-rebuild.js";
import type {
  EncodedTranscriptFtsChunk,
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

const log = createSubsystemLogger("sessions/transcript-index");
const PROJECTION_WRITE_CHUNK_ROWS = 512;
const PROJECTION_READY_POLL_MS = 10;

type RunningReconcile = {
  pending: boolean;
  preferredSessionId?: string;
  promise?: Promise<SessionTranscriptReconcileResult>;
};

const runningReconciles = new Map<string, RunningReconcile>();

export type SessionTranscriptReconcileResult = {
  reconciledSessions: number;
};

type SessionTranscriptReconcileParams = OpenClawAgentDatabaseOptions & {
  createWorker?: (filename: string | URL, options: WorkerOptions) => Worker;
  preferredSessionId?: string;
};

type ActivePreparedProjection = {
  claimId: number;
  plan: PreparedSessionTranscriptProjectionMetadata;
};

function reconcileKey(params: OpenClawAgentDatabaseOptions): string {
  return resolveOpenClawAgentSqlitePath(params);
}

function resolveSessionTranscriptReconcileWorkerUrl(currentModuleUrl = import.meta.url): URL {
  const currentPath = fileURLToPath(currentModuleUrl);
  const normalized = currentPath.replaceAll(path.sep, "/");
  const distMarker = "/dist/";
  const distIndex = normalized.lastIndexOf(distMarker);
  if (distIndex >= 0) {
    const distRoot = currentPath.slice(0, distIndex + distMarker.length);
    return pathToFileURL(
      path.join(distRoot, "config", "sessions", "session-transcript-reconcile.worker.js"),
    );
  }
  const extension = path.extname(currentPath) || ".js";
  return new URL(`./session-transcript-reconcile.worker${extension}`, currentModuleUrl);
}

function yieldToGateway(): Promise<void> {
  return new Promise((resolve) => {
    setImmediate(resolve);
  });
}

function nextProjectionClaimId(): number {
  return -randomInt(1, 2 ** 47);
}

// Node Worker messages take a transfer list, unlike Window.postMessage.
// Keep the empty list explicit so the platform contract stays unambiguous.
function continueProjectionWorker(worker: Worker, accepted: boolean): void {
  worker.postMessage({ accepted, type: "continue" }, []);
}

async function runProjectionWrite<T>(
  databaseOptions: OpenClawAgentDatabaseOptions,
  operationLabel: string,
  operation: (database: OpenClawAgentDatabase) => T,
): Promise<T> {
  return await runExclusiveSqliteSessionWrite(databaseOptions, async () =>
    runOpenClawAgentWriteTransaction(operation, databaseOptions, { operationLabel }),
  );
}

async function claimPreparedSessionTranscriptProjection(
  databaseOptions: OpenClawAgentDatabaseOptions,
  plan: PreparedSessionTranscriptProjectionMetadata,
): Promise<ActivePreparedProjection | undefined> {
  const claimId = nextProjectionClaimId();
  const claimed = await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.claim",
    (database) => claimPreparedSessionTranscriptProjectionInTransaction(database.db, plan, claimId),
  );
  if (!claimed) {
    return undefined;
  }

  let deleteResult = { hasMore: true, owned: true };
  while (deleteResult.hasMore && deleteResult.owned) {
    deleteResult = await runProjectionWrite(
      databaseOptions,
      "sessions.transcript-index.delete-chunk",
      (database) =>
        deletePreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
          maxRowsPerTable: PROJECTION_WRITE_CHUNK_ROWS,
          sessionId: plan.sessionId,
          claimId,
        }),
    );
    await yieldToGateway();
  }
  if (!deleteResult.owned) {
    return undefined;
  }
  return { claimId, plan };
}

function decodeFtsChunk(chunk: EncodedTranscriptFtsChunk) {
  const decoder = new TextDecoder();
  return chunk.rows.map((row) => ({
    messageId: row.messageId,
    role: row.role,
    text: decoder.decode(
      chunk.textBytes.subarray(row.textByteOffset, row.textByteOffset + row.textByteLength),
    ),
    timestamp: row.timestamp,
  }));
}

async function appendPreparedProjectionChunk(
  databaseOptions: OpenClawAgentDatabaseOptions,
  active: ActivePreparedProjection,
  rows:
    | {
        activeRows: Parameters<
          typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
        >[1]["activeRows"];
      }
    | {
        ftsRows: Parameters<
          typeof appendPreparedSessionTranscriptProjectionChunkInTransaction
        >[1]["ftsRows"];
      },
): Promise<boolean> {
  const owned = await runProjectionWrite(
    databaseOptions,
    "activeRows" in rows
      ? "sessions.transcript-index.active-chunk"
      : "sessions.transcript-index.fts-chunk",
    (database) =>
      appendPreparedSessionTranscriptProjectionChunkInTransaction(database.db, {
        ...rows,
        claimId: active.claimId,
        sessionId: active.plan.sessionId,
      }),
  );
  await yieldToGateway();
  return owned;
}

async function finalizePreparedProjection(
  databaseOptions: OpenClawAgentDatabaseOptions,
  active: ActivePreparedProjection,
): Promise<boolean> {
  return await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.finalize",
    (database) =>
      finalizePreparedSessionTranscriptProjectionInTransaction(
        database.db,
        active.plan,
        active.claimId,
      ),
  );
}

/** Prepares full trees off-thread, then commits bounded chunks through the runtime writer owner. */
export async function reconcileSessionTranscriptIndexes(
  params: SessionTranscriptReconcileParams,
): Promise<SessionTranscriptReconcileResult> {
  const databasePath = resolveOpenClawAgentSqlitePath(params);
  const databaseOptions: OpenClawAgentDatabaseOptions = {
    agentId: params.agentId,
    ...(params.env ? { env: params.env } : {}),
    path: databasePath,
  };
  // The SQLite owner can cheaply prove a clean projection before paying for a
  // Worker. Keep the post-worker sweep too, because request-time writers may race.
  const needsWorker = await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.preflight",
    (database) => {
      deleteOrphanedTranscriptIndexRowsInTransaction(database.db);
      return listSessionsNeedingTranscriptIndexReconcile(database.db).length > 0;
    },
  );
  if (!needsWorker) {
    return { reconciledSessions: 0 };
  }
  const workerUrl = resolveSessionTranscriptReconcileWorkerUrl();
  const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts") ? ["--import", "tsx"] : undefined;
  const input: SessionTranscriptReconcileWorkerInput = {
    agentId: params.agentId,
    path: databasePath,
    ...(params.preferredSessionId ? { preferredSessionId: params.preferredSessionId } : {}),
  };
  let worker: Worker;
  try {
    worker = (params.createWorker ?? ((filename, options) => new Worker(filename, options)))(
      workerUrl,
      { workerData: input, execArgv: sourceWorkerExecArgv },
    );
  } catch (error) {
    throw toStringifiedError(error);
  }

  return new Promise<SessionTranscriptReconcileResult>((resolve, reject) => {
    let active: ActivePreparedProjection | undefined;
    let doneReceived = false;
    let reconciledSessions = 0;
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      worker.removeAllListeners();
      // Finish only after the worker thread has stopped: waiters may delete
      // the database file next, and the thread's open SQLite handle must be
      // released first (Windows fails the unlink with EBUSY otherwise).
      // terminate() on an already-exited worker resolves immediately.
      void worker.terminate().then(finish, finish);
    };
    const handleMessage = async (message: SessionTranscriptReconcileWorkerMessage) => {
      if (message.type === "failed") {
        settle(() => reject(new Error(message.error)));
        return;
      }
      if (message.type === "done") {
        doneReceived = true;
        if (active) {
          settle(() => reject(new Error("session transcript reconcile worker ended mid-plan")));
          return;
        }
        try {
          await runProjectionWrite(
            databaseOptions,
            "sessions.transcript-index.orphan-sweep",
            (database) => deleteOrphanedTranscriptIndexRowsInTransaction(database.db),
          );
        } catch (error) {
          settle(() => reject(toStringifiedError(error)));
          return;
        }
        settle(() => resolve({ reconciledSessions }));
        return;
      }
      try {
        if (message.type === "plan-start") {
          if (active) {
            throw new Error("session transcript reconcile worker started overlapping plans");
          }
          active = await claimPreparedSessionTranscriptProjection(databaseOptions, message.plan);
          continueProjectionWorker(worker, active !== undefined);
          return;
        }
        if (!active || active.plan.sessionId !== message.sessionId) {
          throw new Error("session transcript reconcile worker sent a chunk for no active plan");
        }
        if (message.type === "plan-finish") {
          const finalized = await finalizePreparedProjection(databaseOptions, active);
          active = undefined;
          if (finalized) {
            reconciledSessions += 1;
          }
          continueProjectionWorker(worker, finalized);
          return;
        }
        const owned = await appendPreparedProjectionChunk(
          databaseOptions,
          active,
          message.type === "active-chunk"
            ? { activeRows: message.rows }
            : { ftsRows: decodeFtsChunk(message.chunk) },
        );
        if (!owned) {
          active = undefined;
        }
        continueProjectionWorker(worker, owned);
      } catch (error) {
        settle(() => reject(toStringifiedError(error)));
      }
    };
    worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
      void handleMessage(message);
    });
    worker.once("error", (error) => {
      settle(() => reject(toStringifiedError(error)));
    });
    worker.once("exit", (code) => {
      if (doneReceived && code === 0) {
        return;
      }
      settle(() =>
        reject(new Error(`session transcript reconcile worker exited with code ${code}`)),
      );
    });
  });
}

/** Starts one deferred reconcile. No transcript rows are read on the caller's stack. */
export function startSessionTranscriptIndexReconcile(
  params: SessionTranscriptReconcileParams,
): void {
  const key = reconcileKey(params);
  const running = runningReconciles.get(key);
  if (running) {
    // The active pass snapshots dirty sessions. Latch later writes so it
    // rescans before ownership is released instead of losing their work.
    running.pending = true;
    running.preferredSessionId ??= params.preferredSessionId;
    return;
  }
  const state: RunningReconcile = {
    pending: false,
    ...(params.preferredSessionId ? { preferredSessionId: params.preferredSessionId } : {}),
  };
  const pending = yieldToGateway()
    .then(async () => {
      let reconciledSessions = 0;
      while (true) {
        state.pending = false;
        const preferredSessionId = state.preferredSessionId;
        delete state.preferredSessionId;
        const result = await reconcileSessionTranscriptIndexes({
          ...params,
          ...(preferredSessionId ? { preferredSessionId } : {}),
        });
        reconciledSessions += result.reconciledSessions;
        if (state.pending) {
          continue;
        }
        // Check and relinquish ownership without an async boundary. A later
        // request either latches above or creates a fresh owner below.
        if (runningReconciles.get(key) === state) {
          runningReconciles.delete(key);
        }
        return { reconciledSessions };
      }
    })
    .catch(async (error: unknown) => {
      log.warn(
        `session transcript reconcile failed agent=${params.agentId} error=${error instanceof Error ? error.message : String(error)}`,
      );
      const shouldHandoff = state.pending;
      const preferredSessionId = state.preferredSessionId;
      if (runningReconciles.get(key) === state) {
        runningReconciles.delete(key);
      }
      if (shouldHandoff) {
        startSessionTranscriptIndexReconcile({
          ...params,
          ...(preferredSessionId ? { preferredSessionId } : {}),
        });
        await waitForSessionTranscriptIndexReconcile(params);
      }
      return { reconciledSessions: 0 };
    });
  state.promise = pending;
  runningReconciles.set(key, state);
}

export function isSessionTranscriptIndexReconcileRunning(
  params: OpenClawAgentDatabaseOptions,
): boolean {
  return runningReconciles.has(reconcileKey(params));
}

/** Test and maintenance wait hook for an already-scheduled reconcile. */
export async function waitForSessionTranscriptIndexReconcile(
  params: OpenClawAgentDatabaseOptions,
): Promise<void> {
  await runningReconciles.get(reconcileKey(params))?.promise;
}

/** Waits only until the requested session's scheduled projection rebuild settles. */
export async function waitForSessionTranscriptProjection(
  scope: SessionTranscriptReadScope,
): Promise<void> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  const database = openOpenClawAgentDatabase(databaseOptions);
  while (
    isSessionTranscriptIndexReconcileRunning(databaseOptions) &&
    sessionTranscriptIndexNeedsReconcile(database.db, resolved.sessionId)
  ) {
    await delay(PROJECTION_READY_POLL_MS);
  }
}
