// Transcript projection reconciliation owner. Gateway startup awaits it;
// request paths may only schedule it and return a bounded retryable response.
import { randomInt, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { toStringifiedError } from "@openclaw/normalization-core/error-coercion";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { computeBackoffSchedule } from "../../../packages/retry/src/index.js";
import { isGatewayExternallySupervised } from "../../infra/gateway-supervision.js";
import { isPathInside } from "../../infra/path-guards.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import {
  borrowOpenClawAgentDatabase,
  getOpenClawAgentDatabaseIfOpen,
  isIncognitoOpenClawAgentDatabase,
  isIncognitoOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseAsync,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import { sleep } from "../../utils/sleep.js";
import { resolveStateDir } from "../paths.js";
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
import {
  createMemoryTranscriptProjectionSource,
  type MemoryTranscriptProjectionSource,
} from "./session-transcript-reconcile-memory.js";
import type {
  EncodedTranscriptFtsChunk,
  SessionTranscriptReconcileWorkerInput,
  SessionTranscriptReconcileWorkerMessage,
} from "./session-transcript-reconcile.worker.js";

const log = createSubsystemLogger("sessions/transcript-index");
const PROJECTION_WRITE_CHUNK_ROWS = 512;
const PROJECTION_READY_POLL_MS = 10;
// Repeated pending passes can keep respawning workers for a contended snapshot.
// Do not reset on aggregate progress: other sessions may finish while it races.
// Zero preserves one immediate retry; ready targets poll independently.
const RECONCILE_RETRY_BACKOFF_MS: readonly number[] = [0, 50, 200, 500, 1_000];

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

type PreparedReconcileParams = SessionTranscriptReconcileParams & { env: NodeJS.ProcessEnv };
type ReconcileDatabaseOptions = OpenClawAgentDatabaseOptions & {
  env: NodeJS.ProcessEnv;
  path: string;
};

function prepareReconcileParams(params: SessionTranscriptReconcileParams): PreparedReconcileParams {
  // Deferred work retains the state owner selected before scheduling or admission.
  return { ...params, env: { ...(params.env ?? process.env) } };
}

type ActivePreparedProjection = {
  claimId: number;
  plan: PreparedSessionTranscriptProjectionMetadata;
};

function reconcileKey(params: OpenClawAgentDatabaseOptions): string {
  return resolveOpenClawAgentSqlitePath(params);
}

function captureMemorySource(params: OpenClawAgentDatabaseOptions) {
  const database = getOpenClawAgentDatabaseIfOpen(params);
  return database && isIncognitoOpenClawAgentDatabase(database)
    ? createMemoryTranscriptProjectionSource(database, { ...params, path: database.path })
    : undefined;
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

function observeWorkerLeaseRelease(worker: Worker) {
  let released = false;
  let releaseFailed = false;
  let failure: Error | undefined;
  worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
    if (message.type === "lease-released") {
      released = true;
    } else if (message.type === "lease-release-failed") {
      releaseFailed = true;
      failure = new Error(message.error);
    }
  });
  worker.once("error", (error) => {
    failure ??= toStringifiedError(error);
  });
  return new Promise<{ released: boolean; releaseFailed: boolean; failure?: Error }>((resolve) => {
    worker.once("exit", (code) => {
      if (code !== 0 || !released) {
        failure ??= new Error(`transcript worker exited with code ${code} before lease release`);
      }
      resolve({ released, releaseFailed, failure });
    });
  });
}

async function runProjectionWrite<T>(
  databaseOptions: ReconcileDatabaseOptions,
  operationLabel: string,
  operation: (database: OpenClawAgentDatabase) => T,
  memorySource?: MemoryTranscriptProjectionSource,
): Promise<T> {
  return await runExclusiveSqliteSessionWrite(databaseOptions, async () => {
    const write = () => {
      // Disposal revokes a memory source. Check inside the queue before the opener
      // can materialize a successor database for a late worker result.
      memorySource?.assertCurrentOwner();
      return runOpenClawAgentWriteTransaction(operation, databaseOptions, { operationLabel });
    };
    return !isIncognitoOpenClawAgentSqlitePath(databaseOptions.path, databaseOptions) &&
      !getOpenClawAgentDatabaseIfOpen(databaseOptions)
      ? withOpenClawAgentDatabaseAsync(databaseOptions, write)
      : write();
  });
}

