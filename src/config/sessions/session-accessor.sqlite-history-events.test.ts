import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { appendTranscriptEvent, persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readRecentSessionTranscriptHistoryEvents,
  readSessionTranscriptHistoryEvents,
} from "./session-accessor.sqlite-history-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const REGRESSION_SQLITE_VARIABLE_LIMIT = 64;
const REGRESSION_MAX_MESSAGES = 32;

function historyEventId(entry: { event: unknown } | undefined): unknown {
  const event = entry?.event;
  return event && typeof event === "object" && "id" in event ? event.id : undefined;
}

function enforceSqliteVariableLimit(database: OpenClawAgentDatabase): void {
  const prepare = database.db.prepare.bind(database.db);
  vi.spyOn(database.db, "prepare").mockImplementation((source) => {
    const variableCount = source.match(/\?/gu)?.length ?? 0;
    if (variableCount > REGRESSION_SQLITE_VARIABLE_LIMIT) {
      throw new Error("too many SQL variables");
    }
    return prepare(source);
  });
}

function insertSyntheticMessages(
  database: OpenClawAgentDatabase,
  sessionId: string,
  additionalCount: number,
): void {
  const lastSeq = additionalCount + 1;
  database.db
    .prepare(
      `WITH RECURSIVE synthetic(seq) AS (
         SELECT 2
         UNION ALL
         SELECT seq + 1 FROM synthetic WHERE seq < ?
       )
       INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       SELECT ?, seq,
         printf('{"type":"message","id":"synthetic-message-%d","parentId":null,"timestamp":"2026-08-15T00:00:00.000Z","message":{"role":"user","content":"synthetic"}}', seq),
         seq
       FROM synthetic`,
    )
    .run(lastSeq, sessionId);
  database.db
    .prepare(
      `WITH RECURSIVE synthetic(seq) AS (
         SELECT 2
         UNION ALL
         SELECT seq + 1 FROM synthetic WHERE seq < ?
       )
       INSERT INTO transcript_event_identities
         (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
       SELECT ?, printf('synthetic-message-%d', seq), seq, 'message', NULL, NULL, seq
       FROM synthetic`,
    )
    .run(lastSeq, sessionId);
  database.db
    .prepare(
      `WITH RECURSIVE synthetic(seq) AS (
         SELECT 2
         UNION ALL
         SELECT seq + 1 FROM synthetic WHERE seq < ?
       )
       INSERT INTO session_transcript_active_events
         (session_id, active_position, event_seq, message_position)
       SELECT ?, seq - 1, seq, seq - 1
       FROM synthetic`,
    )
    .run(lastSeq, sessionId);
  database.db
    .prepare(
      `UPDATE session_transcript_index_state
       SET indexed_seq = ?, leaf_event_id = ?, active_event_count = ?, active_message_count = ?
       WHERE session_id = ?`,
    )
    .run(lastSeq, `synthetic-message-${String(lastSeq)}`, lastSeq, lastSeq, sessionId);
}

