import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { persistSessionTranscriptTurn } from "./session-accessor.js";
import {
  readSessionTranscriptConversationSnapshot,
  readSessionTranscriptMessageEventCount,
} from "./session-accessor.sqlite-active-events.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("SQLite conversation snapshot", () => {
  let scope: {
    agentId: string;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    sessionKey: string;
  };

  beforeEach(() => {
    scope = {
      agentId: "main",
      env: { ...process.env, OPENCLAW_STATE_DIR: tempDirs.make("openclaw-snapshot-") },
      sessionId: "snapshot-test",
      sessionKey: "agent:main:snapshot-test",
    };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
  });

  it("keeps selected rows and same-turn provenance on one snapshot", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: [
        {
          eventId: "seed",
          parentId: null,
          message: { role: "assistant", content: "seed" },
        },
      ],
      touchSessionEntry: false,
    });
    expect(readSessionTranscriptMessageEventCount(scope)).toBe(1);

    const database = openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env });
    const state = database.db
      .prepare(
        `
          SELECT indexed_seq, active_event_count, active_message_count
          FROM session_transcript_index_state
          WHERE session_id = ?
        `,
      )
      .get(scope.sessionId) as {
      active_event_count: number;
      active_message_count: number;
      indexed_seq: number;
    };
    const nextSeq = state.indexed_seq + 1;
    const appendedEvent = {
      type: "message",
      id: "concurrent",
      parentId: "seed",
      message: { role: "assistant", content: "concurrent" },
    };
    const { DatabaseSync } = requireNodeSqlite();
    const writer = new DatabaseSync(database.path);
    writer.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 1000; PRAGMA foreign_keys = ON;");
    let appended = false;
    const select = (event: unknown) => {
      if (!appended) {
        appended = true;
        writer.exec("BEGIN IMMEDIATE;");
        try {
          writer
            .prepare(
              `
                INSERT INTO transcript_events (session_id, seq, event_json, created_at)
                VALUES (?, ?, ?, ?)
              `,
            )
            .run(scope.sessionId, nextSeq, JSON.stringify(appendedEvent), Date.now());
          writer
            .prepare(
              `
                INSERT INTO transcript_event_identities
                  (session_id, event_id, seq, event_type, parent_id,
                   message_idempotency_key, created_at)
                VALUES (?, 'concurrent', ?, 'message', 'seed', NULL, ?)
              `,
            )
            .run(scope.sessionId, nextSeq, Date.now());
          writer
            .prepare(
              `
                INSERT INTO session_transcript_active_events
                  (session_id, active_position, event_seq, message_position)
                VALUES (?, ?, ?, ?)
              `,
            )
            .run(scope.sessionId, state.active_event_count, nextSeq, state.active_message_count);
          writer
            .prepare(
              `
                UPDATE session_transcript_index_state
                SET indexed_seq = ?, leaf_event_id = 'concurrent', needs_rebuild = 0,
                    active_event_count = active_event_count + 1,
                    active_message_count = active_message_count + 1,
                    updated_at = ?
                WHERE session_id = ?
              `,
            )
            .run(nextSeq, Date.now(), scope.sessionId);
          writer.exec("COMMIT;");
        } catch (error) {
          writer.exec("ROLLBACK;");
          throw error;
        }
      }
      return Boolean(event);
    };

    try {
      const concurrentRead = readSessionTranscriptConversationSnapshot(scope, {
        select,
        maxResults: 10,
      });
      expect(concurrentRead.map((entry) => (entry.event as { id?: string }).id)).toEqual(["seed"]);
      expect(concurrentRead[0]?.precedingSameTurn).toEqual([]);

      const afterCommit = readSessionTranscriptConversationSnapshot(scope, {
        select: () => true,
        maxResults: 10,
      });
      expect(afterCommit.map((entry) => (entry.event as { id?: string }).id)).toEqual([
        "seed",
        "concurrent",
      ]);
      expect(
        afterCommit[1]?.precedingSameTurn.map((entry) => (entry.event as { id?: string }).id),
      ).toEqual(["seed"]);
    } finally {
      writer.close();
    }
  });

  it("preserves configured replay limits above 128", async () => {
    await persistSessionTranscriptTurn(scope, {
      messages: Array.from({ length: 140 }, (_, index) => ({
        eventId: `bounded-${index}`,
        message: { role: "assistant" as const, content: `message ${index}` },
      })),
      touchSessionEntry: false,
    });

    const rows = readSessionTranscriptConversationSnapshot(scope, {
      select: () => true,
      maxResults: 140,
    });

    expect(rows).toHaveLength(140);
    // SAFETY: The fixture writes only message events with string IDs.
    const ids = rows.map((row) => (row.event as { id?: string }).id);
    expect(ids[0]).toBe("bounded-0");
    expect(ids.at(-1)).toBe("bounded-139");
  });
});
