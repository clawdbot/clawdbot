import { describe, expect, it } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { ReadOnlySqliteTranscriptReader } from "./doctor-session-sqlite-transcript-readers.js";

describe("read-only SQLite transcript readers", () => {
  it.each([
    { stage: "label detection", header: false, failingSeq: 0 },
    { stage: "nested label snapshot", header: false, failingSeq: 1 },
    { stage: "header snapshot", header: true, failingSeq: 1 },
    { stage: "first header row", header: true, failingSeq: 0 },
  ])("isolates a $stage step failure from the next session", ({ header, failingSeq }) => {
    const database = openNodeSqliteDatabase(":memory:");
    try {
      // json() fails during native stepping. The primary key lets the first row
      // reach detection before a later row fails in the complete snapshot.
      database.exec(`
        CREATE TABLE source_rows (
          session_id TEXT,
          seq INTEGER,
          created_at INTEGER,
          event_json TEXT,
          PRIMARY KEY (session_id, seq)
        );
        CREATE VIEW transcript_events AS
          SELECT session_id, seq, created_at, json(event_json) AS event_json FROM source_rows;
        CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT);
        INSERT INTO session_windows VALUES
          ('broken', 'agent:main:broken'), ('healthy', 'agent:main:healthy');
      `);
      const insert = database.prepare("INSERT INTO source_rows VALUES (?, ?, ?, ?)");
      insert.run("broken", 0, 10, failingSeq === 0 ? "{" : '{"type":"message","id":"first"}');
      if (failingSeq === 1) {
        insert.run("broken", 1, 11, "{");
      }
      const healthyEvents = [
        '{"type":"message","id":"healthy-first"}',
        '{"type":"message","id":"healthy-second"}',
      ];
      for (const [seq, eventJson] of healthyEvents.entries()) {
        insert.run("healthy", seq, 20 + seq, eventJson);
      }

      const reader = new ReadOnlySqliteTranscriptReader(database);
      const read = (sessionId: string) =>
        header
          ? reader.headerlessSnapshot(sessionId)
          : reader.repairSnapshot(sessionId, () => true);
      expect(read("broken")).toMatchObject({
        ok: false,
        error: { message: expect.stringMatching(/malformed JSON/iu) },
      });
      expect(read("healthy")).toEqual({
        ok: true,
        rows: healthyEvents.map((eventJson, seq) =>
          header ? { eventJson, seq, createdAt: 20 + seq } : { eventJson, seq },
        ),
        ...(header ? { sessionKey: "agent:main:healthy" } : {}),
      });
    } finally {
      database.close();
    }
  });
});
