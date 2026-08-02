import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import { appendTranscriptEventInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import {
  claimPreparedSessionTranscriptProjectionInTransaction,
  finalizePreparedSessionTranscriptProjectionInTransaction,
  prepareSessionTranscriptProjection,
} from "./session-transcript-projection-rebuild.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

describe("session transcript projection tail claim", () => {
  it("rejects an oversized append tail before replacing the existing projection", async () => {
    const stateDir = tempDirs.make("openclaw-projection-tail-claim-");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "projection-tail-claim-test",
      sessionKey: "agent:main:projection-tail-claim-test",
    };
    const databaseOptions = { agentId: scope.agentId, env: scope.env };
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      for (let index = 0; index < 513; index += 1) {
        appendTranscriptEventInTransaction(
          writeDatabase,
          scope,
          {
            type: "message",
            id: `oversized-row-tail-${index}`,
            parentId: index === 0 ? "root" : `oversized-row-tail-${index - 1}`,
            message: { role: "assistant", content: `tail row ${index}` },
          },
          { scheduleProjectionReconcile: false },
        );
      }
    }, databaseOptions);

    expect(
      runOpenClawAgentWriteTransaction(
        (writeDatabase) =>
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -45),
        databaseOptions,
      ),
    ).toBe(false);
    expect(
      database.db
        .prepare(
          "SELECT indexed_seq, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ indexed_seq: plan!.sourceIndexedSeq, needs_rebuild: 1 });
    expect(
      database.db
        .prepare(
          "SELECT count(*) AS count FROM session_transcript_active_events WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ count: 1 });
  });

  it("rejects a reset tail that can change prior visibility", async () => {
    const stateDir = tempDirs.make("openclaw-projection-tail-reset-");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "projection-tail-reset-test",
      sessionKey: "agent:main:projection-tail-reset-test",
    };
    const databaseOptions = { agentId: scope.agentId, env: scope.env };
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      appendTranscriptEventInTransaction(
        writeDatabase,
        scope,
        {
          type: "reset",
          id: "racing-reset",
          parentId: "root",
          firstKeptEntryId: "root",
        },
        { scheduleProjectionReconcile: false },
      );
    }, databaseOptions);

    const claimId = -46;
    expect(
      runOpenClawAgentWriteTransaction(
        (writeDatabase) =>
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, claimId),
        databaseOptions,
      ),
    ).toBe(true);
    expect(
      runOpenClawAgentWriteTransaction(
        (writeDatabase) =>
          finalizePreparedSessionTranscriptProjectionInTransaction(
            writeDatabase.db,
            plan!,
            claimId,
          ),
        databaseOptions,
      ),
    ).toBe(false);
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 1 });
  });

  it("rejects a byte-oversized append tail before replacing the existing projection", async () => {
    const stateDir = tempDirs.make("openclaw-projection-tail-bytes-");
    const scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "projection-tail-byte-test",
      sessionKey: "agent:main:projection-tail-byte-test",
    };
    const databaseOptions = { agentId: scope.agentId, env: scope.env };
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "root", parentId: null, message: { role: "user", content: "root" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase(databaseOptions);
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    const plan = prepareSessionTranscriptProjection(database.db, scope.sessionId);
    expect(plan).toBeDefined();

    runOpenClawAgentWriteTransaction((writeDatabase) => {
      appendTranscriptEventInTransaction(
        writeDatabase,
        scope,
        {
          type: "message",
          id: "oversized-byte-tail",
          parentId: "root",
          message: { role: "assistant", content: "x".repeat(256 * 1024) },
        },
        { scheduleProjectionReconcile: false },
      );
    }, databaseOptions);

    expect(
      runOpenClawAgentWriteTransaction(
        (writeDatabase) =>
          claimPreparedSessionTranscriptProjectionInTransaction(writeDatabase.db, plan!, -47),
        databaseOptions,
      ),
    ).toBe(false);
    expect(
      database.db
        .prepare(
          "SELECT indexed_seq, needs_rebuild FROM session_transcript_index_state WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ indexed_seq: plan!.sourceIndexedSeq, needs_rebuild: 1 });
    expect(
      database.db
        .prepare(
          "SELECT count(*) AS count FROM session_transcript_active_events WHERE session_id = ?",
        )
        .get(scope.sessionId),
    ).toEqual({ count: 1 });
  });
});
