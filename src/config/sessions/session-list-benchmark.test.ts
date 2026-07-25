import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { listSessionEntries, listSessionEntriesReadOnly } from "./session-accessor.js";
import { invalidateSessionStoreCache } from "./store-cache.js";

const SESSION_COUNT = 5_000;

type SeedSessionOptions = {
  count: number;
  dbPath: string;
  env: NodeJS.ProcessEnv;
  keyPrefix?: string;
  includeHeavyFields?: boolean;
};

function seedSessions(params: SeedSessionOptions): void {
  const database = openOpenClawAgentDatabase({
    agentId: "main",
    env: params.env,
    path: params.dbPath,
  });
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
    for (let i = 0; i < params.count; i += 1) {
      const prefix = params.keyPrefix ?? "session";
      const sessionKey = i === 0 ? "agent:main:main" : `agent:main:${prefix}-${i}`;
      const sessionId = i === 0 ? "main-session" : `${prefix}-${String(i).padStart(5, "0")}`;
      const updatedAt = Date.now() - (params.count - i) * 60_000;
      const createdAt = updatedAt;
      const entryJson = JSON.stringify({
        sessionId,
        updatedAt,
        model: "gpt-5.5",
        ...(params.includeHeavyFields
          ? {
              skillsSnapshot: { activeSkills: ["skill-alpha"], prompt: "heavy-prompt" },
              systemPromptReport: { id: `cmpl-${i}`, usage: { total_tokens: 100 + i } },
            }
          : {}),
      });

      insertSession.run(sessionId, sessionKey, createdAt, updatedAt);
      insertEntry.run(sessionKey, sessionId, entryJson, updatedAt);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

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
    const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    seedSessions({ count: SESSION_COUNT, dbPath, env, includeHeavyFields: true });

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
        `INSERT INTO sessions (session_id, session_key, session_scope, created_at, updated_at, status, chat_type)
       VALUES (?, ?, 'conversation', ?, ?, 'running', 'direct')`,
      )
      .run("brand-new-session", "agent:main:brand-new", now, now);
    db2
      .prepare(
        `INSERT INTO session_entries (session_key, session_id, entry_json, updated_at)
       VALUES (?, ?, ?, ?)`,
      )
      .run(
        "agent:main:brand-new",
        "brand-new-session",
        JSON.stringify({ sessionId: "brand-new-session", updatedAt: now, model: "gpt-5.5" }),
        now,
      );

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

    // Warm should be faster than cold
    expect(warmTime).toBeLessThan(coldTime);
    expect(lightTime).toBeLessThan(coldTime);
  });

  it("returns the same ordered page from cached and uncached lists", () => {
    const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    seedSessions({ count: 12, dbPath, env, keyPrefix: "page" });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const scope = { agentId: "main", env, limit: 4, offset: 3 };
    const uncachedPage = listSessionEntries(scope);

    const fullScope = { agentId: "main", env };
    expect(listSessionEntries(fullScope)).toHaveLength(12);
    const cachedPage = listSessionEntries(scope);

    expect(cachedPage).toEqual(uncachedPage);
    expect(cachedPage.map((entry) => entry.sessionKey)).toEqual([
      "agent:main:page-11",
      "agent:main:page-2",
      "agent:main:page-3",
      "agent:main:page-4",
    ]);
  });

  it("strips heavy fields from read-only light listings", () => {
    const dbPath = path.join(stateDir, "agents", "main", "agent", "openclaw-agent.sqlite");
    seedSessions({ count: 3, dbPath, env, includeHeavyFields: true, keyPrefix: "light" });
    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const fullEntries = listSessionEntriesReadOnly({ agentId: "main", env });
    expect(fullEntries.some((entry) => entry.entry.systemPromptReport !== undefined)).toBe(true);
    expect(fullEntries.some((entry) => entry.entry.skillsSnapshot !== undefined)).toBe(true);

    const lightEntries = listSessionEntriesReadOnly({ agentId: "main", env, light: true });
    expect(lightEntries).toHaveLength(fullEntries.length);
    expect(lightEntries.every((entry) => entry.entry.systemPromptReport === undefined)).toBe(true);
    expect(lightEntries.every((entry) => entry.entry.skillsSnapshot === undefined)).toBe(true);
  });
});