async function claimPreparedSessionTranscriptProjection(
  databaseOptions: ReconcileDatabaseOptions,
  plan: PreparedSessionTranscriptProjectionMetadata,
  memorySource?: MemoryTranscriptProjectionSource,
): Promise<ActivePreparedProjection | undefined> {
  const claimId = nextProjectionClaimId();
  const claimed = await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.claim",
    (database) =>
      (!memorySource || memorySource.isCurrentPlan(plan)) &&
      claimPreparedSessionTranscriptProjectionInTransaction(database.db, plan, claimId),
    memorySource,
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
      memorySource,
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
  databaseOptions: ReconcileDatabaseOptions,
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
  memorySource?: MemoryTranscriptProjectionSource,
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
    memorySource,
  );
  await yieldToGateway();
  return owned;
}

async function finalizePreparedProjection(
  databaseOptions: ReconcileDatabaseOptions,
  active: ActivePreparedProjection,
  memorySource?: MemoryTranscriptProjectionSource,
): Promise<boolean> {
  return await runProjectionWrite(
    databaseOptions,
    "sessions.transcript-index.finalize",
    (database) =>
      (!memorySource || memorySource.isCurrentPlan(active.plan)) &&
      finalizePreparedSessionTranscriptProjectionInTransaction(
        database.db,
        active.plan,
        active.claimId,
      ),
    memorySource,
  );
}

/** Prepares full trees off-thread, then commits bounded chunks through the runtime writer owner. */
export async function reconcileSessionTranscriptIndexes(
  params: SessionTranscriptReconcileParams,
): Promise<SessionTranscriptReconcileResult> {
  return reconcilePreparedTranscriptIndexes(prepareReconcileParams(params));
}