function insertSyntheticBoundaryPairs(
  database: OpenClawAgentDatabase,
  sessionId: string,
  pairCount: number,
): void {
  const lastSeq = pairCount * 2 + 1;
  database.db
    .prepare(
      `WITH RECURSIVE synthetic(pair_index) AS (
         SELECT 1
         UNION ALL
         SELECT pair_index + 1 FROM synthetic WHERE pair_index < ?
       )
       INSERT INTO transcript_events (session_id, seq, event_json, created_at)
       SELECT ?, pair_index * 2,
         printf('{"type":"compaction","id":"synthetic-boundary-%d","parentId":null,"timestamp":"2026-08-15T00:00:00.000Z","summary":"synthetic"}', pair_index * 2),
         pair_index * 2
       FROM synthetic
       UNION ALL
       SELECT ?, pair_index * 2 + 1,
         printf('{"type":"message","id":"synthetic-message-%d","parentId":null,"timestamp":"2026-08-15T00:00:00.000Z","message":{"role":"user","content":"synthetic"}}', pair_index * 2 + 1),
         pair_index * 2 + 1
       FROM synthetic`,
    )
    .run(pairCount, sessionId, sessionId);
  database.db
    .prepare(
      `WITH RECURSIVE synthetic(pair_index) AS (
         SELECT 1
         UNION ALL
         SELECT pair_index + 1 FROM synthetic WHERE pair_index < ?
       )
       INSERT INTO transcript_event_identities
         (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
       SELECT ?, printf('synthetic-boundary-%d', pair_index * 2), pair_index * 2,
         'compaction', NULL, NULL, pair_index * 2
       FROM synthetic
       UNION ALL
       SELECT ?, printf('synthetic-message-%d', pair_index * 2 + 1), pair_index * 2 + 1,
         'message', NULL, NULL, pair_index * 2 + 1
       FROM synthetic`,
    )
    .run(pairCount, sessionId, sessionId);
  database.db
    .prepare(
      `WITH RECURSIVE synthetic(pair_index) AS (
         SELECT 1
         UNION ALL
         SELECT pair_index + 1 FROM synthetic WHERE pair_index < ?
       )
       INSERT INTO session_transcript_active_events
         (session_id, active_position, event_seq, message_position)
       SELECT ?, pair_index * 2 - 1, pair_index * 2, NULL
       FROM synthetic
       UNION ALL
       SELECT ?, pair_index * 2, pair_index * 2 + 1, pair_index
       FROM synthetic`,
    )
    .run(pairCount, sessionId, sessionId);
  const activeEventCount = pairCount * 2 + 1;
  const activeMessageCount = pairCount + 1;
  database.db
    .prepare(
      `UPDATE session_transcript_index_state
       SET indexed_seq = ?, leaf_event_id = ?, active_event_count = ?, active_message_count = ?
       WHERE session_id = ?`,
    )
    .run(
      lastSeq,
      `synthetic-message-${String(lastSeq)}`,
      activeEventCount,
      activeMessageCount,
      sessionId,
    );
}

