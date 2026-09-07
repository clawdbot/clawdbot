import { expect, it, vi } from "vitest";
import { clearNodeSqliteKyselyCacheForDatabase } from "../../infra/kysely-sync.js";
import { openNodeSqliteDatabase } from "../../infra/node-sqlite.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { persistSessionTranscriptTurn, readTranscriptStatsSync } from "./session-accessor.js";
import { readSessionTranscriptBoundedActiveContextCore } from "./session-accessor.sqlite-active-context.js";
import {
  readRecentSessionTranscriptMessageEvents,
  readSessionTranscriptActiveStats,
  readSessionTranscriptBoundedMessageTailPage,
  readSessionTranscriptVisibleMessageDeltaCore,
} from "./session-accessor.sqlite-active-events.js";
import type { SessionTranscriptReadScope } from "./session-accessor.sqlite-contract.js";
import { readTranscriptRawDelta } from "./session-accessor.sqlite-delta.js";
import { readRecentSessionTranscriptHistoryEvents } from "./session-accessor.sqlite-history-events.js";
import {
  shouldRebuildSessionTranscriptIndexSynchronously,
  SYNC_REBUILD_MAX_BYTES,
} from "./session-transcript-index.js";

type SqliteInstruction = {
  opcode: string;
  p1: number;
  p2: number;
  p5: number;
};

const readers: Array<
  [string, (scope: SessionTranscriptReadScope & { agentId: string }) => unknown]
> = [
  ["usage stats", readTranscriptStatsSync],
  ["active stats", readSessionTranscriptActiveStats],
  [
    "rebuild preflight",
    (scope) =>
      shouldRebuildSessionTranscriptIndexSynchronously(
        openOpenClawAgentDatabase({ agentId: scope.agentId, env: scope.env }).db,
        scope.sessionId,
      ),
  ],
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
    "recent usage tail",
    (scope) =>
      readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1024,
        maxLines: 10,
        maxMessages: 10,
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
        {
          eventId: "display",
          parentId: "large",
          message: {
            role: "custom",
            customType: "activity",
            excludeFromContext: true,
            display: true,
            content: "🦞".repeat(4096),
          },
        },
        { eventId: "small", parentId: "display", message: { role: "assistant", content: "done" } },
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
    const readinessQueries: string[] = [];
    const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (
        statement
          .columns()
          .some(
            ({ name }) =>
              name === "size_bytes" || name === "serialized_bytes" || name === "event_bytes",
          )
      ) {
        sizingQueries.push(query);
      }
      if (
        query.includes("context_eligible") &&
        statement.columns().some(({ name }) => name === "session_id")
      ) {
        readinessQueries.push(query);
      }
      return statement;
    });
    try {
      read(scope);
    } finally {
      spy.mockRestore();
    }

    expect(sizingQueries.length).toBeGreaterThan(0);
    if (_name === "active stats" || _name === "active context") {
      expect(readinessQueries.length).toBeGreaterThan(0);
    }
    for (const query of readinessQueries) {
      const plan = prepare(`EXPLAIN QUERY PLAN ${query}`).all();
      expect(plan.map((row) => row.detail).join("\n")).toContain(
        "idx_agent_transcript_context_pending",
      );
      const instructions = prepare(`EXPLAIN ${query}`).all() as SqliteInstruction[];
      expect(instructions.some((op) => op.opcode === "OpenRead" && op.p2 === table?.rootpage)).toBe(
        false,
      );
    }
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

it.each(["incoming", "stored"])(
  "defers a rebuild when %s UTF-8 bytes exceed the synchronous budget",
  (source) => {
    const db = openNodeSqliteDatabase(":memory:");
    try {
      db.exec("CREATE TABLE transcript_events (session_id TEXT, event_json TEXT)");
      const event = { message: { role: "user", content: "🦞".repeat(SYNC_REBUILD_MAX_BYTES / 4) } };
      const serialized = JSON.stringify(event);
      expect(serialized.length).toBeLessThan(SYNC_REBUILD_MAX_BYTES);
      expect(Buffer.byteLength(serialized)).toBeGreaterThan(SYNC_REBUILD_MAX_BYTES);
      expect(
        shouldRebuildSessionTranscriptIndexSynchronously(db, "budget", [{ message: "small" }]),
      ).toBe(true);
      if (source === "stored") {
        db.prepare("INSERT INTO transcript_events VALUES (?, ?)").run("budget", serialized);
      }
      expect(
        shouldRebuildSessionTranscriptIndexSynchronously(
          db,
          "budget",
          source === "incoming" ? [event] : [],
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  },
);

it.each([false, true])(
  "keeps a contiguous usage tail with newest oversized=%s",
  async (oversized) => {
    await withOpenClawTestState({ label: "usage-tail-budget" }, async (state) => {
      const scope = {
        agentId: "main",
        env: state.env,
        sessionId: "usage-tail",
        sessionKey: "agent:main:usage-tail",
      };
      await persistSessionTranscriptTurn(scope, {
        messages: ["old", "large", "new"].map((eventId, index, ids) => ({
          eventId,
          parentId: ids[index - 1] ?? null,
          message: {
            role: "assistant",
            content:
              eventId === "large" || (oversized && eventId === "new") ? "🦞".repeat(1024) : eventId,
          },
        })),
        touchSessionEntry: false,
      });
      const page = readRecentSessionTranscriptMessageEvents(scope, {
        maxBytes: 1024,
        maxLines: 10,
        maxMessages: 10,
      });
      expect(page.totalMessages).toBe(3);
      expect(page.events).toEqual([
        expect.objectContaining({ event: expect.objectContaining({ id: "new" }) }),
      ]);
    });
  },
);
