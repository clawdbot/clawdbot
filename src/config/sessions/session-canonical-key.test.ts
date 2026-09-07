import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS } from "../../state/openclaw-agent-db-additive-columns.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  assignSessionOwner,
  listSessionEntriesReadOnly,
  loadSessionEntryReadOnly,
  recordSessionParticipant,
  replaceSessionEntrySync,
  upsertSessionEntryCore,
} from "./session-accessor.js";
import { scanDoctorSessionEntriesStrict } from "./session-accessor.sqlite-canonical-inventory.js";
import { readSessionEntryCache } from "./session-accessor.sqlite-entry-cache.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { setCanonicalSqliteSessionMainKey } from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createScope() {
  const stateDir = tempDirs.make("openclaw-cold-session-keys-");
  return {
    agentId: "main",
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    storePath: path.join(stateDir, "agents/main/agent/openclaw-agent.sqlite"),
    sessionKey: "agent:main:cold-key",
  };
}

describe("cold canonical session validation", () => {
  it("lists existing metadata without creating absent owner columns", () => {
    const scope = createScope();
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1, label: "existing" });
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    for (const { columnName } of FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS) {
      database.db.exec(`ALTER TABLE session_nodes DROP COLUMN ${columnName}`);
    }
    closeOpenClawAgentDatabasesForTest();
    expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })[0]?.entry).toEqual({
      sessionId: "cold-key",
      updatedAt: 1,
      label: "existing",
      delivery: { kind: "none" },
    });
    const readOnly = new DatabaseSync(scope.storePath, { readOnly: true });
    try {
      const names = new Set(
        readOnly
          .prepare("PRAGMA table_info(session_nodes)")
          .all()
          .map((row) => row.name),
      );
      expect(
        FIRST_USE_ADDITIVE_AGENT_COLUMN_DEFINITIONS.every(
          ({ columnName }) => !names.has(columnName),
        ),
      ).toBe(true);
    } finally {
      readOnly.close();
    }
  });

  it.each([
    '{"sessionId":null,"sessionId":"cold-key","updatedAt":1}',
    '{"sessionId":"cold-key","updatedAt":1,"skillsSnapshot":{},"skillsSnapshot":{"prompt":"last","skills":[]}}',
    `{"sessionId":"cold-key","updatedAt":1,"skillsSnapshot":{"prompt":${"[".repeat(1001)}0${"]".repeat(1001)},"skills":[]}}`,
  ])("keeps source-JSON fallback semantics in the cold metadata handoff (%#)", (entryJson) => {
    const scope = createScope();
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
      .run(entryJson, scope.sessionKey);
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(scope.sessionKey);
    closeOpenClawAgentDatabasesForTest();
    const rows = listSessionEntriesReadOnly({ ...scope, projection: "list" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry).toEqual({ sessionId: "cold-key", updatedAt: 1 });
  });

  it("keeps timestamp-mismatched keys without strengthening Doctor validation", () => {
    const scope = createScope();
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    database.db
      .prepare("UPDATE session_nodes SET updated_at = 2 WHERE session_key = ?")
      .run(scope.sessionKey);
    database.db
      .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
      .run(scope.sessionKey);
    closeOpenClawAgentDatabasesForTest();
    const held = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })).toEqual([]);
    const cached = readSessionEntryCache(held, { cache: true });
    expect(cached.keys).toEqual([scope.sessionKey]);
    expect(cached.entries.size).toBe(0);
    const doctor: SessionEntry[] = [];
    expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => doctor.push(entry))).toBe(1);
    expect(doctor[0]?.updatedAt).toBe(1);
  });

  it("reloads metadata when another connection commits during canonical validation", () => {
    const scope = createScope();
    const entry = { sessionId: "cold-key", updatedAt: 1, label: "before" };
    replaceSessionEntrySync(scope, entry);
    closeOpenClawAgentDatabasesForTest();
    openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    const writer = new DatabaseSync(scope.storePath);
    const originalParse = JSON.parse;
    let committed = false;
    const parse = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const value = originalParse(text, reviver);
      if (!committed && value?.sessionId === entry.sessionId && value?.label === "before") {
        committed = true;
        writer.exec("BEGIN IMMEDIATE");
        writer
          .prepare("UPDATE session_nodes SET entry_json = ?, label = 'after' WHERE session_key = ?")
          .run(JSON.stringify({ ...entry, label: "after" }), scope.sessionKey);
        writer
          .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
          .run(scope.sessionKey);
        writer.exec("COMMIT");
      }
      return value;
    });
    try {
      expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })[0]?.entry.label).toBe(
        "after",
      );
      expect(committed).toBe(true);
      expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })[0]?.entry.label).toBe(
        "after",
      );
    } finally {
      parse.mockRestore();
      writer.close();
    }
  });

  it("does not publish a partial snapshot after a later malformed row", () => {
    const scope = createScope();
    const otherKey = "agent:main:z-later";
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1, label: "before" });
    replaceSessionEntrySync(
      { ...scope, sessionKey: otherKey },
      { sessionId: "later", updatedAt: 1 },
    );
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    database.db
      .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
      .run(otherKey);
    closeOpenClawAgentDatabasesForTest();
    const held = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    expect(() => listSessionEntriesReadOnly({ ...scope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );
    expect(() => listSessionEntriesReadOnly({ ...scope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );
    for (const [key, id] of [
      [scope.sessionKey, "cold-key"],
      [otherKey, "later"],
    ] as const) {
      held.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(JSON.stringify({ sessionId: id, updatedAt: 1, label: "repaired" }), key);
      held.db.prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?").run(key);
    }
    expect(
      listSessionEntriesReadOnly({ ...scope, projection: "list" }).map(({ entry }) => entry.label),
    ).toEqual(["repaired", "repaired"]);
  });

  it("rejects the retired main alias on a cold listing", () => {
    const scope = { ...createScope(), sessionKey: "agent:main:main" };
    replaceSessionEntrySync(scope, { sessionId: "main-alias", updatedAt: 1 });
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    setCanonicalSqliteSessionMainKey(database, "custom");
    closeOpenClawAgentDatabasesForTest();
    expect(() => listSessionEntriesReadOnly({ ...scope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );
  });

  it.each([false, true])(
    "decodes cold list metadata once and preserves projected values (retained handle: %s)",
    (retained) => {
      const scope = createScope();
      const sourceOwner = { actor: { type: "agent" as const, id: "json-owner" } };
      replaceSessionEntrySync(scope, {
        sessionId: "cold-key",
        updatedAt: 1,
        owner: sourceOwner,
        skillsSnapshot: { prompt: "saved prompt".repeat(4096), skills: [] },
      });
      assignSessionOwner(scope, {
        owner: { type: "agent", id: "column-owner" },
        assignedBy: { type: "agent", id: "assigner" },
        assignedAt: 2,
      });
      recordSessionParticipant(scope, {
        identity: { type: "profile", id: "participant" },
        promptedAt: 3,
      });
      const placeholderKey = "agent:main:retained";
      runOpenClawAgentWriteTransaction((database) => {
        ensureTranscriptSessionRoot(
          database,
          { ...scope, sessionKey: placeholderKey, sessionId: "retained" },
          4,
        );
      }, scope);
      closeOpenClawAgentDatabasesForTest();
      closeOpenClawStateDatabaseForTest();
      const database = retained
        ? openOpenClawAgentDatabase({ ...scope, path: scope.storePath })
        : undefined;
      const parse = vi.spyOn(JSON, "parse");
      try {
        const rows = listSessionEntriesReadOnly({ ...scope, projection: "list", clone: false });
        expect(rows).toHaveLength(1);
        expect(rows[0]?.entry).toMatchObject({
          sessionId: "cold-key",
          owner: {
            actor: { type: "agent", id: "column-owner" },
            assignedBy: { type: "agent", id: "assigner" },
            assignedAt: 2,
          },
          participants: [{ identity: { type: "profile", id: "participant" } }],
          participantCount: 1,
        });
        expect(rows[0]?.entry.skillsSnapshot).toBeUndefined();
        expect(
          parse.mock.calls.filter(([value]) => value.includes('"sessionId":"cold-key"')),
        ).toHaveLength(1);
        if (database) {
          const cached = readSessionEntryCache(database, { cache: true });
          expect(cached.keys).toEqual([scope.sessionKey, placeholderKey]);
          expect(cached.entries.has(placeholderKey)).toBe(false);
          expect(cached.entries.get(scope.sessionKey)).toBe(rows[0]?.entry);
        }
      } finally {
        parse.mockRestore();
      }
      const doctor: SessionEntry[] = [];
      expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => doctor.push(entry))).toBe(1);
      expect(doctor[0]?.owner).toBeUndefined();
      expect(doctor[0]?.skillsSnapshot?.prompt).toBe("saved prompt".repeat(4096));
    },
  );

  it("omits saved prompts before decoding keys but retains them for Doctor", async () => {
    const scope = createScope();
    const prompt = "synthetic saved prompt ".repeat(8192);
    await upsertSessionEntryCore(scope, { sessionId: "cold-key", updatedAt: 1 });
    await upsertSessionEntryCore(
      { ...scope, sessionKey: "agent:main:unrelated" },
      { sessionId: "unrelated", updatedAt: 2, skillsSnapshot: { prompt, skills: [] } },
    );
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const parse = vi.spyOn(JSON, "parse");
    try {
      expect(loadSessionEntryReadOnly(scope)?.sessionId).toBe("cold-key");
      expect(parse.mock.calls.filter(([value]) => value.includes(prompt))).toHaveLength(0);
    } finally {
      parse.mockRestore();
    }

    const entries: SessionEntry[] = [];
    expect(scanDoctorSessionEntriesStrict(scope, ({ entry }) => entries.push(entry))).toBe(2);
    expect(entries.find((entry) => entry.sessionId === "unrelated")?.skillsSnapshot?.prompt).toBe(
      prompt,
    );
  });

  it("still rejects divergent lineage on the first read", async () => {
    const scope = createScope();
    await upsertSessionEntryCore(scope, {
      sessionId: "cold-key",
      updatedAt: 1,
      parentSessionKey: "agent:main:parent",
      skillsSnapshot: { prompt: "synthetic saved prompt", skills: [] },
    });
    const database = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    database.db
      .prepare("UPDATE session_nodes SET parent_session_key = ? WHERE session_key = ?")
      .run("agent:main:different", scope.sessionKey);
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    expect(() => loadSessionEntryReadOnly(scope)).toThrow("openclaw doctor --fix");
  });

  it("tolerates a reset racing a flush: complete payload with entry_valid = -1 over a retained window self-heals", () => {
    const scope = createScope();
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1, label: "before" });
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(database, { ...scope, sessionId: "cold-key" }, 2);
    }, scope);
    // Live connection + racing raw writer mirrors the outage (issue #139960):
    // the flush rewrites entry_json (the validity trigger marks the row
    // pending), then the reset's settle step lands entry_valid = -1 over the
    // flushed payload. The tuple must not brick reads.
    const held = openOpenClawAgentDatabase({ ...scope, path: scope.storePath });
    const writer = new DatabaseSync(scope.storePath);
    try {
      writer
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(
          JSON.stringify({ sessionId: "cold-key", updatedAt: 1, label: "flushed" }),
          scope.sessionKey,
        );
      writer
        .prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
        .run(scope.sessionKey);
      expect(() => listSessionEntriesReadOnly({ ...scope, projection: "list" })).not.toThrow();
      expect(() => loadSessionEntryReadOnly(scope)).not.toThrow();
    } finally {
      writer.close();
      void held;
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    // Cold listing tolerates the raced row (no repair error); the entry stays
    // absent until the session's next turn rewrites it.
    expect(listSessionEntriesReadOnly({ ...scope, projection: "list" })).toEqual([]);
    // Recovery completes without an operator: the session's next turn settles
    // the row back to a valid entry and it lists again.
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 3, label: "next-turn" });
    const rows = listSessionEntriesReadOnly({ ...scope, projection: "list" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.entry).toMatchObject({ sessionId: "cold-key", label: "next-turn" });
  });

  it("still requires repair for an unparseable payload with entry_valid = -1, even over a retained window", () => {
    const scope = createScope();
    replaceSessionEntrySync(scope, { sessionId: "cold-key", updatedAt: 1, label: "before" });
    runOpenClawAgentWriteTransaction((database) => {
      ensureTranscriptSessionRoot(database, { ...scope, sessionId: "cold-key" }, 2);
    }, scope);
    const writer = new DatabaseSync(scope.storePath);
    try {
      writer
        .prepare("UPDATE session_nodes SET entry_json = '{' WHERE session_key = ?")
        .run(scope.sessionKey);
      writer
        .prepare("UPDATE session_nodes SET entry_valid = -1 WHERE session_key = ?")
        .run(scope.sessionKey);
    } finally {
      writer.close();
    }
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    expect(() => listSessionEntriesReadOnly({ ...scope, projection: "list" })).toThrow(
      "openclaw doctor --fix",
    );
  });
});
