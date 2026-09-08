import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import { replaceTranscriptEventsSync } from "../../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { resolveExistingAttemptTranscriptState } from "./attempt-transcript-helpers.js";

it("checks bootstrap history without decoding canonical message payloads", async () => {
  await withOpenClawTestState({ label: "bootstrap-presence" }, async (state) => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "bootstrap-presence",
      sessionKey: "agent:main:bootstrap-presence",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    replaceSessionEntrySync(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
    const payload = "x".repeat(4 * 1024 * 1024);
    replaceTranscriptEventsSync(sessionTarget, [
      { type: "session", id: sessionTarget.sessionId, version: 3 },
      { type: "message", id: "user", message: { role: "user", content: payload } },
      { type: "reset", id: "reset", parentId: null, reason: "new" },
    ]);
    const parse = JSON.parse;
    let parsedPayloadBytes = 0;
    const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (text.length >= payload.length) {
        parsedPayloadBytes += text.length;
      }
      return parse(text, reviver);
    });
    try {
      expect(
        await resolveExistingAttemptTranscriptState({
          ...sessionTarget,
          sessionTarget,
          sessionFile: sessionTarget.sessionKey,
        }),
      ).toEqual({ hasBootstrapTranscriptState: true });
      expect(parsedPayloadBytes).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

it("keeps one presence snapshot while another connection classifies a message", async () => {
  await withOpenClawTestState({ label: "bootstrap-presence-snapshot" }, async (state) => {
    const sessionTarget = {
      agentId: "main",
      sessionId: "bootstrap-presence-snapshot",
      sessionKey: "agent:main:bootstrap-presence-snapshot",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    replaceSessionEntrySync(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(sessionTarget, [
      { type: "message", id: "user", message: { role: "user", content: "present throughout" } },
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
    const writer = new DatabaseSync(database.path);
    writer
      .prepare("UPDATE transcript_event_identities SET event_type = NULL WHERE session_id = ?")
      .run(sessionTarget.sessionId);
    const prepare = database.db.prepare.bind(database.db);
    let classified = false;
    const spy = vi.spyOn(database.db, "prepare").mockImplementation((query) => {
      const statement = prepare(query);
      if (
        !query.includes('"transcript_event_identities"') ||
        query.includes('"transcript_events"')
      ) {
        return statement;
      }
      return new Proxy(statement, {
        get(target, property) {
          if (property === "iterate") {
            return (...params: Parameters<typeof target.iterate>) => {
              const rows = [...target.iterate(...params)];
              // Commit classification after the index probe finishes, while the
              // physical message remains present throughout both connections.
              writer
                .prepare(
                  "UPDATE transcript_event_identities SET event_type = 'message' WHERE session_id = ?",
                )
                .run(sessionTarget.sessionId);
              classified = true;
              return rows.values();
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    try {
      expect(
        await resolveExistingAttemptTranscriptState({
          ...sessionTarget,
          sessionTarget,
          sessionFile: sessionTarget.sessionKey,
        }),
      ).toEqual({ hasBootstrapTranscriptState: true });
      expect(classified).toBe(true);
    } finally {
      spy.mockRestore();
      writer.close();
    }
  });
});

it.each([
  ["metadata", '{"type":"custom","data":{"message":"metadata"}}', false],
  ["native evidence", '{"type":"response_item","message":{"role":"user"}}', false],
  ["id-less message", '{"type":"message","message":{"role":"user"}}', true],
  ["nullable identity type", '{"type":"message","id":"unclassified"}', true, "unclassified"],
  ["message without a body", '{"type":"message"}', true],
  ["non-object", "null", false],
  ["malformed", "{malformed", false],
  ["deep message", `{"type":"message","payload":${"[".repeat(1100)}0${"]".repeat(1100)}}`, true],
] as const)(
  "preserves bootstrap presence for unclassified %s",
  async (_name, raw, expected, identityId?: string) => {
    await withOpenClawTestState({ label: "bootstrap-raw-presence" }, async (state) => {
      const sessionTarget = {
        agentId: "main",
        sessionId: "bootstrap-raw-presence",
        sessionKey: "agent:main:bootstrap-raw-presence",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      replaceSessionEntrySync(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
      // Imported or malformed raw rows can lack the optional identity projection.
      const database = openOpenClawAgentDatabase({ agentId: "main", env: state.env });
      database.db
        .prepare(
          "INSERT INTO transcript_events (session_id, seq, event_json, created_at) VALUES (?, 0, ?, 1)",
        )
        .run(sessionTarget.sessionId, raw);
      if (identityId) {
        database.db
          .prepare(
            "INSERT INTO transcript_event_identities (session_id, event_id, seq, event_type, created_at) VALUES (?, ?, 0, NULL, 1)",
          )
          .run(sessionTarget.sessionId, identityId);
      }
      expect(
        await resolveExistingAttemptTranscriptState({
          ...sessionTarget,
          sessionTarget,
          sessionFile: sessionTarget.sessionKey,
        }),
      ).toEqual({ hasBootstrapTranscriptState: expected });
      expect(database.db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get()).toMatchObject({
        busy: 0,
      });
    });
  },
);
