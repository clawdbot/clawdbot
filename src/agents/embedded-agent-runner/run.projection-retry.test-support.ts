import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
let agentDatabase: typeof import("../../state/openclaw-agent-db.js");
let sessionAccessor: typeof import("../../config/sessions/session-accessor.js");
let activeEvents: typeof import("../../config/sessions/session-accessor.sqlite-active-events.js");
let sqliteScope: typeof import("../../config/sessions/session-accessor.sqlite-scope.js");
let reconcile: typeof import("../../config/sessions/session-transcript-reconcile.js");

describe("runEmbeddedAgent transcript projection retry", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    agentDatabase = await import("../../state/openclaw-agent-db.js");
    sessionAccessor = await import("../../config/sessions/session-accessor.js");
    activeEvents = await import("../../config/sessions/session-accessor.sqlite-active-events.js");
    sqliteScope = await import("../../config/sessions/session-accessor.sqlite-scope.js");
    reconcile = await import("../../config/sessions/session-transcript-reconcile.js");
  });

  beforeEach(() => {
    resetSharedRunIntegrationHarnessMocks();
  });

  it.each(["compaction", "global-finalize", "source-finalize"] as const)(
    "settles an owned %s retry before durable reopen while ordinary reads stay fail-fast",
    async (retryKind) => {
      const sessionId = `projection-retry-${retryKind}`;
      const sessionKey = "agent:main:projection-retry";
      const storePath = path.join(tempDirs.make("openclaw-projection-retry-"), "sessions.json");
      const sessionTarget = { agentId: "main", sessionId, sessionKey, storePath };
      await sessionAccessor.persistSessionTranscriptTurn(sessionTarget, {
        messages: [
          {
            eventId: "seed",
            parentId: null,
            message: { role: "user", content: "seed" },
          },
        ],
        touchSessionEntry: false,
      });
      const databaseOptions = sqliteScope.toDatabaseOptions(
        sqliteScope.resolveSqliteTranscriptReadScope(sessionTarget),
      );
      const controller = new AbortController();
      const originalWaitForProjection = reconcile.waitForSessionTranscriptProjection;
      let ownedProjectionSettled = false;
      const waitForProjection = vi
        .spyOn(reconcile, "waitForSessionTranscriptProjection")
        .mockImplementation(async (scope, abortSignal) => {
          await originalWaitForProjection(scope, abortSignal);
          expect(
            agentDatabase
              .openOpenClawAgentDatabase(databaseOptions)
              .db.prepare(
                "SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
              )
              .get(sessionId),
          ).toEqual({ needs_rebuild: 0 });
          ownedProjectionSettled = true;
        });

      try {
        mockedRunEmbeddedAttempt
          .mockImplementationOnce(async () => {
            if (retryKind === "compaction") {
              return makeAttemptResult({
                timedOut: true,
                sessionIdUsed: sessionId,
                lastAssistant: { usage: { input: 160_000 } } as never,
              });
            }
            await sessionAccessor.persistSessionTranscriptTurn(sessionTarget, {
              messages: [
                {
                  eventId: "rejected",
                  parentId: "seed",
                  message: { role: "assistant", content: "Rejected candidate" },
                },
              ],
              touchSessionEntry: false,
            });
            // Match the settlement owner's append-only rewind. Leaf controls dirty
            // even a tiny transcript; the next attempt must join its scheduled rebuild.
            await sessionAccessor.appendTranscriptEvent(sessionTarget, {
              type: "leaf",
              id: "rewind",
              parentId: "rejected",
              targetId: "seed",
              appendParentId: "seed",
            });
            expect(() =>
              activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
                maxMessages: 1,
                offset: 0,
              }),
            ).toThrow(activeEvents.SessionTranscriptProjectionUnavailableError);
            return makeAttemptResult({
              sessionIdUsed: sessionId,
              beforeAgentFinalizeRevisionReason: "Use the updated room context.",
              beforeAgentFinalizeRevisionDisableTools:
                retryKind === "source-finalize" ? true : undefined,
            });
          })
          .mockImplementationOnce(async () => {
            const page = activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
              maxMessages: 1,
              offset: 0,
            });
            expect(page.totalMessages).toBe(1);
            expect(ownedProjectionSettled).toBe(true);
            return makeAttemptResult({ sessionIdUsed: sessionId });
          });
        mockedCompactDirect.mockImplementationOnce(async () => {
          const database = agentDatabase.openOpenClawAgentDatabase(databaseOptions);
          database.db
            .prepare(
              "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?",
            )
            .run(sessionId);

          expect(() =>
            activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
              maxMessages: 1,
              offset: 0,
            }),
          ).toThrow(activeEvents.SessionTranscriptProjectionUnavailableError);
          reconcile.startSessionTranscriptIndexReconcile({
            ...databaseOptions,
            preferredSessionId: sessionId,
          });
          return makeCompactionSuccess({
            summary: "compacted before projection retry",
            tokensBefore: 160_000,
            tokensAfter: 60_000,
          });
        });

        await runEmbeddedAgent({
          ...overflowBaseRunParams,
          runId: "run-owned-projection-retry",
          sessionId,
          sessionKey,
          sessionFile: sessionKey,
          sessionTarget,
          abortSignal: controller.signal,
        });

        expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
        expect(waitForProjection).toHaveBeenCalledOnce();
        expect(waitForProjection).toHaveBeenCalledWith(sessionTarget, controller.signal);
      } finally {
        waitForProjection.mockRestore();
        await reconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
        agentDatabase.closeOpenClawAgentDatabasesForTest();
      }
    },
  );
});
