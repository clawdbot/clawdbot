/**
 * Session-list lifecycle test — exercises the session cache across the
 * full lifecycle: seed → cold list → warm list → external write → stale
 * detect → re-cache → delete → stale detect.
 */
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

describe("session cache list lifecycle (5k sessions)", () => {
  let tempDir: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  let dbPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-gateway-flow-"));
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

  it("cache stays warm across mutations for a large persisted session list", () => {
    const count = 5000;
    // 1. Seed 5k sessions via direct DB writes
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

    const now = Date.now();
    db.exec("BEGIN IMMEDIATE");
    try {
      for (let i = 0; i < count; i++) {
        const sessionKey = `agent:main:s-${i}`;
        insertEntry.run(
          sessionKey,
          `s-${i}`,
          JSON.stringify({ sessionId: `s-${i}`, updatedAt: now }),
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

    // 2. Cold read (re-open, first list)
    const listScope = { agentId: "main", env };
    const coldStart = performance.now();
    const coldResult = listSessionEntries(listScope);
    const coldMs = performance.now() - coldStart;
    expect(coldResult).toHaveLength(count);

    // 3. Warm read (cache hit)
    const warmStart = performance.now();
    const warmResult = listSessionEntries(listScope);
    const warmMs = performance.now() - warmStart;
    expect(warmResult).toHaveLength(count);

    // 4. Simulate external process writing 10 new sessions
    const foreignDb = new DatabaseSync(dbPath);
    const fInsertSession = foreignDb.prepare(
      `INSERT OR IGNORE INTO session_windows
        (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
    );
    const fInsertEntry = foreignDb.prepare(
      `INSERT OR IGNORE INTO session_nodes
        (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
    );
    for (let i = count; i < count + 10; i++) {
      const sessionKey = `agent:main:s-${i}`;
      fInsertEntry.run(
        sessionKey,
        `s-${i}`,
        JSON.stringify({ sessionId: `s-${i}`, updatedAt: now }),
        now,
      );
      fInsertSession.run(`s-${i}`, sessionKey, now, now);
    }
    foreignDb.close();

    // 5. Post-mutation list — cache detects stale data_version, re-reads,
    //    and re-warms. Should still be fast.
    const postMutStart = performance.now();
    const postMutResult = listSessionEntries(listScope);
    const postMutMs = performance.now() - postMutStart;
    expect(postMutResult).toHaveLength(count + 10);

    // 6. Simulate external process deleting 5 sessions
    const foreignDb2 = new DatabaseSync(dbPath);
    const fDelete = foreignDb2.prepare(`DELETE FROM session_nodes WHERE session_key = ?`);
    const fDeleteSession = foreignDb2.prepare(`DELETE FROM session_windows WHERE session_id = ?`);
    for (let i = 0; i < 5; i++) {
      fDelete.run(`agent:main:s-${i}`);
      fDeleteSession.run(`s-${i}`);
    }
    foreignDb2.close();

    // 7. Post-delete list — cache detects stale, re-reads, re-warms
    const postDelResult = listSessionEntries(listScope);
    expect(postDelResult).toHaveLength(count + 5);

    // 8. Close and reopen, verify stale detect still works
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    const staleResult = listSessionEntries(listScope);
    expect(staleResult).toHaveLength(count + 5);

    // Summary
    console.log(`\n═══ GATEWAY FLOW (5k+10 sessions) ═══`);
    console.log(`  Cold read (re-open):     ${coldMs.toFixed(1)} ms`);
    console.log(`  Warm read (cache hit):   ${warmMs.toFixed(1)} ms`);
    console.log(`  Post-mutation read:      ${postMutMs.toFixed(1)} ms`);
    console.log(`  Cold → Warm speedup:     ${((1 - warmMs / coldMs) * 100).toFixed(0)}%`);
    console.log(`  Post-delete count:       ${postDelResult.length} (from ${count + 10})`);
    console.log(`  Stale detect (re-open):  verified`);
    console.log(`═══════════════════════════════════════\n`);
  });
});
