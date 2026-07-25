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

  it("detects foreign writes via PRAGMA data_version and returns fresh data", () => {
    // 1. Seed 5 sessions, close all connections
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;

    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO sessions
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    );
    const insertEntry = db.prepare(
      `INSERT OR IGNORE INTO session_entries
        (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < 5; i++) {
        const sessionKey = `agent:main:s-${i}`;
        const now = Date.now() - (5 - i) * 60_000;
        insertSession.run(`s-${i}`, sessionKey, now, now);
        insertEntry.run(
          sessionKey,
          `s-${i}`,
          JSON.stringify({ sessionId: `s-${i}`, updatedAt: now }),
          now,
        );
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

    // 3. Simulate a foreign process writing to the SAME SQLite file
    const foreignDb = new DatabaseSync(dbPath);
    foreignDb.exec(
      `INSERT INTO sessions (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES ('foreign-1', 'agent:main:foreign', 'conversation', ${Date.now()}, ${Date.now()}, 'running', 'direct')`,
    );
    foreignDb.exec(
      `INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
       VALUES ('agent:main:foreign', 'foreign-1', '${JSON.stringify({ sessionId: "foreign-1", updatedAt: Date.now() }).replace(/'/g, "''")}', ${Date.now()})`,
    );

    foreignDb.close();

    // 4. Read again — PRAGMA data_version has changed after the foreign commit,
    //    so the cache detects staleness and falls through to a fresh DB query
    const thirdRead = listSessionEntries(listScope);
    expect(thirdRead).toHaveLength(6);

    const foreignEntry = thirdRead.find((e) => e.sessionKey === "agent:main:foreign");
    expect(foreignEntry).toBeDefined();
    expect(foreignEntry!.entry.sessionId).toBe("foreign-1");

    // Verify the original 5 entries are still there intact
    expect(thirdRead.filter((e) => e.sessionKey.startsWith("agent:main:s-"))).toHaveLength(5);
  });

  it("invalidates cache after a foreign delete detected via data_version", () => {
    // 1. Seed 5 sessions, close all
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });
    const db = database.db;

    const insertSession = db.prepare(
      `INSERT OR IGNORE INTO sessions
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    );
    const insertEntry = db.prepare(
      `INSERT OR IGNORE INTO session_entries
        (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    );

    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < 5; i++) {
        const sessionKey = `agent:main:d-${i}`;
        const now = Date.now() - (5 - i) * 60_000;
        insertSession.run(`d-${i}`, sessionKey, now, now);
        insertEntry.run(
          sessionKey,
          `d-${i}`,
          JSON.stringify({ sessionId: `d-${i}`, updatedAt: now }),
          now,
        );
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

    // 3. Foreign process deletes one session
    const foreignDb = new DatabaseSync(dbPath);
    foreignDb.exec("DELETE FROM sessions WHERE session_id = 'd-2'");
    foreignDb.exec("DELETE FROM session_entries WHERE session_id = 'd-2'");
    foreignDb.close();

    // 4. Read again — should have 4 entries, no sign of d-2
    const result = listSessionEntries(listScope);
    expect(result).toHaveLength(4);
    expect(result.find((e) => e.sessionKey === "agent:main:d-2")).toBeUndefined();
  });
});
