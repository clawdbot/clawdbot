import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("SQLite live-node disk budget eviction", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-live-budget-",
      layout: "state-only",
    });
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    resetAgentRunRegistryForTest();
    vi.restoreAllMocks();
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  it("evicts idle durable live nodes under disk pressure after historical reclaim", async () => {
    const mainKey = "agent:main:main";
    const idleThreadKey = "agent:main:slack:channel:C1:thread:1";
    const admittedThreadKey = "agent:main:slack:channel:C2:thread:2";
    await replaceSessionEntry(
      { sessionKey: mainKey, storePath },
      { sessionId: "live-main", updatedAt: 40 },
    );
    await appendTranscriptMessage(
      { sessionId: "live-main", sessionKey: mainKey, storePath },
      { message: { role: "user", content: "main keep" } },
    );
    await createHistoricalTranscript({
      content: "tiny history",
      nextSessionId: "scratch-live",
      sessionId: "scratch-old",
      sessionKey: "agent:main:scratch",
      updatedAt: 1,
    });
    await replaceSessionEntry(
      { sessionKey: idleThreadKey, storePath },
      { sessionId: "idle-thread-live", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-thread-live", sessionKey: idleThreadKey, storePath },
      { message: { role: "user", content: "idle live " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: admittedThreadKey, storePath },
      { sessionId: "admitted-thread", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "admitted-thread", sessionKey: admittedThreadKey, storePath },
      { message: { role: "user", content: "admitted keep" } },
    );
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [admittedThreadKey],
      assertAllowed: () => {},
    });
    try {
      settlePhysicalUsage();
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const maintenance = {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      };
      const inspected = await inspectSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });

      expect(inspected.wouldMutate).toBe(true);
      expect(result?.removedEntries).toBeGreaterThanOrEqual(1);
      expect(sessionExists("idle-thread-live")).toBe(false);
      expect(sessionExists("live-main")).toBe(true);
      expect(sessionExists("admitted-thread")).toBe(true);
    } finally {
      admission.release();
    }
  });

  it("inspects and evicts idle durable live nodes when no historical generations remain", async () => {
    const mainKey = "agent:main:main";
    const idleThreadKey = "agent:main:slack:channel:c3:thread:3";
    const admittedThreadKey = "agent:main:slack:channel:c4:thread:4";
    await replaceSessionEntry(
      { sessionKey: mainKey, storePath },
      { sessionId: "live-main", updatedAt: 40 },
    );
    await appendTranscriptMessage(
      { sessionId: "live-main", sessionKey: mainKey, storePath },
      { message: { role: "user", content: "main keep" } },
    );
    await replaceSessionEntry(
      { sessionKey: idleThreadKey, storePath },
      { sessionId: "idle-thread-live", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-thread-live", sessionKey: idleThreadKey, storePath },
      { message: { role: "user", content: "idle live " + "x".repeat(64 * 1024) } },
    );
    await replaceSessionEntry(
      { sessionKey: admittedThreadKey, storePath },
      { sessionId: "admitted-thread", updatedAt: 5 },
    );
    await appendTranscriptMessage(
      { sessionId: "admitted-thread", sessionKey: admittedThreadKey, storePath },
      { message: { role: "user", content: "admitted keep" } },
    );
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: [admittedThreadKey],
      assertAllowed: () => {},
    });
    try {
      settlePhysicalUsage();
      expect(countHistoricalSessionIds()).toBe(0);
      expect(sessionNodeExists(idleThreadKey)).toBe(true);
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const maintenance = {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: Math.max(1, before.totalBytes - 1),
      };
      const inspected = await inspectSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance,
      });

      expect(inspected.wouldMutate).toBe(true);
      expect(result?.removedEntries).toBeGreaterThanOrEqual(1);
      expect(sessionExists("idle-thread-live")).toBe(false);
      expect(sessionNodeExists(idleThreadKey)).toBe(false);
      expect(sessionExists("live-main")).toBe(true);
      expect(sessionNodeExists(mainKey)).toBe(true);
      expect(sessionExists("admitted-thread")).toBe(true);
      expect(sessionNodeExists(admittedThreadKey)).toBe(true);
    } finally {
      admission.release();
    }
  });

  it("preserves recently active live nodes under physical pressure", async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const mainKey = "agent:main:main";
    const recentKey = "agent:main:dashboard:recent";
    const idleThreadKey = "agent:main:slack:channel:c5:thread:5";
    await replaceSessionEntry(
      { sessionKey: mainKey, storePath },
      { sessionId: "live-main", updatedAt: now },
    );
    await appendTranscriptMessage(
      { sessionId: "live-main", sessionKey: mainKey, storePath },
      { message: { role: "user", content: "main keep" } },
    );
    await replaceSessionEntry(
      { sessionKey: recentKey, storePath },
      { sessionId: "recent-live", updatedAt: now },
    );
    await appendTranscriptMessage(
      { sessionId: "recent-live", sessionKey: recentKey, storePath },
      { message: { role: "user", content: "recent keep" } },
    );
    await replaceSessionEntry(
      { sessionKey: idleThreadKey, storePath },
      { sessionId: "idle-thread-live", updatedAt: 10 },
    );
    await appendTranscriptMessage(
      { sessionId: "idle-thread-live", sessionKey: idleThreadKey, storePath },
      { message: { role: "user", content: "idle live " + "x".repeat(64 * 1024) } },
    );
    settlePhysicalUsage();
    expect(countHistoricalSessionIds()).toBe(0);
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const maintenance = {
      maxDiskBytes: before.totalBytes - 1,
      highWaterBytes: Math.max(1, before.totalBytes - 1),
      preserveRecentMs: 7 * dayMs,
    };
    const inspected = await inspectSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance,
    });

    expect(inspected.wouldMutate).toBe(true);
    expect(result?.removedEntries).toBeGreaterThanOrEqual(1);
    expect(sessionExists("idle-thread-live")).toBe(false);
    expect(sessionNodeExists(idleThreadKey)).toBe(false);
    expect(sessionExists("recent-live")).toBe(true);
    expect(sessionNodeExists(recentKey)).toBe(true);
    expect(sessionExists("live-main")).toBe(true);
  });

  it("does not wipe live durables when highWaterBytes is 0", async () => {
    const threadKey = "agent:main:slack:channel:C9:thread:9";
    await replaceSessionEntry(
      { sessionKey: threadKey, storePath },
      { sessionId: "live-durable", updatedAt: 2 },
    );
    await appendTranscriptMessage(
      { sessionId: "live-durable", sessionKey: threadKey, storePath },
      { message: { role: "user", content: "live durable keep" } },
    );
    await createHistoricalTranscript({
      content: "oldest " + "x".repeat(64 * 1024),
      nextSessionId: "newer-history",
      sessionId: "oldest-history",
      sessionKey: "agent:main:history-order",
      updatedAt: 10,
    });
    settlePhysicalUsage();
    expect(sessionExists("oldest-history")).toBe(true);
    expect(sessionExists("live-durable")).toBe(true);
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: 0,
      },
    });

    expect(sessionExists("oldest-history")).toBe(false);
    expect(sessionExists("live-durable")).toBe(true);
    expect(result?.removedEntries).toBe(1);
  });

  async function createHistoricalTranscript(params: {
    content: string;
    nextSessionId: string;
    sessionId: string;
    sessionKey: string;
    updatedAt: number;
  }): Promise<void> {
    await replaceSessionEntry(
      { sessionKey: params.sessionKey, storePath },
      { sessionId: params.sessionId, updatedAt: params.updatedAt },
    );
    await appendTranscriptMessage(
      { sessionId: params.sessionId, sessionKey: params.sessionKey, storePath },
      { message: { role: "user", content: params.content } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: params.sessionKey, storeKeys: [params.sessionKey] },
      buildNextEntry: () => ({ sessionId: params.nextSessionId, updatedAt: params.updatedAt + 1 }),
    });
    setSessionUpdatedAt(params.sessionId, params.updatedAt);
  }

  function database() {
    const target = resolveSqliteTargetFromSessionStorePath(storePath);
    if (!target.path) {
      throw new Error("expected SQLite database path");
    }
    return openOpenClawAgentDatabase({ agentId: target.agentId ?? "main", path: target.path });
  }

  function settlePhysicalUsage(): void {
    const owner = database();
    owner.walMaintenance.checkpoint();
    const row = owner.db.prepare("PRAGMA freelist_count").get() as
      | { freelist_count?: unknown }
      | undefined;
    const freePages = Number(row?.freelist_count ?? 0);
    if (Number.isSafeInteger(freePages) && freePages > 0) {
      owner.db.exec(`PRAGMA incremental_vacuum(${freePages});`);
    }
    owner.walMaintenance.checkpoint();
  }

  function setSessionUpdatedAt(sessionId: string, updatedAt: number): void {
    const owner = database();
    const db = getSessionKysely(owner.db);
    executeSqliteQuerySync(
      owner.db,
      db
        .updateTable("session_windows")
        .set({ updated_at: updatedAt })
        .where("session_id", "=", sessionId),
    );
  }

  function sessionExists(sessionId: string): boolean {
    const owner = database();
    const db = getSessionKysely(owner.db);
    return (
      executeSqliteQuerySync(
        owner.db,
        db.selectFrom("session_windows").select("session_id").where("session_id", "=", sessionId),
      ).rows.length === 1
    );
  }

  function sessionNodeExists(sessionKey: string): boolean {
    const owner = database();
    const db = getSessionKysely(owner.db);
    return (
      executeSqliteQuerySync(
        owner.db,
        db.selectFrom("session_nodes").select("session_key").where("session_key", "=", sessionKey),
      ).rows.length === 1
    );
  }

  function countHistoricalSessionIds(): number {
    const owner = database();
    const db = getSessionKysely(owner.db);
    const liveIds = new Set(
      executeSqliteQuerySync(
        owner.db,
        db.selectFrom("session_nodes").select("current_session_id"),
      ).rows.map((row) => row.current_session_id),
    );
    return executeSqliteQuerySync(
      owner.db,
      db.selectFrom("session_windows").select("session_id"),
    ).rows.filter((row) => !liveIds.has(row.session_id)).length;
  }
});
