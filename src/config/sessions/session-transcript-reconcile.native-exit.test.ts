import { setImmediate as checkpoint } from "node:timers/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, expect, it } from "vitest";
import { createDeferred, withTestTimeout } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  persistSessionTranscriptTurn,
  readSessionTranscriptMessageEvents,
} from "./session-accessor.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  isSessionTranscriptIndexReconcileRunning,
  reconcileSessionTranscriptIndexes,
  startSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptIndexReconcilesInStateDir,
} from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const databaseOptions = { agentId: "main" };
const scope = {
  ...databaseOptions,
  sessionId: "native-exit-proof",
  sessionKey: "agent:main:native-exit-proof",
};
type ProjectionStage = "plan-start" | "active-chunk" | "fts-chunk" | "plan-finish";

function createQueuedProjectionFence(stage: ProjectionStage, beforeRelease: () => void) {
  const release = createDeferred();
  const blocked = createDeferred();
  const acknowledged = createDeferred();
  let worker: Worker | undefined;
  let blocker: Promise<void> | undefined;
  let fenced = false;
  return {
    blocked: blocked.promise,
    release: release.resolve,
    createWorker(this: void, filename: string | URL, options: WorkerOptions): Worker {
      const created = new Worker(filename, options);
      worker = created;
      const post = created.postMessage.bind(created);
      created.postMessage = (message: unknown, transferList) => {
        post(message, transferList);
        if (fenced) {
          acknowledged.resolve();
        }
      };
      // Registered before the owner listener: its accepted message uses the same real FIFO.
      created.on("message", (message: SessionTranscriptReconcileWorkerMessage) => {
        if (message.type === stage && !fenced) {
          fenced = true;
          blocker = runExclusiveSqliteSessionWrite(databaseOptions, async () => {
            blocked.resolve();
            await release.promise;
            beforeRelease();
          });
        }
      });
      return created;
    },
    async terminate(): Promise<void> {
      if (!worker) {
        throw new Error("projection worker has not started");
      }
      await worker.terminate();
      expect(worker.threadId).toBe(-1);
    },
    async cleanup(): Promise<void> {
      release.resolve();
      await blocker;
      // On baseline failure, settlement can beat this handler; join it before fixture disposal.
      if (fenced) {
        await withTestTimeout(acknowledged.promise, 5_000, "queued projection did not finish");
      }
      await worker?.terminate();
    },
  };
}

const cases = [
  { stage: "plan-start", scheduled: false, replace: false },
  { stage: "active-chunk", scheduled: false, replace: false },
  { stage: "fts-chunk", scheduled: false, replace: false },
  { stage: "plan-finish", scheduled: false, replace: false },
  { stage: "active-chunk", scheduled: true, replace: false },
  { stage: "active-chunk", scheduled: false, replace: true },
  { stage: "plan-finish", scheduled: false, replace: true },
] satisfies Array<{ stage: ProjectionStage; scheduled: boolean; replace: boolean }>;

it.each(cases)(
  "joins queued $stage on native exit (scheduled=$scheduled, replacement=$replace)",
  async ({ stage, scheduled, replace }) => {
    const stateDir = tempDirs.make("openclaw-native-worker-exit-");
    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const fence = createQueuedProjectionFence(stage, () => {
        if (replace) {
          runOpenClawAgentWriteTransaction((database) => {
            // The canonical replacement publishes a new projection and revokes the old claim.
            replaceSqliteTranscriptEventsInTransaction(database, scope, [
              {
                type: "message",
                id: "replacement",
                parentId: null,
                message: { role: "user", content: "replacement" },
              },
            ]);
          }, databaseOptions);
        }
      });
      let outcome: Promise<unknown> | undefined;
      let drain: Promise<void> | undefined;
      try {
        await persistSessionTranscriptTurn(scope, {
          messages: [{ eventId: "seed", message: { role: "user", content: "synthetic seed" } }],
          touchSessionEntry: false,
        });
        const database = openOpenClawAgentDatabase(databaseOptions);
        database.db
          .prepare(
            "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
          )
          .run(scope.sessionId);
        const sourceRows = () =>
          database.db
            .prepare(
              "SELECT seq, event_json FROM transcript_events WHERE session_id = ? ORDER BY seq",
            )
            .all(scope.sessionId);
        const snapshot = () => ({
          state: database.db
            .prepare("SELECT * FROM session_transcript_index_state WHERE session_id = ?")
            .get(scope.sessionId),
          active: database.db
            .prepare(
              "SELECT * FROM session_transcript_active_events WHERE session_id = ? ORDER BY active_position",
            )
            .all(scope.sessionId),
          fts: database.db
            .prepare(
              "SELECT * FROM session_transcript_fts WHERE session_id = ? ORDER BY message_id",
            )
            .all(scope.sessionId),
        });
        const originalSource = sourceRows();
        const params = { ...databaseOptions, createWorker: fence.createWorker };
        let settled = false;
        if (scheduled) {
          startSessionTranscriptIndexReconcile(params);
          outcome = waitForSessionTranscriptIndexReconcile(databaseOptions).then(() => {
            settled = true;
          });
        } else {
          outcome = reconcileSessionTranscriptIndexes(params).then(
            (value) => {
              settled = true;
              return { status: "fulfilled", value };
            },
            (error: unknown) => {
              settled = true;
              return { status: "rejected", error };
            },
          );
        }
        let drained = false;
        drain = waitForSessionTranscriptIndexReconcilesInStateDir(stateDir).then(() => {
          drained = true;
        });
        await withTestTimeout(fence.blocked, 10_000, "projection did not reach writer fence");
        await fence.terminate();
        await checkpoint();
        expect(settled).toBe(false);
        if (scheduled) {
          expect(drained).toBe(false);
          expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(true);
        }
        fence.release();
        const result = await outcome;
        await drain;
        if (!scheduled) {
          expect(result).toMatchObject({ status: "rejected" });
        }
        expect(isSessionTranscriptIndexReconcileRunning(databaseOptions)).toBe(false);
        const atSettlement = snapshot();
        await runExclusiveSqliteSessionWrite(databaseOptions, async () => undefined);
        await checkpoint();
        expect(snapshot()).toEqual(atSettlement);
        if (!replace) {
          expect(sourceRows()).toEqual(originalSource);
          await reconcileSessionTranscriptIndexes(databaseOptions);
        }
        expect(readSessionTranscriptMessageEvents(scope).map((row) => row.event)).toEqual([
          expect.objectContaining({ id: replace ? "replacement" : "seed" }),
        ]);
      } finally {
        await fence.cleanup();
        await outcome;
        await drain;
        closeOpenClawAgentDatabasesForTest();
        closeOpenClawStateDatabaseForTest();
      }
    });
  },
  20_000,
);
