import { setTimeout as delay } from "node:timers/promises";
import { Worker, type WorkerOptions } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { withEnvAsync } from "../../test-utils/env.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  reconcileSessionTranscriptIndexes,
  waitForSessionTranscriptIndexReconcile,
} from "./session-transcript-reconcile.js";
import type { SessionTranscriptReconcileWorkerMessage } from "./session-transcript-reconcile.worker.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type TerminalType = Extract<
  SessionTranscriptReconcileWorkerMessage,
  { type: "done" | "failed" }
>["type"];

function countAgentDatabaseLeases(pathname: string): number {
  // SAFETY: SQLite COUNT(*) always returns one row with the numeric alias requested here.
  const row = openOpenClawStateDatabase()
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
  it.each([
    { expectedTerminal: "done" as const, failAfterFirstPlan: false },
    { expectedTerminal: "failed" as const, failAfterFirstPlan: true },
  ])(
    "releases its database before reporting $expectedTerminal",
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
          const outcome = reconcileSessionTranscriptIndexes({
            agentId: "main",
            createWorker: probe.createWorker,
            preferredSessionId: primarySessionId,
          }).then(
            (value) => ({ status: "fulfilled" as const, value }),
            (error: unknown) => ({ status: "rejected" as const, error }),
          );

          let terminalWhileCleanupWasFenced: TerminalType | undefined;
          try {
            await probe.planStarted;
            expect(countAgentDatabaseLeases(databasePath)).toBe(baselineLeaseCount + 1);
            await waitForCurrentProjection(databasePath, primarySessionId);
            terminalWhileCleanupWasFenced = await Promise.race([
              probe.terminal,
              delay(1_000).then(() => undefined),
            ]);
          } finally {
            probe.release();
          }

          const result = await outcome;
          expect(terminalWhileCleanupWasFenced).toBeUndefined();
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
        } finally {
          closeOpenClawAgentDatabasesForTest();
          closeOpenClawStateDatabaseForTest();
        }
      });
    },
    20_000,
  );
});
