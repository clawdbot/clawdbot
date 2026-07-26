import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { listSessionEntries } from "./session-accessor.js";
import { listSqliteSessionEntriesReadOnly } from "./session-accessor.sqlite-entry.js";
import { applySqliteSessionStoreProjection } from "./session-accessor.sqlite-projection.js";

describe("session store cross-process cache coherence", () => {
  let tempDir: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-coherence-"));
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("rejects malformed list pagination values before slicing", () => {
    const listScope = { agentId: "main", env };
    expect(() => listSessionEntries({ ...listScope, offset: -1 })).toThrow(
      /offset must be a non-negative integer/,
    );
    expect(() => listSessionEntries({ ...listScope, limit: 1.5 })).toThrow(
      /limit must be a non-negative integer/,
    );
    expect(() => listSqliteSessionEntriesReadOnly({ ...listScope, limit: Number.NaN })).toThrow(
      /limit must be a non-negative integer/,
    );
  });

  it("preserves literal __proto__ session keys across warm cache reads", () => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "__proto__",
      "proto-session",
      JSON.stringify({ sessionId: "proto-session", updatedAt: now }),
      now,
    );
    db.prepare(
      `INSERT OR IGNORE INTO session_windows
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    ).run("proto-session", "__proto__", now, now);

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const listScope = { agentId: "main", env };
    expect(listSessionEntries(listScope).map((entry) => entry.sessionKey)).toEqual(["__proto__"]);
    expect(listSessionEntries(listScope).map((entry) => entry.sessionKey)).toEqual(["__proto__"]);
  });

  it("preserves SQLite session key ordering across warm cache reads", () => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;
    const now = Date.now();
    for (const sessionKey of ["2", "10", "\u{10000}", "\uE000"]) {
      db.prepare(
        `INSERT OR IGNORE INTO session_nodes
          (session_key, current_session_id, entry_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      ).run(
        sessionKey,
        `session-${sessionKey}`,
        JSON.stringify({ sessionId: `session-${sessionKey}`, updatedAt: now }),
        now,
      );
      db.prepare(
        `INSERT OR IGNORE INTO session_windows
          (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
         VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
      ).run(`session-${sessionKey}`, sessionKey, now, now);
    }

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const listScope = { agentId: "main", env };
    expect(listSessionEntries(listScope).map((entry) => entry.sessionKey)).toEqual([
      "10",
      "2",
      "\uE000",
      "\u{10000}",
    ]);
    expect(listSessionEntries(listScope).map((entry) => entry.sessionKey)).toEqual([
      "10",
      "2",
      "\uE000",
      "\u{10000}",
    ]);
    expect(
      listSessionEntries({ ...listScope, offset: 1, limit: 1 }).map((entry) => entry.sessionKey),
    ).toEqual(["2"]);
  });

  it("detects foreign writes and returns fresh data via cache coherence", () => {
    // 1. Seed 5 sessions, close all connections
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;

    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO session_windows
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    );
    const insertEntry = db.prepare(
      `INSERT OR IGNORE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < 5; i++) {
        const sessionKey = `agent:main:s-${i}`;
        const now = Date.now() - (5 - i) * 60_000;
        insertEntry.run(
          sessionKey,
          `s-${i}`,
          JSON.stringify({
            sessionId: `s-${i}`,
            updatedAt: now,
            heartbeatTaskState: { first: i },
            skillsSnapshot: { activeSkills: ["cache-proof"], updatedAt: now },
          }),
          now,
        );
        insertSession.run(`s-${i}`, sessionKey, now, now);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    // Close all so the main file has the latest stat baseline
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    // 2. Warm the cache with a cold + warm read
    const listScope = { agentId: "main", env };
    const firstRead = listSessionEntries(listScope);
    expect(firstRead).toHaveLength(5);

    // Second read serves from cache (warm)
    const secondRead = listSessionEntries(listScope);
    expect(secondRead).toHaveLength(5);
    secondRead[0]!.entry.sessionId = "caller-mutated-cache-hit";
    secondRead[0]!.entry.heartbeatTaskState!.first = 999;
    const isolatedRead = listSessionEntries(listScope);
    expect(isolatedRead[0]!.entry.sessionId).toBe("s-0");
    expect(isolatedRead[0]!.entry.heartbeatTaskState!.first).toBe(0);
    const lightRead = listSessionEntries({ ...listScope, light: true });
    expect(lightRead[0]!.entry.skillsSnapshot).toBeUndefined();
    lightRead[0]!.entry.heartbeatTaskState!.first = 555;
    const isolatedAfterLightRead = listSessionEntries(listScope);
    expect(isolatedAfterLightRead[0]!.entry.heartbeatTaskState!.first).toBe(0);

    // 3. Simulate a foreign process writing to the SAME SQLite file
    const foreignDb = new DatabaseSync(dbPath);
    const foreignNow = Date.now();
    foreignDb
      .prepare(
        `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        "agent:main:foreign",
        "foreign-1",
        JSON.stringify({ sessionId: "foreign-1", updatedAt: foreignNow }),
        foreignNow,
      );
    foreignDb
      .prepare(
        `INSERT INTO session_windows
          (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
         VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
      )
      .run("foreign-1", "agent:main:foreign", foreignNow, foreignNow);
    foreignDb.close();

    // 4. Read again — the foreign commit changed the database state, so the cache
    //    so the cache detects staleness and falls through to a fresh DB query
    const thirdRead = listSessionEntries(listScope);
    expect(thirdRead).toHaveLength(6);

    const foreignEntry = thirdRead.find((e) => e.sessionKey === "agent:main:foreign");
    expect(foreignEntry).toBeDefined();
    expect(foreignEntry!.entry.sessionId).toBe("foreign-1");

    // Verify the original 5 entries are still there intact
    expect(thirdRead.filter((e) => e.sessionKey.startsWith("agent:main:s-"))).toHaveLength(5);
  });

  it("invalidates cache after a foreign delete", () => {
    // 1. Seed 5 sessions, close all
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;

    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO session_windows
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    );
    const insertEntry = db.prepare(
      `INSERT OR IGNORE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < 5; i++) {
        const sessionKey = `agent:main:d-${i}`;
        const now = Date.now() - (5 - i) * 60_000;
        insertEntry.run(
          sessionKey,
          `d-${i}`,
          JSON.stringify({ sessionId: `d-${i}`, updatedAt: now }),
          now,
        );
        insertSession.run(`d-${i}`, sessionKey, now, now);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    // 2. Warm the cache
    const listScope = { agentId: "main", env };
    expect(listSessionEntries(listScope)).toHaveLength(5);
    const warmRead = listSessionEntries(listScope);
    expect(warmRead).toHaveLength(5);
    warmRead[0]!.entry.sessionId = "caller-mutated-delete-cache-hit";
    const isolatedRead = listSessionEntries(listScope);
    expect(isolatedRead[0]!.entry.sessionId).toBe("d-0");

    // 3. Foreign process deletes one session
    const foreignDb = new DatabaseSync(dbPath);
    foreignDb.exec("DELETE FROM session_nodes WHERE current_session_id = 'd-2'");
    foreignDb.exec("DELETE FROM session_windows WHERE session_id = 'd-2'");
    foreignDb.close();

    // 4. Read again — should have 4 entries, no sign of d-2
    const result = listSessionEntries(listScope);
    expect(result).toHaveLength(4);
    expect(result.find((e) => e.sessionKey === "agent:main:d-2")).toBeUndefined();
  });

  it("invalidates cache after a store projection mutation", async () => {
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;
    const now = Date.now();
    db.prepare(
      `INSERT OR IGNORE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).run(
      "agent:main:projection",
      "projection-before",
      JSON.stringify({ sessionId: "projection-before", updatedAt: now }),
      now,
    );
    db.prepare(
      `INSERT OR IGNORE INTO session_windows
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    ).run("projection-before", "agent:main:projection", now, now);

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const listScope = { agentId: "main", env };
    expect(listSessionEntries(listScope)[0]!.entry.sessionId).toBe("projection-before");
    expect(listSessionEntries(listScope)[0]!.entry.sessionId).toBe("projection-before");

    await applySqliteSessionStoreProjection({
      agentId: "main",
      storePath: dbPath,
      update: (store) => {
        store["agent:main:projection"] = {
          ...store["agent:main:projection"]!,
          sessionId: "projection-after",
          updatedAt: now + 1,
        };
        return { persist: true, result: undefined };
      },
    });

    const afterProjection = listSessionEntries(listScope);
    expect(afterProjection).toHaveLength(1);
    expect(afterProjection[0]!.entry.sessionId).toBe("projection-after");
  });
});