async function reconcilePreparedTranscriptIndexes(
  params: PreparedReconcileParams,
): Promise<SessionTranscriptReconcileResult> {
  const databasePath = resolveOpenClawAgentSqlitePath(params);
  const databaseOptions: ReconcileDatabaseOptions = {
    agentId: params.agentId,
    env: params.env,
    path: databasePath,
  };
  let releaseDatabase: (() => void) | undefined;
  const memorySource = captureMemorySource(databaseOptions);
  let memorySessionIds: string[] = [];
  try {
    // The SQLite owner can cheaply prove a clean projection before paying for a
    // Worker. Keep the post-worker sweep too, because request-time writers may race.
    await runProjectionWrite(
      databaseOptions,
      "sessions.transcript-index.preflight",
      (database) => {
        deleteOrphanedTranscriptIndexRowsInTransaction(database.db);
        const sessionIds = listSessionsNeedingTranscriptIndexReconcile(database.db);
        if (sessionIds.length > 0) {
          // Retain this verified handle across worker awaits; explicit disposal still revokes it.
          releaseDatabase = borrowOpenClawAgentDatabase(databaseOptions).release;
          if (memorySource) {
            const preferred = params.preferredSessionId;
            memorySessionIds =
              preferred && sessionIds.includes(preferred)
                ? [preferred, ...sessionIds.filter((sessionId) => sessionId !== preferred)]
                : sessionIds;
          }
        }
      },
      memorySource,
    );
    if (!releaseDatabase) {
      return { reconciledSessions: 0 };
    }
    const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionTranscriptReconcile);
    const sourceWorkerExecArgv = workerUrl.pathname.endsWith(".ts")
      ? ["--import", "tsx"]
      : undefined;
    const input: SessionTranscriptReconcileWorkerInput = memorySource
      ? { mode: "memory", sessionIds: memorySessionIds }
      : {
          mode: "disk",
          leaseId: randomUUID(),
          agentId: params.agentId,
          path: databasePath,
          stateDir: resolveStateDir(params.env),
          externallySupervised: isGatewayExternallySupervised(params.env),
          ...(params.preferredSessionId ? { preferredSessionId: params.preferredSessionId } : {}),
        };
    const createWorker =
      params.createWorker ?? ((filename, options) => new Worker(filename, options));
    let worker: Worker;
    try {
      worker = createWorker(workerUrl, { workerData: input, execArgv: sourceWorkerExecArgv });
    } catch (error) {
      throw toStringifiedError(error);
    }

    const leaseRelease = observeWorkerLeaseRelease(worker);
    let handlingMessage: Promise<void> | undefined;
    let terminalReceived = false;
    let outcome: Result<SessionTranscriptReconcileResult, unknown>;
    try {
      const value = await new Promise<SessionTranscriptReconcileResult>((resolve, reject) => {
        let active: ActivePreparedProjection | undefined;
        let reconciledSessions = 0;
        let settled = false;
        const settle = (finish: () => void) => {
          if (settled) {
            return;
          }
          settled = true;
          finish();
        };
        const handleMessage = async (
          message: Exclude<
            SessionTranscriptReconcileWorkerMessage,
            { type: "lease-released" | "lease-release-failed" }
          >,
        ) => {
          if (message.type === "failed") {
            terminalReceived = true;
            settle(() => reject(new Error(message.error)));
            return;
          }
          if (message.type === "done") {
            terminalReceived = true;
            if (active) {
              settle(() => reject(new Error("session transcript reconcile worker ended mid-plan")));
              return;
            }
            try {
              await runProjectionWrite(
                databaseOptions,
                "sessions.transcript-index.orphan-sweep",
                (database) => deleteOrphanedTranscriptIndexRowsInTransaction(database.db),
                memorySource,
              );
            } catch (error) {
              settle(() => reject(toStringifiedError(error)));
              return;
            }
            settle(() => resolve({ reconciledSessions }));
            return;
          }
          try {
            if (message.type === "source-read") {
              if (!memorySource || !memorySessionIds.includes(message.sessionId)) {
                throw new Error("session transcript worker requested an unavailable memory source");
              }
              const frame = memorySource.read(message.sessionId);
              await yieldToGateway();
              worker.postMessage(frame, frame.type === "source-frame" ? [frame.bytes.buffer] : []);
              return;
            }
            if (message.type === "plan-start") {
              if (active) {
                throw new Error("session transcript reconcile worker started overlapping plans");
              }
              active = await claimPreparedSessionTranscriptProjection(
                databaseOptions,
                message.plan,
                memorySource,
              );
              continueProjectionWorker(worker, active !== undefined);
              return;
            }
            if (!active || active.plan.sessionId !== message.sessionId) {
              throw new Error(
                "session transcript reconcile worker sent a chunk for no active plan",
              );
            }
            if (message.type === "plan-finish") {
              const finalized = await finalizePreparedProjection(
                databaseOptions,
                active,
                memorySource,
              );
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
              memorySource,
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
          if (
            settled ||
            message.type === "lease-released" ||
            message.type === "lease-release-failed"
          ) {
            return;
          }
          handlingMessage = handleMessage(message);
        });
        worker.once("error", (error) => {
          settle(() => reject(toStringifiedError(error)));
        });
        worker.once("exit", (code) => {
          if (input.mode === "memory" && terminalReceived && code === 0) {
            return;
          }
          settle(() =>
            reject(new Error(`session transcript reconcile worker exited with code ${code}`)),
          );
        });
      });
      outcome = ok(value);
    } catch (error) {
      outcome = err(error);
    }
    let plannerFailure: Error | undefined;
    try {
      const termination =
        input.mode !== "disk" || !terminalReceived ? worker.terminate() : undefined;
      // A handler may initiate settlement. Join it here, outside that handler, before releasing
      // the independent lease; native exit and cleanup messages must not replace this task.
      await handlingMessage;
      if (input.mode === "disk" && terminalReceived && worker.threadId !== -1) {
        worker.postMessage({ type: "release" }, []);
      } else {
        await (termination ?? worker.terminate());
      }
      const plannerRelease = await leaseRelease;
      if (input.mode === "disk") {
        let cleanup = plannerRelease;
        if (!cleanup.released && !cleanup.releaseFailed) {
          const releaseWorker = createWorker(workerUrl, {
            workerData: {
              mode: "release",
              leaseId: input.leaseId,
              stateDir: input.stateDir,
              externallySupervised: input.externallySupervised,
            } satisfies SessionTranscriptReconcileWorkerInput,
            execArgv: sourceWorkerExecArgv,
          });
          try {
            cleanup = await observeWorkerLeaseRelease(releaseWorker);
          } finally {
            await releaseWorker.terminate();
            releaseWorker.removeAllListeners();
          }
        }
        if (cleanup.failure) {
          throw cleanup.failure;
        }
        if (outcome.ok && plannerRelease.failure) {
          plannerFailure = plannerRelease.failure;
        }
      }
    } catch (error) {
      const failure = new Error(
        `Transcript lease cleanup incomplete; restart OpenClaw before deleting this agent: ${toStringifiedError(error).message}`,
        { cause: error },
      );
      throw outcome.ok
        ? failure
        : new AggregateError([outcome.error, failure], failure.message, { cause: failure });
    } finally {
      worker.removeAllListeners();
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    if (plannerFailure) {
      throw plannerFailure;
    }
    return outcome.value;
  } finally {
    memorySource?.clear();
    releaseDatabase?.();
  }
}

/** Starts one deferred reconcile. No transcript rows are read on the caller's stack. */
export function startSessionTranscriptIndexReconcile(
  input: SessionTranscriptReconcileParams,
): void {
  const params = prepareReconcileParams(input);
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
  // Capture before the first yield: disposal must revoke this scheduled owner,
  // including a later pass, before preflight can reopen its sentinel.
  const memorySource = captureMemorySource(params);
  const pending = yieldToGateway()
    .then(async () => {
      let reconciledSessions = 0;
      let retryCount = 0;
      while (true) {
        // Leave a successor's pending request intact if the previous memory
        // owner was disposed while its successful pass was settling.
        memorySource?.assertCurrentOwner();
        state.pending = false;
        const preferredSessionId = state.preferredSessionId;
        delete state.preferredSessionId;
        const result = await reconcilePreparedTranscriptIndexes({
          ...params,
          ...(preferredSessionId ? { preferredSessionId } : {}),
        });
        reconciledSessions += result.reconciledSessions;
        if (state.pending) {
          retryCount += 1;
          await sleep(computeBackoffSchedule(RECONCILE_RETRY_BACKOFF_MS, retryCount));
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
      // A pending request may own an already-created successor; never create one
      // merely to retry the disposed memory owner's work.
      if (shouldHandoff && (!memorySource || captureMemorySource(params))) {
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

/** Test and maintenance drain for scheduled reconciles owned by one state directory. */
export async function waitForSessionTranscriptIndexReconcilesInStateDir(
  stateDir: string,
): Promise<void> {
  while (true) {
    const owners = [...runningReconciles]
      .filter(([databasePath]) => isPathInside(stateDir, databasePath))
      .flatMap(([, owner]) => (owner.promise ? [owner.promise] : []));
    if (owners.length === 0) {
      return;
    }
    // Handoffs and other fixture databases may register owners while this batch settles.
    await Promise.all(owners);
  }
}

/** Waits only until the requested session's scheduled projection rebuild settles. */
export async function waitForSessionTranscriptProjection(
  scope: SessionTranscriptReadScope,
  abortSignal?: AbortSignal,
): Promise<void> {
  const resolved = resolveSqliteTranscriptReadScope(scope);
  const databaseOptions = toDatabaseOptions(resolved);
  while (isSessionTranscriptIndexReconcileRunning(databaseOptions)) {
    // Poll committed metadata without superseding a pending writable admission
    // or recreating an incognito owner disposed across an earlier polling await.
    const pending = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => sessionTranscriptIndexNeedsReconcile(db, resolved.sessionId),
      databaseOptions,
      { throwOnMissingTable: true },
    );
    if (!pending.found || !pending.value) {
      break;
    }
    await delay(
      PROJECTION_READY_POLL_MS,
      undefined,
      abortSignal ? { signal: abortSignal } : undefined,
    );
  }
}
