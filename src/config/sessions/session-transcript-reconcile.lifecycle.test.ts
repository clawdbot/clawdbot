import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import * as runtimeWorkerUrl from "../../infra/runtime-worker-url.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../../state/openclaw-agent-db-lease.js";
import {
  closeOpenClawAgentDatabaseByPath,
  closeOpenClawAgentDatabasesForTest,
  isOpenClawAgentDatabaseOpen,
  openOpenClawAgentDatabase,
  OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP,
  resolveOpenClawAgentSqlitePath,
  withAgentDatabaseMaintenanceLease,
  type OpenClawAgentDatabaseOptions,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPath,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnvAsync } from "../../test-utils/env.js";
import * as sleepUtils from "../../utils/sleep.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type TerminalType = Extract<
  SessionTranscriptReconcileWorkerMessage,
  { type: "done" | "failed" }
>["type"];

function countAgentDatabaseLeases(pathname: string, env?: NodeJS.ProcessEnv): number {
  // SAFETY: SQLite COUNT(*) always returns one row with the numeric alias requested here.
  const row = openOpenClawStateDatabase({ env })
    .db.prepare(
      `SELECT COUNT(*) AS count
       FROM agent_database_leases
       WHERE owner_pid = ? AND path = ?`,
    )
    .get(process.pid, pathname) as { count: number };
  return row.count;
}

function createCleanupFenceProbe() {
  const stateDatabase = openOpenClawStateDatabase();
  let lockHeld = false;
  let resolvePlanStarted!: () => void;
  let resolveTerminal!: (type: TerminalType) => void;
  const planStarted = new Promise<void>((resolve) => {
    resolvePlanStarted = resolve;
  });
  const terminal = new Promise<TerminalType>((resolve) => {
    resolveTerminal = resolve;
  });
  const createWorker = (filename: string | URL, options: WorkerOptions): Worker => {
    const worker = new Worker(filename, options);
    // This listener is registered before the reconciler's listener. Holding
    // the state writer after plan-start fences the worker's lease release.
    worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
      if (message.type === "plan-start" && !lockHeld) {
        stateDatabase.db.exec("BEGIN IMMEDIATE;");
        lockHeld = true;
        resolvePlanStarted();
      }
      if (message.type === "done" || message.type === "failed") {
        resolveTerminal(message.type);
      }
    });
    return worker;
  };

  return {
    createWorker,
    planStarted,
    release(): void {
      if (!lockHeld) {
        return;
      }
      stateDatabase.db.exec("ROLLBACK;");
      lockHeld = false;
    },
    terminal,
  };
}

function openCachePressureAgents(): void {
  for (let index = 0; index < OPENCLAW_AGENT_DB_OPEN_HANDLE_CAP; index += 1) {
    openOpenClawAgentDatabase({ agentId: `pressure-${index}` });
  }
}

function readProjectedTranscript(
  database: ReturnType<typeof openOpenClawAgentDatabase>,
  sessionId: string,
) {
  return database.db
    .prepare(`SELECT active.active_position, events.event_json
    FROM session_transcript_active_events active JOIN transcript_events events
      ON events.session_id = active.session_id AND events.seq = active.event_seq
    WHERE active.session_id = ? ORDER BY active.active_position`)
    .all(sessionId);
}

function createPlanFinishFence(sessionId: string) {
  const paused = createDeferred();
  let worker: Worker | undefined;
  let releaseAcknowledgement: (() => void) | undefined;
  let released = false;
  return {
    paused: paused.promise,
    threadId: () => worker?.threadId,
    createWorker: (filename: string | URL, options: WorkerOptions): Worker => {
      worker = new Worker(filename, options);
      const postMessage = worker.postMessage.bind(worker);
      let finishingTarget = false;
      worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
        finishingTarget = message.type === "plan-finish" && message.sessionId === sessionId;
      });
      // The projection is committed before this ACK; pause the real worker without racing writes.
      worker.postMessage = (message: unknown, transferList) => {
        if (finishingTarget && !released) {
          finishingTarget = false;
          releaseAcknowledgement = () => postMessage(message, transferList);
          paused.resolve();
          return;
        }
        postMessage(message, transferList);
      };
      return worker;
    },
    release(): void {
      released = true;
      releaseAcknowledgement?.();
    },
  };
}

