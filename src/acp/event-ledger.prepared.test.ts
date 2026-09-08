import path from "node:path";
import { constants } from "node:sqlite";
import { SqliteQueryCompiler } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import { expectAcpReplayUtf8Accounting } from "./event-ledger.test-support.js";

const update = (text: string) => ({
  sessionUpdate: "agent_message_chunk" as const,
  content: { type: "text" as const, text },
});

describe("ACP prepared queries", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    closeOpenClawStateDatabaseForTest();
  });

  it("reuses warm append queries while binding fresh metadata, sequence and payload values", async () => {
    await withTestDir({ prefix: "openclaw-acp-prepared-" }, async (dir) => {
      const options = { path: path.join(dir, "state.sqlite") };
      let now = 100;
      const ledger = createSqliteAcpEventLedger({ ...options, now: () => now++ });
      const session = { sessionId: "session", sessionKey: "key", cwd: "/work", complete: true };
      await ledger.startSession(session);
      for (let index = 0; index < 3; index++) {
        await ledger.recordUpdate({ ...session, update: update(`warm-${index}`) });
      }
      const { db } = openOpenClawStateDatabase(options);
      const prepare = vi.spyOn(db, "prepare");
      const compile = vi.spyOn(SqliteQueryCompiler.prototype, "compileQuery");
      try {
        for (let index = 0; index < 4; index++) {
          await ledger.recordUpdate({
            sessionId: session.sessionId,
            sessionKey: `key-${index}-漢😀`,
            runId: index % 2 ? `run-${index}` : undefined,
            update: update(`payload-${index}-漢\0\ud800`),
          });
        }
        expect(prepare.mock.calls.filter(([sql]) => sql.includes("acp_replay_"))).toHaveLength(0);
        expect(
          compile.mock.results.filter(
            (result) => result.type === "return" && result.value.sql.includes("acp_replay_"),
          ),
        ).toHaveLength(0);
      } finally {
        prepare.mockRestore();
        compile.mockRestore();
      }
      const replay = await ledger.readReplayBySessionId(session);
      expect(replay).toMatchObject({ complete: true, sessionKey: "key-3-漢😀" });
      expect(db.prepare("SELECT updated_at, next_seq FROM acp_replay_sessions").get()).toEqual({
        updated_at: 114,
        next_seq: 8,
      });
      expect(
        replay.events
          .slice(3)
          .map((event) => [event.seq, event.sessionKey, event.runId, event.update]),
      ).toEqual(
        Array.from({ length: 4 }, (_, index) => [
          index + 4,
          `key-${index}-漢😀`,
          index % 2 ? `run-${index}` : undefined,
          update(`payload-${index}-漢\0\ud800`),
        ]),
      );
      expect(replay.events.slice(3).map((event) => event.at)).toEqual([108, 110, 112, 114]);
      expectAcpReplayUtf8Accounting(db);

      closeOpenClawStateDatabaseForTest();
      await ledger.recordUpdate({ ...session, update: update("after reopen") });
      const reopened = await ledger.readReplayBySessionId(session);
      expect(reopened.events.at(-1)).toMatchObject({ seq: 8, update: update("after reopen") });
      expectAcpReplayUtf8Accounting(openOpenClawStateDatabase(options).db);
    });
  });

  it("keeps oversized bindings fresh and honors authorization after statements warm", async () => {
    await withTestDir({ prefix: "openclaw-acp-prepared-" }, async (dir) => {
      const options = { path: path.join(dir, "state.sqlite") };
      const ledger = createSqliteAcpEventLedger(options);
      const session = { sessionId: "session", sessionKey: "key", cwd: "/work", complete: true };
      await ledger.startSession(session);
      for (let index = 0; index < 3; index++) {
        await ledger.recordUpdate({ ...session, update: update(`warm-${index}`) });
      }
      const large = "漢".repeat(32 * 1024);
      await ledger.recordUpdate({ ...session, update: update(large) });
      await ledger.recordUpdate({ ...session, update: update("small after large") });
      const { db } = openOpenClawStateDatabase(options);
      db.setAuthorizer((action, table) =>
        action === constants.SQLITE_INSERT && table === "acp_replay_events"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        await expect(
          ledger.recordUpdate({ ...session, update: update("refused") }),
        ).rejects.toThrow(/not authorized/i);
      } finally {
        db.setAuthorizer(null);
      }
      await ledger.recordUpdate({ ...session, update: update("accepted") });
      const replay = await ledger.readReplayBySessionId(session);
      expect(replay.events.slice(3).map((event) => [event.seq, event.update])).toEqual([
        [4, update(large)],
        [5, update("small after large")],
        [6, update("accepted")],
      ]);
      expectAcpReplayUtf8Accounting(db);
    });
  });

  it("retains the later prompt block after an earlier block exhausts the byte budget", async () => {
    await withTestDir({ prefix: "openclaw-acp-prepared-" }, async (dir) => {
      const options = { path: path.join(dir, "state.sqlite") };
      const ledger = createSqliteAcpEventLedger({ ...options, maxSerializedBytes: 1024 });
      const session = { sessionId: "s", sessionKey: "k", cwd: "", complete: true };
      await ledger.startSession(session);
      await ledger.recordUserPrompt({
        ...session,
        runId: "run",
        prompt: [
          { type: "text", text: "漢".repeat(400) },
          { type: "text", text: "tail" },
        ],
      });
      const { db } = openOpenClawStateDatabase(options);
      expect(db.prepare("SELECT seq, update_json FROM acp_replay_events").all()).toEqual([
        {
          seq: 2,
          update_json: JSON.stringify({
            sessionUpdate: "user_message_chunk",
            content: { type: "text", text: "tail" },
          }),
        },
      ]);
      await expect(ledger.readReplayBySessionId(session)).resolves.toEqual({
        complete: false,
        events: [],
      });
      expectAcpReplayUtf8Accounting(db);
    });
  });

  it("uses each ledger's current caps when sharing a connection with gapped event sequences", async () => {
    await withTestDir({ prefix: "openclaw-acp-prepared-" }, async (dir) => {
      const options = { path: path.join(dir, "state.sqlite"), now: () => 100 };
      const roomy = createSqliteAcpEventLedger({
        ...options,
        maxEventsPerSession: 10,
        maxSessions: 3,
      });
      const narrow = createSqliteAcpEventLedger({
        ...options,
        maxEventsPerSession: 2,
        maxSessions: 2,
      });
      for (const sessionId of ["a", "b", "c"]) {
        const session = { sessionId, sessionKey: `key-${sessionId}`, cwd: "/work", complete: true };
        await roomy.startSession(session);
        for (let index = 0; index < 3; index++) {
          await roomy.recordUpdate({ ...session, update: update(`${sessionId}-${index}`) });
        }
      }
      const { db } = openOpenClawStateDatabase(options);
      // Imported/retained history can have gaps; next_seq is not an event count.
      db.exec(
        "UPDATE acp_replay_events SET seq = seq * 10; UPDATE acp_replay_sessions SET next_seq = 31",
      );
      await narrow.startSession({
        sessionId: "a",
        sessionKey: "key-a",
        cwd: "/narrow",
        complete: true,
      });
      expect(
        db.prepare("SELECT session_id FROM acp_replay_sessions ORDER BY session_id").all(),
      ).toEqual([{ session_id: "a" }, { session_id: "b" }]);
      expect(
        db.prepare("SELECT session_id, seq FROM acp_replay_events ORDER BY session_id, seq").all(),
      ).toEqual([
        { session_id: "a", seq: 20 },
        { session_id: "a", seq: 30 },
        { session_id: "b", seq: 20 },
        { session_id: "b", seq: 30 },
      ]);
      expectAcpReplayUtf8Accounting(db);
      await roomy.recordUpdate({ sessionId: "b", sessionKey: "key-b", update: update("new") });
      expect(
        db.prepare("SELECT seq FROM acp_replay_events WHERE session_id = 'b' ORDER BY seq").all(),
      ).toEqual([{ seq: 20 }, { seq: 30 }, { seq: 31 }]);
      await expect(roomy.readReplayBySessionId({ sessionId: "b" })).resolves.toEqual({
        complete: false,
        events: [],
      });
      expectAcpReplayUtf8Accounting(db);
    });
  });
});
