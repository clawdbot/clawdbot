/** Tests ACP event ledger recording, replay, retention, and SQLite persistence. */
import { constants } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { requireNodeSqlite } from "../infra/node-sqlite.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createSqliteAcpEventLedger } from "./event-ledger.js";
import {
  createTestAcpEventLedger,
  expectAcpReplayUtf8Accounting,
  withTestAcpEventLedgerDatabase,
} from "./event-ledger.test-support.js";

describe("ACP event ledger", () => {
  afterEach(() => {
    closeOpenClawStateDatabaseForTest();
  });

  it("records complete session updates in sequence", async () => {
    const ledger = createTestAcpEventLedger({ now: () => 123 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      runId: "run-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplay({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
    });

    expect(replay.complete).toBe(true);
    expect(replay.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(replay.events.map((event) => event.runId)).toEqual(["run-1", "run-1"]);
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });

  it("marks a session incomplete when event retention truncates history", async () => {
    const ledger = createTestAcpEventLedger({ maxEventsPerSession: 1 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First" },
      },
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second" },
      },
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
    ).resolves.toEqual({ complete: false, events: [] });
  });

  it("falls back for non-finite event retention options", async () => {
    const ledger = createTestAcpEventLedger({ maxEventsPerSession: Number.NaN });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "First" },
      },
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Second" },
      },
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
    ).resolves.toMatchObject({
      complete: true,
      events: [{ seq: 1 }, { seq: 2 }],
    });
  });

  it("persists replay without reading old payloads during session writes or rejected replays", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const first = createSqliteAcpEventLedger({ path: databasePath, now: () => 1000 });
      await first.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await first.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        runId: "run-1",
        update: {
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "Thinking" },
        },
      });
      await expect(
        first.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toMatchObject({ complete: true });

      const session = {
        sessionId: "session-1",
        sessionKey: "agent:main:canonical-work",
        cwd: "/new-work",
        complete: false,
      };
      const { db } = openOpenClawStateDatabase({ path: databasePath });
      // Payload access is unnecessary for append/metadata work and rejected
      // replay; making it fail exposes accidental full-history hydration.
      db.setAuthorizer((action, table, column) =>
        action === constants.SQLITE_READ &&
        table === "acp_replay_events" &&
        column === "update_json"
          ? constants.SQLITE_DENY
          : constants.SQLITE_OK,
      );
      try {
        await first.recordUpdate({
          ...session,
          runId: "run-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Answer" },
          },
        });
        await first.startSession(session);
        await expect(
          first.readReplay({ ...session, sessionKey: "agent:main:work" }),
        ).resolves.toEqual({ complete: false, events: [] });
        await first.markIncomplete(session);
        await expect(first.readReplay(session)).resolves.toEqual({ complete: false, events: [] });
        await expect(first.readReplayBySessionId(session)).resolves.toEqual({
          complete: false,
          events: [],
        });
        await first.startSession({ ...session, complete: true });
      } finally {
        db.setAuthorizer(null);
      }

      closeOpenClawStateDatabaseForTest();
      const second = createSqliteAcpEventLedger({ path: databasePath });
      const replay = await second.readReplay(session);

      expect(replay.complete).toBe(true);
      expect(replay.events.map((event) => [event.seq, event.sessionKey])).toEqual([
        [1, "agent:main:work"],
        [2, "agent:main:canonical-work"],
      ]);
      expect(replay.events[0]?.update).toEqual({
        sessionUpdate: "agent_thought_chunk",
        content: { type: "text", text: "Thinking" },
      });
      expect(replay.events[1]?.update).toEqual({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      });
    });
  });

  it("marks SQLite-backed replay incomplete when event retention truncates history", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const ledger = createSqliteAcpEventLedger({
        path: databasePath,
        maxEventsPerSession: 1,
      });
      await ledger.startSession({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        cwd: "/work",
        complete: true,
      });
      await ledger.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "First" },
        },
      });
      await ledger.recordUpdate({
        sessionId: "session-1",
        sessionKey: "agent:main:work",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "Second" },
        },
      });

      await expect(
        ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
      ).resolves.toEqual({ complete: false, events: [] });
    });
  });

  it.each(["UTF-8", "UTF-16le"])(
    "counts UTF-8 fields through metadata changes and resets in %s databases",
    async (encoding) => {
      await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
        const { DatabaseSync } = requireNodeSqlite();
        const seed = new DatabaseSync(databasePath);
        seed.exec(
          `PRAGMA encoding = '${encoding}'; CREATE TABLE encoding_seed (id INTEGER); DROP TABLE encoding_seed;`,
        );
        seed.close();
        const ledger = createSqliteAcpEventLedger({ path: databasePath });
        const session = {
          sessionId: "session-漢\0\ud800",
          sessionKey: "\udc00-key😀",
          cwd: "/é/e\u0301/台\0😀",
          complete: true,
        };
        const { db } = openOpenClawStateDatabase({ path: databasePath });
        await ledger.startSession(session);
        const initial = expectAcpReplayUtf8Accounting(db);
        for (let count = 0; count < 10; count++) {
          await ledger.startSession(session);
          expect(expectAcpReplayUtf8Accounting(db)).toBe(initial);
        }
        for (const runId of [undefined, "run-😀\0\ud800"]) {
          await ledger.recordUpdate({
            ...session,
            runId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "漢😀\0\ud800é e\u0301" },
            },
          });
          expectAcpReplayUtf8Accounting(db);
        }
        await ledger.startSession({ ...session, sessionKey: "new-台😀", cwd: "/new-😀\0" });
        expectAcpReplayUtf8Accounting(db);
        expect(db.prepare("SELECT COUNT(*) AS count FROM acp_replay_events").get()?.count).toBe(2);
        await ledger.startSession({ ...session, reset: true });
        expect(expectAcpReplayUtf8Accounting(db)).toBe(initial);
        expect(db.prepare("SELECT COUNT(*) AS count FROM acp_replay_events").get()?.count).toBe(0);
      });
    },
  );

  it("marks a Unicode replay incomplete when its UTF-8 content exceeds the byte cap", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const ledger = createSqliteAcpEventLedger({
        path: databasePath,
        maxSerializedBytes: 1024,
      });
      const session = { sessionId: "s", sessionKey: "key", cwd: "", complete: true };
      await ledger.startSession(session);
      await ledger.recordUpdate({
        ...session,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "漢".repeat(400) },
        },
      });
      await expect(ledger.readReplayBySessionId(session)).resolves.toEqual({
        complete: false,
        events: [],
      });
    });
  });

  it("keeps footprint aggregates consistent while the byte budget evicts", async () => {
    await withTestAcpEventLedgerDatabase(async ({ databasePath }) => {
      const ledger = createSqliteAcpEventLedger({
        path: databasePath,
        // Small enough that appends force byte-budget eviction repeatedly.
        maxSerializedBytes: 4_096,
      });
      for (let session = 0; session < 3; session += 1) {
        await ledger.startSession({
          sessionId: `session-😀-${session}`,
          sessionKey: `agent:main:预算-${session}`,
          cwd: "/台\0工作",
          complete: true,
        });
        for (let index = 0; index < 40; index += 1) {
          // Halfway through, the provisional key becomes a longer canonical
          // key: the row-overhead component of the aggregate must follow.
          const sessionKey =
            index < 20 ? `agent:main:预算-${session}` : `agent:main:预算-${session}:canonical-😀`;
          await ledger.recordUpdate({
            sessionId: `session-😀-${session}`,
            sessionKey,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: `payload-${session}-${index}-${"漢😀".repeat(32)}` },
            },
          });
        }
      }

      const { DatabaseSync } = requireNodeSqlite();
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(expectAcpReplayUtf8Accounting(db)).toBeLessThanOrEqual(4_096);
      } finally {
        db.close();
      }
    });
  });

  it("can replay a complete session by Gateway session key", async () => {
    const ledger = createTestAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplayBySessionKey({
      sessionKey: "acp:gateway-session-1",
    });

    expect(replay.complete).toBe(true);
    expect(replay.sessionId).toBe("acp-session-1");
    expect(replay.sessionKey).toBe("acp:gateway-session-1");
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
    ]);
  });

  it("preserves prompt history when a provisional ACP key becomes a canonical Gateway key", async () => {
    const ledger = createTestAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      runId: "run-1",
      prompt: [{ type: "text", text: "Question" }],
    });
    await ledger.recordUpdate({
      sessionId: "acp-session-1",
      sessionKey: "agent:main:acp:gateway-session-1",
      runId: "run-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Answer" },
      },
    });

    const replay = await ledger.readReplayBySessionKey({
      sessionKey: "agent:main:acp:gateway-session-1",
    });

    expect(replay.complete).toBe(true);
    expect(replay.sessionId).toBe("acp-session-1");
    expect(replay.sessionKey).toBe("agent:main:acp:gateway-session-1");
    expect(replay.events.map((event) => event.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "agent_message_chunk",
    ]);
  });

  it("can replay multi-block prompt history by ACP session id", async () => {
    const ledger = createTestAcpEventLedger({ now: () => 1000 });
    await ledger.startSession({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUserPrompt({
      sessionId: "acp-session-1",
      sessionKey: "acp:gateway-session-1",
      runId: "run-1",
      prompt: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    });

    const replay = await ledger.readReplayBySessionId({ sessionId: "acp-session-1" });

    expect(replay.complete).toBe(true);
    expect(replay.sessionKey).toBe("acp:gateway-session-1");
    expect(
      replay.events.map((event) =>
        event.update.sessionUpdate === "user_message_chunk" ? event.update.content : undefined,
      ),
    ).toEqual([
      { type: "text", text: "First" },
      { type: "text", text: "Second" },
    ]);
  });

  it("evicts the oldest complete session when session retention is exceeded", async () => {
    let now = 1000;
    const ledger = createTestAcpEventLedger({ maxSessions: 1, now: () => now++ });
    await ledger.startSession({
      sessionId: "old-session",
      sessionKey: "acp:old-gateway-session",
      cwd: "/work",
      complete: true,
    });
    await ledger.startSession({
      sessionId: "new-session",
      sessionKey: "acp:new-gateway-session",
      cwd: "/work",
      complete: true,
    });

    await expect(
      ledger.readReplay({ sessionId: "old-session", sessionKey: "acp:old-gateway-session" }),
    ).resolves.toEqual({ complete: false, events: [] });
    const replay = await ledger.readReplayBySessionId({ sessionId: "new-session" });
    expect(replay.complete).toBe(true);
    expect(replay.sessionKey).toBe("acp:new-gateway-session");
  });

  it("resets stale events when a session is restarted with reset", async () => {
    const ledger = createTestAcpEventLedger();
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "acp:old-session",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "acp:old-session",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Old answer" },
      },
    });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "acp:new-session",
      cwd: "/work",
      complete: true,
      reset: true,
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "acp:old-session" }),
    ).resolves.toEqual({ complete: false, events: [] });
    const replay = await ledger.readReplayBySessionId({ sessionId: "session-1" });
    expect(replay.complete).toBe(true);
    expect(replay.sessionKey).toBe("acp:new-session");
    expect(replay.events).toEqual([]);
  });

  it("marks replay incomplete when serialized byte retention trims payloads", async () => {
    const ledger = createTestAcpEventLedger({ maxSerializedBytes: 900 });
    await ledger.startSession({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      cwd: "/work",
      complete: true,
    });
    await ledger.recordUpdate({
      sessionId: "session-1",
      sessionKey: "agent:main:work",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { content: "x".repeat(5_000) },
      },
    });

    await expect(
      ledger.readReplay({ sessionId: "session-1", sessionKey: "agent:main:work" }),
    ).resolves.toEqual({ complete: false, events: [] });
  });
});