async function waitForCurrentProjection(databasePath: string, sessionId: string): Promise<void> {
  const database = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
  await vi.waitFor(
    () => {
      expect(
        database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(sessionId),
      ).toEqual({ needs_rebuild: 0 });
    },
    { interval: 10, timeout: 5_000 },
  );
}

describe("session transcript reconcile worker lifecycle", () => {
  it("drains later fixture owners without waiting for an unrelated state directory", async () => {
    const root = tempDirs.make("openclaw-reconcile-scope-");
    const stateDir = path.join(root, "state");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const first = { agentId: "main", env };
    const later = { agentId: "later", env };
    const unrelated = {
      agentId: "main",
      env: { ...env, OPENCLAW_STATE_DIR: `${stateDir}-unrelated` },
    };
    const realSetImmediate = globalThis.setImmediate;
    const immediateSpy = vi.spyOn(globalThis, "setImmediate");
    const checkpoint = () =>
      new Promise<void>((resolve) => {
        realSetImmediate(resolve);
      });
    const startDeferred = (options: OpenClawAgentDatabaseOptions) => {
      const release = createDeferred();
      immediateSpy.mockImplementationOnce((callback) => {
        void release.promise.then(() => callback());
        return realSetImmediate(() => undefined);
      });
      startSessionTranscriptIndexReconcile(options);
      return release;
    };
    const releaseFirst = startDeferred(first);
    const releaseUnrelated = startDeferred(unrelated);
    let settled = false;
    const scopedWait = waitForSessionTranscriptIndexReconcilesInStateDir(stateDir).then(() => {
      settled = true;
    });
    // This owner did not exist in the waiter's initial snapshot, and no owner
    // has opened its database yet: scope must come from the registered keys.
    const releaseLater = startDeferred(later);
    try {
      releaseFirst.resolve();
      await waitForSessionTranscriptIndexReconcile(first);
      await checkpoint();
      expect(settled).toBe(false);
      expect(isSessionTranscriptIndexReconcileRunning(later)).toBe(true);

      releaseLater.resolve();
      await waitForSessionTranscriptIndexReconcile(later);
      // A checkpoint makes a wrongly global wait fail here, while finally can
      // still release the unrelated owner instead of deadlocking the test.
      await checkpoint();
      expect(settled).toBe(true);
      expect(isSessionTranscriptIndexReconcileRunning(unrelated)).toBe(true);
      expect(isOpenClawAgentDatabaseOpen(resolveOpenClawAgentSqlitePath(unrelated))).toBe(false);
    } finally {
      immediateSpy.mockRestore();
      releaseFirst.resolve();
      releaseLater.resolve();
      releaseUnrelated.resolve();
      await Promise.all([
        scopedWait,
        ...[first, later, unrelated].map(waitForSessionTranscriptIndexReconcile),
      ]);
      for (const options of [first, later, unrelated]) {
        closeOpenClawAgentDatabaseByPath(resolveOpenClawAgentSqlitePath(options));
      }
      for (const options of [first, unrelated]) {
        closeOpenClawStateDatabaseByPath(resolveOpenClawStateSqlitePath(options.env));
      }
    }
  });

  it("resolves one session before unrelated projection repair completes", async () => {
    const stateDir = tempDirs.make("openclaw-active-transcript-");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "active-transcript-test",
      sessionKey: "agent:main:active-transcript-test",
    };
    try {
      const secondScope = { ...scope, sessionId: "session-slow", sessionKey: "agent:main:slow" };
      for (const target of [scope, secondScope]) {
        await persistSessionTranscriptTurn(target, {
          messages: [
            {
              eventId: `${target.sessionId}-seed`,
              parentId: null,
              message: { role: "user", content: target.sessionId },
            },
          ],
          touchSessionEntry: false,
        });
      }
      const databaseOptions = { agentId: scope.agentId, env: scope.env };
      const database = openOpenClawAgentDatabase(databaseOptions);
      const markDirty = database.db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      );
      markDirty.run(scope.sessionId);
      markDirty.run(secondScope.sessionId);

      const probe = createPlanFinishFence(scope.sessionId);
      startSessionTranscriptIndexReconcile({
        ...databaseOptions,
        preferredSessionId: scope.sessionId,
        createWorker: probe.createWorker,
      });
      let allReconciled = false;
      const allReconciliation = waitForSessionTranscriptIndexReconcile(databaseOptions).then(() => {
        allReconciled = true;
      });
      let targetOutcome: { ready: true } | { error: unknown } | undefined;
      const targetReconciliation = waitForSessionTranscriptProjection(scope).then(
        () => {
          targetOutcome = { ready: true };
        },
        (error: unknown) => {
          targetOutcome = { error };
        },
      );

      try {
        await Promise.race([
          probe.paused,
          allReconciliation.then(() => {
            throw new Error("reconciliation completed without the target acknowledgement gate");
          }),
        ]);
        expect(
          database.db
            .prepare(
              "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(scope.sessionId),
        ).toEqual({ needs_rebuild: 0 });
        await vi.waitFor(() => expect(targetOutcome).toEqual({ ready: true }));
        expect(allReconciled).toBe(false);
        expect(
          database.db
            .prepare(
              "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
            )
            .get(secondScope.sessionId),
        ).toEqual({ needs_rebuild: 1 });
      } finally {
        probe.release();
        await Promise.all([targetReconciliation, allReconciliation]);
      }
    } finally {
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    }
  }, 30_000);

  it("awaits pending-pass backoff while coalescing writes and keeping ready sessions available", async () => {
    const stateDir = tempDirs.make("openclaw-reconcile-backoff-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    const databaseOptions = { agentId: "main", env };
    const scope = {
      ...databaseOptions,
      sessionId: "reconcile-backoff",
      sessionKey: "agent:main:reconcile-backoff",
    };
    const readyScope = { ...scope, sessionId: "ready-sibling", sessionKey: "agent:main:ready" };
    const paused = createDeferred();
    const resume = createDeferred();
    const workers: Worker[] = [];
    let injectPending = true;
    let injectedPending = 0;
    const realSleep = sleepUtils.sleep;
    const sleepSpy = vi.spyOn(sleepUtils, "sleep");
    try {
      for (const target of [scope, readyScope]) {
        await persistSessionTranscriptTurn(target, {
          messages: [
            { eventId: `${target.sessionId}-seed`, message: { role: "user", content: "seed" } },
          ],
          touchSessionEntry: false,
        });
      }
      await waitForSessionTranscriptIndexReconcile(databaseOptions);
      const database = openOpenClawAgentDatabase(databaseOptions);
      const baselineLeaseCount = countAgentDatabaseLeases(database.path, env);
      const markDirty = database.db.prepare(
        "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
      );
      markDirty.run(scope.sessionId);
      const createWorker = (filename: string | URL, options: WorkerOptions): Worker => {
        const worker = new Worker(filename, options);
        workers.push(worker);
        worker.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
          if (message.type !== "done" || !injectPending || injectedPending >= 6) {
            return;
          }
          markDirty.run(scope.sessionId);
          injectedPending += 1;
          startSessionTranscriptIndexReconcile({
            ...databaseOptions,
            preferredSessionId: scope.sessionId,
            createWorker,
          });
        });
        return worker;
      };
      sleepSpy.mockClear();
      sleepSpy.mockImplementation(async (ms) => {
        if (ms === 50) {
          paused.resolve();
          await resume.promise;
        }
        await realSleep(ms);
      });
      startSessionTranscriptIndexReconcile({
        ...databaseOptions,
        preferredSessionId: scope.sessionId,
        createWorker,
      });
      const completed = waitForSessionTranscriptIndexReconcile(databaseOptions);
      await Promise.race([
        paused.promise,
        completed.then(() => {
          throw new Error("reconciliation completed without awaiting backoff");
        }),
      ]);
      expect(workers).toHaveLength(2);
      expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      expect(countAgentDatabaseLeases(database.path, env)).toBe(baselineLeaseCount);
      const unexpectedWorker = vi.fn(() => {
        throw new Error("pending request created another owner");
      });
      startSessionTranscriptIndexReconcile({
        ...databaseOptions,
        preferredSessionId: readyScope.sessionId,
        createWorker: unexpectedWorker,
      });
      await persistSessionTranscriptTurn(scope, {
        messages: [
          { eventId: "during-backoff", message: { role: "user", content: "queued while paused" } },
        ],
        touchSessionEntry: false,
      });
      await waitForSessionTranscriptProjection(readyScope);
      expect(workers).toHaveLength(2);
      expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(true);
      resume.resolve();
      await completed;
      expect(unexpectedWorker).not.toHaveBeenCalled();
      expect(workers).toHaveLength(7);
      expect(injectedPending).toBe(6);
      expect(sleepSpy.mock.calls).toEqual([[0], [50], [200], [500], [1_000], [1_000]]);
      expect(
        database.db
          .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
          .get(scope.sessionId),
      ).toEqual({ needs_rebuild: 0 });
      expect(readProjectedTranscript(database, scope.sessionId)).toHaveLength(2);
      expect(workers.every((worker) => worker.threadId === -1)).toBe(true);
      expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(false);
      expect(countAgentDatabaseLeases(database.path, env)).toBe(baselineLeaseCount);
    } finally {
      injectPending = false;
      resume.resolve();
      await waitForSessionTranscriptIndexReconcile(databaseOptions);
      sleepSpy.mockRestore();
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
    }
  }, 30_000);

  it.each([false, true])(
    "retains the active reconcile handle under cache pressure (explicit close: %s)",
    async (explicitClose) => {
      const stateDir = tempDirs.make("openclaw-reconcile-retained-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const databaseOptions = { agentId: "main" };
        const scope = {
          ...databaseOptions,
          sessionId: "retained-primary",
          sessionKey: "agent:main:retained-primary",
        };
        try {
          await persistSessionTranscriptTurn(scope, {
            messages: [
              {
                eventId: "retained-message",
                message: { role: "user", content: "Retained transcript" },
              },
            ],
            touchSessionEntry: false,
          });
          await waitForSessionTranscriptIndexReconcile(databaseOptions);
          const database = openOpenClawAgentDatabase(databaseOptions);
          const expected = readProjectedTranscript(database, scope.sessionId);
          expect(expected).toHaveLength(1);
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run(scope.sessionId);
          const probe = createPlanFinishFence(scope.sessionId);
          const outcome = reconcileSessionTranscriptIndexes({
            ...databaseOptions,
            createWorker: probe.createWorker,
          }).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );
          try {
            await Promise.race([
              probe.paused,
              outcome.then(() => {
                throw new Error("worker settled before the final acknowledgement");
              }),
            ]);
            expect(countAgentDatabaseLeases(database.path)).toBe(2);
            openCachePressureAgents();
            expect(database.db.isOpen).toBe(true);
            if (explicitClose) {
              expect(closeOpenClawAgentDatabaseByPath(database.path)).toBe(true);
              expect(database.db.isOpen).toBe(false);
              expect(countAgentDatabaseLeases(database.path)).toBe(1);
              expect(() => assertNoOpenClawAgentDatabaseLeases("main")).toThrow(
                "still open in another process",
              );
              const maintain = vi.fn(async () => undefined);
              await expect(withAgentDatabaseMaintenanceLease({}, maintain)).rejects.toThrow(
                "still open in another process",
              );
              expect(maintain).not.toHaveBeenCalled();
            }
          } finally {
            probe.release();
            await outcome;
          }
          await expect(outcome).resolves.toEqual({
            status: "fulfilled",
            value: { reconciledSessions: 1 },
          });
          const settled = openOpenClawAgentDatabase(databaseOptions);
          expect(settled === database).toBe(!explicitClose);
          expect(readProjectedTranscript(settled, scope.sessionId)).toEqual(expected);
          expect(countAgentDatabaseLeases(database.path)).toBe(1);
          expect(probe.threadId()).toBe(-1);
          // A settled operation must no longer pin its connection against ordinary LRU pressure.
          openCachePressureAgents();
          expect(settled.db.isOpen).toBe(false);
          expect(countAgentDatabaseLeases(database.path)).toBe(0);
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
    30_000,
  );

  it.each(["clean", "worker-create", "worker-url", "preflight-begin", "preflight-commit"] as const)(
    "does not retain a handle after %s preflight/worker startup",
    async (mode) => {
      const stateDir = tempDirs.make("openclaw-reconcile-startup-release-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const options = { agentId: "main" };
        const scope = {
          ...options,
          sessionId: "startup-release",
          sessionKey: "agent:main:startup-release",
        };
        try {
          await persistSessionTranscriptTurn(scope, {
            messages: [
              { eventId: "startup-message", message: { role: "user", content: "Startup release" } },
            ],
            touchSessionEntry: false,
          });
          await waitForSessionTranscriptIndexReconcile(options);
          const database = openOpenClawAgentDatabase(options);
          if (mode !== "clean") {
            database.db
              .prepare(
                "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
              )
              .run(scope.sessionId);
          }
          const exec = database.db.exec.bind(database.db);
          const execSpy = vi.spyOn(database.db, "exec").mockImplementation((sql) => {
            if (
              (mode === "preflight-begin" && sql === "BEGIN IMMEDIATE") ||
              (mode === "preflight-commit" && sql === "COMMIT")
            ) {
              throw new Error(mode);
            }
            return exec(sql);
          });
          const urlSpy =
            mode === "worker-url"
              ? vi.spyOn(runtimeWorkerUrl, "resolveRuntimeWorkerUrl").mockImplementationOnce(() => {
                  throw new Error(mode);
                })
              : undefined;
          const createWorker = vi.fn(() => {
            throw new Error("worker-create");
          });
          try {
            const operation = reconcileSessionTranscriptIndexes({ ...options, createWorker });
            if (mode === "clean") {
              await expect(operation).resolves.toEqual({ reconciledSessions: 0 });
            } else {
              await expect(operation).rejects.toThrow(mode);
            }
            expect(createWorker).toHaveBeenCalledTimes(mode === "worker-create" ? 1 : 0);
            expect(database.db.isTransaction).toBe(false);
          } finally {
            execSpy.mockRestore();
            urlSpy?.mockRestore();
          }
          openCachePressureAgents();
          expect(database.db.isOpen).toBe(false);
          expect(countAgentDatabaseLeases(database.path)).toBe(0);
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
    30_000,
  );

  it.each([
    { expectedTerminal: "done" as const, failAfterFirstPlan: false },
    { expectedTerminal: "failed" as const, failAfterFirstPlan: true },
  ])(
    "keeps the operation pending until lease release after $expectedTerminal",
    async ({ expectedTerminal, failAfterFirstPlan }) => {
      const stateDir = tempDirs.make("openclaw-transcript-worker-cleanup-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const primarySessionId = "cleanup-primary";
        const primaryScope = {
          agentId: "main",
          sessionId: primarySessionId,
          sessionKey: "agent:main:cleanup-primary",
        };
        try {
          await persistSessionTranscriptTurn(primaryScope, {
            messages: [
              {
                eventId: "primary-message",
                message: { role: "user", content: "primary" },
              },
            ],
            touchSessionEntry: false,
          });
          if (failAfterFirstPlan) {
            await persistSessionTranscriptTurn(
              {
                agentId: "main",
                sessionId: "cleanup-malformed",
                sessionKey: "agent:main:cleanup-malformed",
              },
              {
                messages: [
                  {
                    eventId: "malformed-message",
                    message: { role: "user", content: "malformed" },
                  },
                ],
                touchSessionEntry: false,
              },
            );
          }
          await waitForSessionTranscriptIndexReconcile({ agentId: "main" });

          const database = openOpenClawAgentDatabase({ agentId: "main" });
          const databasePath = database.path;
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run(primarySessionId);
          if (failAfterFirstPlan) {
            database.db
              .prepare(
                "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
              )
              .run("cleanup-malformed");
            database.db
              .prepare(
                "UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 1",
              )
              .run("cleanup-malformed");
          }

          const baselineLeaseCount = countAgentDatabaseLeases(databasePath);
          expect(baselineLeaseCount).toBe(1);
          const probe = createCleanupFenceProbe();
          let settled = false;
          const outcome = reconcileSessionTranscriptIndexes({
            agentId: "main",
            createWorker: probe.createWorker,
            preferredSessionId: primarySessionId,
          }).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );

          void outcome.then(() => {
            settled = true;
          });
          try {
            await probe.planStarted;
            expect(countAgentDatabaseLeases(databasePath)).toBe(baselineLeaseCount + 1);
            await waitForCurrentProjection(databasePath, primarySessionId);
            await expect(probe.terminal).resolves.toBe(expectedTerminal);
            await delay(25);
            expect(settled).toBe(false);
            expect(countAgentDatabaseLeases(databasePath)).toBe(baselineLeaseCount + 1);
          } finally {
            probe.release();
          }

          const result = await outcome;
          await expect(probe.terminal).resolves.toBe(expectedTerminal);
          expect(countAgentDatabaseLeases(databasePath)).toBe(baselineLeaseCount);
          if (expectedTerminal === "done") {
            expect(result).toEqual({
              status: "fulfilled",
              value: { reconciledSessions: 1 },
            });
          } else {
            expect(result.status).toBe("rejected");
          }
          openCachePressureAgents();
          expect(database.db.isOpen).toBe(false);
          expect(countAgentDatabaseLeases(databasePath)).toBe(0);
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
    20_000,
  );
});