describe("SQLite transcript history events", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-history-events-") },
      sessionId: "history-events-test",
      sessionKey: "agent:main:history-events-test",
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("retains an oversized newest history row without parsing excluded older payloads", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "older", parentId: null, message: { role: "user", content: "older" } }],
      touchSessionEntry: false,
    });
    await appendTranscriptEvent(scope, {
      type: "compaction",
      id: "excluded-boundary",
      parentId: "older",
      timestamp: "2026-08-15T00:00:00.000Z",
      summary: "excluded",
    });
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "oversized-newest",
          parentId: "excluded-boundary",
          message: { role: "assistant", content: "x".repeat(16_384) },
        },
      ],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    database.db
      .prepare(
        `UPDATE transcript_events
         SET event_json = '{'
         WHERE session_id = ? AND seq IN (
           SELECT seq FROM transcript_event_identities
           WHERE session_id = ? AND event_id IN ('older', 'excluded-boundary')
         )`,
      )
      .run(scope.sessionId, scope.sessionId);

    const page = readRecentSessionTranscriptHistoryEvents(scope, {
      maxBytes: 1024,
      maxLines: 3,
      maxMessages: 3,
    });

    expect(page.totalMessages).toBe(3);
    expect(page.events.map(({ event }) => (event as { id?: unknown }).id)).toEqual([
      "oversized-newest",
    ]);
    expect(page.events.map(({ seq }) => seq)).toEqual([3]);
  });

  it("does not read an inactive boundary between active sequence bounds", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "seed", parentId: null, message: { role: "user", content: "seed" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const boundaryEvents = [
      {
        seq: 2,
        id: "active-boundary-2",
        eventJson: JSON.stringify({
          type: "compaction",
          id: "active-boundary-2",
          parentId: "seed",
          timestamp: "2026-08-15T00:00:01.000Z",
          summary: "active",
        }),
        activePosition: 1,
      },
      { seq: 3, id: "inactive-boundary", eventJson: "{", activePosition: undefined },
      {
        seq: 4,
        id: "active-boundary-4",
        eventJson: JSON.stringify({
          type: "compaction",
          id: "active-boundary-4",
          parentId: "active-boundary-2",
          timestamp: "2026-08-15T00:00:02.000Z",
          summary: "active",
        }),
        activePosition: 2,
      },
    ];
    const insertEvent = database.db.prepare(
      "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, ?, ?, ?)",
    );
    const insertIdentity = database.db.prepare(
      `INSERT INTO transcript_event_identities
         (session_id, event_id, seq, event_type, parent_id, message_idempotency_key, created_at)
       VALUES (?, ?, ?, 'compaction', NULL, NULL, ?)`,
    );
    const insertActive = database.db.prepare(
      `INSERT INTO session_transcript_active_events
         (session_id, active_position, event_seq, message_position)
       VALUES (?, ?, ?, NULL)`,
    );
    for (const event of boundaryEvents) {
      insertEvent.run(scope.sessionId, event.seq, event.eventJson, event.seq);
      insertIdentity.run(scope.sessionId, event.id, event.seq, event.seq);
      if (event.activePosition !== undefined) {
        insertActive.run(scope.sessionId, event.activePosition, event.seq);
      }
    }
    database.db
      .prepare(
        `UPDATE session_transcript_index_state
         SET indexed_seq = 4, leaf_event_id = 'active-boundary-4', active_event_count = 3
         WHERE session_id = ?`,
      )
      .run(scope.sessionId);

    const events = readSessionTranscriptHistoryEvents(scope);

    expect(events.map(historyEventId)).toEqual(["seed", "active-boundary-2", "active-boundary-4"]);
  });

  it("bounds metadata bindings when the raw history window exceeds SQLite's limit", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "seed", parentId: null, message: { role: "user", content: "seed" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const bindingCount = REGRESSION_SQLITE_VARIABLE_LIMIT;
    insertSyntheticMessages(database, scope.sessionId, bindingCount);
    enforceSqliteVariableLimit(database);

    const page = readRecentSessionTranscriptHistoryEvents(scope, {
      maxBytes: 1_000_000,
      maxLines: bindingCount + 1,
      maxMessages: REGRESSION_MAX_MESSAGES,
    });

    expect(page.totalMessages).toBe(bindingCount + 1);
    expect(page.events).toHaveLength(REGRESSION_MAX_MESSAGES);
    expect(historyEventId(page.events[0])).toBe(
      `synthetic-message-${String(bindingCount - REGRESSION_MAX_MESSAGES + 2)}`,
    );
    expect(historyEventId(page.events.at(-1))).toBe(
      `synthetic-message-${String(bindingCount + 1)}`,
    );
  });

  it("reads more boundaries than SQLite permits as statement bindings", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [{ eventId: "seed", parentId: null, message: { role: "user", content: "seed" } }],
      touchSessionEntry: false,
    });
    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const bindingCount = REGRESSION_SQLITE_VARIABLE_LIMIT;
    insertSyntheticBoundaryPairs(database, scope.sessionId, bindingCount);
    enforceSqliteVariableLimit(database);

    const events = readSessionTranscriptHistoryEvents(scope);

    expect(events).toHaveLength(bindingCount * 2 + 1);
    expect(historyEventId(events[0])).toBe("seed");
    expect(historyEventId(events.at(-1))).toBe(`synthetic-message-${String(bindingCount * 2 + 1)}`);

    const latestPage = readRecentSessionTranscriptHistoryEvents(scope, {
      maxBytes: 1_000_000,
      maxLines: 2,
      maxMessages: 2,
    });
    expect(latestPage.totalMessages).toBe(bindingCount * 2 + 1);
    expect(latestPage.events.map(historyEventId)).toEqual([
      `synthetic-boundary-${String(bindingCount * 2)}`,
      `synthetic-message-${String(bindingCount * 2 + 1)}`,
    ]);
  });
});
