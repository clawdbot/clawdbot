import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import { loadSharedRunIntegrationHarness } from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
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

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.projection-retry" });
  });

  afterEach(async () => {
    await state?.cleanup();
    expect(
      agentDatabase
        .listOpenClawAgentDatabasesForTest()
        .filter((database) => database.path.startsWith(`${state.stateDir}${path.sep}`)),
    ).toEqual([]);
    await expect(fs.stat(state.root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("settles an owned compacted retry before durable reopen while ordinary reads stay fail-fast", async () => {
    const sessionId = "projection-retry-session";
    const sessionKey = "agent:main:projection-retry";
    const storePath = state.statePath("alternate", "sessions.json");
    const sessionTarget = { agentId: "main", sessionId, sessionKey, storePath };
    await sessionAccessor.replaceSessionEntry(sessionTarget, { sessionId, updatedAt: 1 });
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
        .mockResolvedValueOnce(
          makeAttemptResult({
            timedOut: true,
            sessionIdUsed: sessionId,
            lastAssistant: { usage: { input: 160_000 } } as never,
          }),
        )
        .mockImplementationOnce(async () => {
          expect(ownedProjectionSettled).toBe(true);
          expect(
            activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
              maxMessages: 1,
              offset: 0,
            }).totalMessages,
          ).toBe(1);
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
        ...createOverflowRunParams(state),
        runId: "run-owned-projection-retry",
        sessionId,
        sessionKey,
        sessionFile: sessionKey,
        sessionTarget,
        abortSignal: controller.signal,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(waitForProjection).toHaveBeenCalledOnce();
      expect(waitForProjection).toHaveBeenCalledWith(
        { ...sessionTarget, expectedWriterRunId: "run-owned-projection-retry" },
        controller.signal,
      );
      agentDatabase.closeOpenClawAgentDatabaseByPath(
        agentDatabase.resolveOpenClawAgentSqlitePath(databaseOptions),
      );
      expect(
        activeEvents.readSessionTranscriptMessageEventPage(sessionTarget, {
          maxMessages: 1,
          offset: 0,
        }).totalMessages,
      ).toBe(1);
    } finally {
      waitForProjection.mockRestore();
      await reconcile.waitForSessionTranscriptIndexReconcile(databaseOptions);
    }
  });
});
