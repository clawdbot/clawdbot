import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { prepareSessionTranscriptProjection } from "./session-transcript-projection-rebuild.js";

type SessionTranscriptProjectionSourceRow = { seq: number; event: unknown; createdAt: number };

const SESSION_ID = "projection-session";

function row(
  seq: number,
  event: Record<string, unknown>,
  createdAt = seq * 1_000,
): SessionTranscriptProjectionSourceRow {
  return { createdAt, event, seq };
}

function projection(rows: SessionTranscriptProjectionSourceRow[]) {
  const db = openNodeSqliteDatabase(":memory:");
  try {
    db.exec(`CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, transcript_updated_at INTEGER);
      CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, created_at INTEGER,
        PRIMARY KEY (session_id, seq));`);
    db.prepare("INSERT INTO session_windows VALUES (?, ?)").run(SESSION_ID, 42);
    const insert = db.prepare("INSERT INTO transcript_events VALUES (?, ?, ?, ?)");
    for (const sourceRow of rows) {
      insert.run(SESSION_ID, sourceRow.seq, JSON.stringify(sourceRow.event), sourceRow.createdAt);
    }
    return prepareSessionTranscriptProjection(db, SESSION_ID)!;
  } finally {
    db.close();
  }
}

describe("canonical session transcript projection", () => {
  it("projects one deterministic active branch for both rebuild owners", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(1, {
        id: "root",
        message: { content: "root text", role: "user" },
        parentId: null,
        type: "message",
      }),
      row(2, {
        id: "abandoned",
        message: { content: "abandoned text", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
      row(3, {
        id: "active",
        message: { content: "active text", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
    ]);

    expect(result).toMatchObject({
      activeEventCount: 2,
      activeMessageCount: 2,
      leafEventId: "active",
      sessionId: SESSION_ID,
      sourceIndexedSeq: 3,
      sourceTranscriptUpdatedAt: 42,
    });
    expect(result.activeRows).toEqual([
      { activePosition: 0, contextEligible: 1, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, contextEligible: 1, eventSeq: 3, messagePosition: 1 },
    ]);
    expect(result.ftsRows).toEqual([
      { messageId: "root", role: "user", text: "root text", timestamp: 1_000 },
      { messageId: "active", role: "assistant", text: "active text", timestamp: 3_000 },
    ]);
  });

  it("keeps persisted row timestamps for timestamp-less and invalid-timestamp messages", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(
        1,
        {
          id: "old-user",
          message: { content: [{ text: "old content", type: "text" }], role: "user" },
          parentId: null,
          type: "message",
        },
        1_700_000_000_000,
      ),
      row(
        2,
        {
          id: "invalid-timestamp",
          message: { content: "still old", role: "assistant" },
          parentId: "old-user",
          timestamp: "not a date",
          type: "message",
        },
        1_700_000_001_000,
      ),
    ]);

    expect(result.ftsRows.map(({ messageId, timestamp }) => ({ messageId, timestamp }))).toEqual([
      { messageId: "old-user", timestamp: 1_700_000_000_000 },
      { messageId: "invalid-timestamp", timestamp: 1_700_000_001_000 },
    ]);
  });

  it("respects a leaf-control rewind without indexing the abandoned continuation", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 3 }),
      row(1, {
        id: "root",
        message: { content: "keep", role: "user" },
        parentId: null,
        type: "message",
      }),
      row(2, {
        id: "abandoned",
        message: { content: "remove", role: "assistant" },
        parentId: "root",
        type: "message",
      }),
      row(3, {
        appendParentId: "root",
        id: "rewind",
        parentId: "abandoned",
        targetId: "root",
        type: "leaf",
      }),
    ]);

    expect(result.leafEventId).toBe("root");
    expect(result.activeRows).toEqual([
      { activePosition: 0, contextEligible: 1, eventSeq: 1, messagePosition: 0 },
    ]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual(["root"]);
  });

  it("keeps legacy flat-message ordering and searchable identities", () => {
    const result = projection([
      row(0, { id: SESSION_ID, type: "session", version: 1 }),
      row(1, {
        id: "legacy-user",
        message: { content: "first", role: "user" },
        type: "message",
      }),
      row(2, {
        id: "legacy-assistant",
        message: { content: "second", role: "assistant" },
        type: "message",
      }),
    ]);

    expect(result.activeRows).toEqual([
      { activePosition: 0, contextEligible: 1, eventSeq: 1, messagePosition: 0 },
      { activePosition: 1, contextEligible: 1, eventSeq: 2, messagePosition: 1 },
    ]);
    expect(result.ftsRows.map((entry) => entry.messageId)).toEqual([
      "legacy-user",
      "legacy-assistant",
    ]);
    expect(result.sourceIndexedSeq).toBe(2);
  });
});
