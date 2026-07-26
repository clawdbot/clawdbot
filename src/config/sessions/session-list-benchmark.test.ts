import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { listSessionEntries } from "./session-accessor.js";
import { invalidateSessionStoreCache } from "./store-cache.js";

const SESSION_COUNT = 5_000;

describe("session list benchmark (5k sessions)", () => {
  let tempDir: string;
  let stateDir: string;
  let env: NodeJS.ProcessEnv;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-bench-sessions-"));
    stateDir = path.join(tempDir, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  });

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("seeds 5k sessions and benchmarks list performance", () => {
    // 1. Open the agent database (creates schema + all tables)
    const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    const database = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath });

    // 2. Bulk-insert 5,000 sessions + session_nodes via raw SQL
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
      for (let i = 0; i < SESSION_COUNT; i++) {
        const sessionKey = i === 0 ? "agent:main:main" : `agent:main:session-${i}`;
        const sessionId = i === 0 ? "main-session" : `session-${String(i).padStart(5, "0")}`;
        const updatedAt = Date.now() - (SESSION_COUNT - i) * 60_000;
        const createdAt = updatedAt;

        const entryJson = JSON.stringify({
          sessionId,
          updatedAt,
          model: "gpt-5.5",
          ...(i % 10 === 0
            ? {
                systemPromptReport: {
                  id: `cmpl-${sessionKey.slice(-8)}`,
                  model: "gpt-5.5",
                  usage: {
                    prompt_tokens: 1200 + (i % 300),
                    completion_tokens: 400 + (i % 150),
                    total_tokens: 1600 + (i % 450),
                  },
                },
                skillsSnapshot: {
                  activeSkills: ["skill-alpha", "skill-beta", "skill-gamma", "skill-delta"],
                  updatedAt,
                },
              }
            : {
                skillsSnapshot: { activeSkills: ["skill-alpha"], updatedAt },
              }),
        });

        insertEntry.run(sessionKey, sessionId, entryJson, updatedAt);
        insertSession.run(sessionId, sessionKey, createdAt, updatedAt);
      }
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }

    // Close everything to clear internal state
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    // 3. COLD LIST (no cache — first call populates cache)
    const listScope = { agentId: "main", env };
    const coldStart = performance.now();
    const coldResult = listSessionEntries(listScope);
    const coldTime = performance.now() - coldStart;
    expect(coldResult).toHaveLength(SESSION_COUNT);

    // 4. WARM LIST (cache hit)
    const warmStart = performance.now();
    const warmResult = listSessionEntries(listScope);
    const warmTime = performance.now() - warmStart;
    expect(warmResult).toHaveLength(SESSION_COUNT);

    // 5. LIGHT LIST (cache hit, strips systemPromptReport + skillsSnapshot)
    const lightScope = { agentId: "main", env, light: true as const };
    const lightStart = performance.now();
    const lightResult = listSessionEntries(lightScope);
    const lightTime = performance.now() - lightStart;
    expect(lightResult).toHaveLength(SESSION_COUNT);
    // Verify light mode strips systemPromptReport
    const entriesWithReports = lightResult.filter((e) => e.entry.systemPromptReport !== undefined);
    expect(entriesWithReports).toHaveLength(0);

    // 6. WRITE + CACHE INVALIDATION
    // Open db, insert one more session via direct SQL, invalidate cache, re-list
    const db2 = openOpenClawAgentDatabase({ agentId: "main", env, path: dbPath }).db;
    const now = Date.now();

    db2
      .prepare(
        `INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(
        "agent:main:brand-new",
        "brand-new-session",
        JSON.stringify({ sessionId: "brand-new-session", updatedAt: now, model: "gpt-5.5" }),
        now,
      );
    db2
      .prepare(
        `INSERT INTO session_windows (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
      )
      .run("brand-new-session", "agent:main:brand-new", now, now);

    // Invalidate the cache (as the real write path does)
    invalidateSessionStoreCache(dbPath);

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const afterWriteStart = performance.now();
    const afterWriteResult = listSessionEntries(listScope);
    const afterWriteTime = performance.now() - afterWriteStart;
    expect(afterWriteResult).toHaveLength(SESSION_COUNT + 1);

    // 7. Print results
    console.log("");
    console.log("═══ SESSION LIST BENCHMARK ═══");
    console.log(`  Sessions seeded:  ${SESSION_COUNT}`);
    console.log(`  Cold list:        ${coldTime.toFixed(1).padStart(8)} ms`);
    console.log(`  Warm list:        ${warmTime.toFixed(1).padStart(8)} ms`);
    console.log(`  Warm light list:  ${lightTime.toFixed(1).padStart(8)} ms`);
    console.log(`  After write:      ${afterWriteTime.toFixed(1).padStart(8)} ms`);
    console.log("═══════════════════════════════");

    // Benchmark measurements are informational only — real performance validation\n    // belongs in a dedicated benchmark harness, not in wall-clock CI assertions.
  });
});
