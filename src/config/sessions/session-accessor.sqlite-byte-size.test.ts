import { expect, it, vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistSessionTranscriptTurn, readTranscriptStatsSync } from "./session-accessor.js";
import {
  readSessionTranscriptActiveStats,
  readSessionTranscriptBoundedActiveContextCore,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptVisibleMessageDeltaCore,
} from "./session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.js";

type SqliteInstruction = {
  opcode: string;
  p1: number;
  p2: number;
  p5: number;
};

const readers: Array<[string, (scope: SessionTranscriptReadScope) => unknown]> = [
  ["usage stats", readTranscriptStatsSync],
  ["active stats", readSessionTranscriptActiveStats],
  ["raw delta", (scope) => readTranscriptRawDelta(scope, { maxBytes: 1024 })],
  [
    "visible delta",
    (scope) => readSessionTranscriptVisibleMessageDeltaCore(scope, { maxBytes: 1024 }),
  ],
  [
    "active context",
    (scope) =>
      readSessionTranscriptBoundedActiveContextCore(scope, { maxBytes: 1024, maxEvents: 10 }),
  ],
  [
    "message tail",
    (scope) =>
      readSessionTranscriptBoundedMessageTailPage(scope, {
        maxBytes: 1024,
        maxMessages: 10,
        offset: 0,
      }),
  ],
  [
    "history tail",
    (scope) =>
      readRecentSessionTranscriptHistoryEvents(scope, {
        maxBytes: 1024,
        maxLines: 10,
        maxMessages: 10,
      }),
  ],
];

it.each(readers)("sizes %s without reading transcript overflow payloads", async (_name, read) => {
  await withOpenClawTestState({ label: "transcript-byte-size" }, async (state) => {
    const scope = {
      agentId: "main",
      env: state.env,
      sessionId: "byte-size",
      sessionKey: "agent:main:byte-size",
    };
    await persistSessionTranscriptTurn(scope, {
      messages: [
        { eventId: "large", parentId: null, message: { role: "user", content: "🦞".repeat(4096) } },
        { eventId: "small", parentId: "large", message: { role: "assistant", content: "done" } },
      ],
      touchSessionEntry: false,
    });
    const { db } = openOpenClawAgentDatabase({ agentId: scope.agentId, env: state.env });
    const table = db
      .prepare(
        "SELECT rootpage FROM sqlite_schema WHERE type = 'table' AND name = 'transcript_events'",
      )
      .get();
    const column = db
      .prepare("SELECT cid FROM pragma_table_info('transcript_events') WHERE name = 'event_json'")
      .get();
    expect(table).toBeDefined();
    expect(column).toBeDefined();
    clearNodeSqliteKyselyCacheForDatabase(db);
    const prepare = db.prepare.bind(db);
    const sizingQueries: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (
        statement.columns().some(({ name }) => name === "size_bytes" || name === "serialized_bytes")
      ) {
        sizingQueries.push(query);
      }
      return statement;
    });
    try {
      read(scope);
    } finally {
      spy.mockRestore();
    }

    expect(sizingQueries.length).toBeGreaterThan(0);
    for (const query of sizingQueries) {
      const instructions = prepare(`EXPLAIN ${query}`).all() as SqliteInstruction[];
      const transcriptCursors = new Set(
        instructions
          .filter((op) => op.opcode === "OpenRead" && op.p2 === table?.rootpage)
          .map((op) => op.p1),
      );
      const payloadReads = instructions.filter(
        (op) => op.opcode === "Column" && transcriptCursors.has(op.p1) && op.p2 === column?.cid,
      );
      expect(payloadReads.length).toBeGreaterThan(0);
      // SQLite's OPFLAG_BYTELENARG (sqliteInt.h) tells OP_Column to skip overflow pages.
      // Inspect the executed production query, not a hand-copied SQL expression or timing threshold.
      expect(payloadReads.every((op) => (op.p5 & 0xc0) === 0xc0)).toBe(true);
    }
  });
});
