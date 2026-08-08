import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import { readSessionTranscriptMessageEventPage } from "./session-accessor.sqlite-active-events.js";
import { readSessionTranscriptGuardState } from "./session-accessor.sqlite-active-path.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite id-less transcript boundaries", () => {
  let stateDir: string;
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    stateDir = tempDirs.make("openclaw-idless-transcript-boundary-");
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
      sessionId: "idless-transcript-boundary-test",
      sessionKey: "agent:main:idless-transcript-boundary-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("preserves id-less reset and compaction boundaries from the active projection", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "idless-old", parentId: null, message: { role: "user", content: "old" } },
        {
          eventId: "idless-retained",
          parentId: "idless-old",
          message: { role: "assistant", content: "retained" },
        },
      ],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "reset",
      parentId: "idless-retained",
      timestamp: "2026-07-22T00:00:00.000Z",
      reason: "new",
      firstKeptEntryId: "idless-retained",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-idless-reset",
          parentId: "idless-retained",
          message: { role: "user", content: "after reset" },
        },
      ],
      touchSessionEntry: false,
    });

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const idlessReset = database.db
      .prepare(
        `SELECT event.seq
           FROM session_transcript_active_events AS active
           JOIN transcript_events AS event
             ON event.session_id = active.session_id AND event.seq = active.event_seq
           LEFT JOIN transcript_event_identities AS identity
             ON identity.session_id = event.session_id AND identity.seq = event.seq
          WHERE active.session_id = ? AND json_extract(event.event_json, '$.type') = 'reset'
            AND identity.event_id IS NULL`,
      )
      .get(scope.sessionId);
    expect(idlessReset).toEqual(expect.objectContaining({ seq: expect.any(Number) }));
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 0 });
    expect(
      readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
        (entry) => (entry.event as { id?: unknown }).id,
      ),
    ).toEqual(["idless-retained", "post-idless-reset"]);
    expect(readSessionTranscriptGuardState(scope, "idless-old").expectedEntryOnGuardPath).toBe(
      false,
    );
    expect(
      readSessionTranscriptGuardState(scope, "post-idless-reset").expectedEntryOnGuardPath,
    ).toBe(true);

    await appendTranscriptEvent(scope, {
      type: "reset",
      id: "identified-reset",
      parentId: "post-idless-reset",
      timestamp: "2026-07-22T00:01:00.000Z",
      reason: "new",
      firstKeptEntryId: "post-idless-reset",
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      parentId: "identified-reset",
      timestamp: "2026-07-22T00:02:00.000Z",
      summary: "id-less compaction supersedes reset",
      tokensBefore: 10,
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "post-idless-compaction",
          parentId: "identified-reset",
          message: { role: "assistant", content: "after compaction" },
        },
      ],
      touchSessionEntry: false,
    });

    const idlessCompaction = database.db
      .prepare(
        `SELECT event.seq
           FROM session_transcript_active_events AS active
           JOIN transcript_events AS event
             ON event.session_id = active.session_id AND event.seq = active.event_seq
           LEFT JOIN transcript_event_identities AS identity
             ON identity.session_id = event.session_id AND identity.seq = event.seq
          WHERE active.session_id = ? AND json_extract(event.event_json, '$.type') = 'compaction'
            AND identity.event_id IS NULL`,
      )
      .get(scope.sessionId);
    expect(idlessCompaction).toEqual(expect.objectContaining({ seq: expect.any(Number) }));
    expect(
      database.db
        .prepare("SELECT needs_rebuild FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId),
    ).toEqual({ needs_rebuild: 0 });
    expect(
      readSessionTranscriptMessageEventPage(scope, { maxMessages: 10, offset: 0 }).events.map(
        (entry) => (entry.event as { id?: unknown }).id,
      ),
    ).toEqual(["idless-old", "idless-retained", "post-idless-reset", "post-idless-compaction"]);
  });
});
