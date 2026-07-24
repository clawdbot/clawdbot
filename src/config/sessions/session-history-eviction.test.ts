import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { beginSessionWorkAdmission } from "../../sessions/session-lifecycle-admission.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
  withOpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  appendTranscriptMessage,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
  inspectSqliteSessionHistoryDiskBudget,
} from "./session-history-eviction.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

describe("SQLite historical session disk budget", () => {
  let testState: OpenClawTestState;
  let tempDir: string;
  let storePath: string;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-history-budget-",
      layout: "state-only",
    });
    tempDir = testState.sessionsDir();
    fs.mkdirSync(tempDir, { recursive: true });
    storePath = path.join(tempDir, "sessions.json");
  });

  afterEach(async () => {
    await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: null, highWaterBytes: null },
    });
    closeOpenClawAgentDatabasesForTest();
    await testState.cleanup();
  });

  it("evicts the oldest historical session and stops after reaching high water", async () => {
    const sessionKey = "agent:main:history-order";
    await createHistoricalTranscript({
      content: "oldest " + "x".repeat(64 * 1024),
      nextSessionId: "newer-history",
      sessionId: "oldest-history",
      sessionKey,
      updatedAt: 10,
    });
    await appendTranscriptMessage(
      { sessionId: "newer-history", sessionKey, storePath },
      { message: { role: "user", content: "newer " + "y".repeat(64 * 1024) } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "live-history", updatedAt: 30 }),
    });
    setSessionUpdatedAt("newer-history", 20);
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: before.totalBytes - 1,
      },
    });

    expect(result?.removedEntries).toBe(1);
    expect(result?.totalBytesAfter).toBeLessThanOrEqual(before.totalBytes - 1);
    expect(sessionExists("oldest-history")).toBe(false);
    expect(sessionExists("newer-history")).toBe(true);
    expect(sessionExists("live-history")).toBe(true);
    expect(readArchiveNames("oldest-history")).toHaveLength(1);
    expect(readArchiveNames("newer-history")).toHaveLength(0);
  });

  it("removes counted archives before evicting searchable history", async () => {
    await createHistoricalTranscript({
      content: "keep searchable history",
      nextSessionId: "archive-live",
      sessionId: "archive-history",
      sessionKey: "agent:main:archive-pressure",
      updatedAt: 1,
    });
    database().walMaintenance.checkpoint();
    const oldArchive = path.join(
      tempDir,
      "already-extracted.jsonl.deleted.2026-01-01T00-00-00.000Z",
    );
    fs.writeFileSync(oldArchive, Buffer.alloc(256 * 1024));
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: before.totalBytes - 64 * 1024,
      },
    });

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
    expect(fs.existsSync(oldArchive)).toBe(false);
    expect(sessionExists("archive-history")).toBe(true);
  });

  it("excludes entry, route, and admitted ids while evicting trajectory-only history", async () => {
    const sessionKey = "agent:main:history-protection";
    await replaceSessionEntry(
      { sessionKey, storePath },
      { sessionId: "admitted-history", updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { sessionId: "admitted-history", sessionKey, storePath },
      { message: { role: "user", content: "admitted" } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "route-history", updatedAt: 2 }),
    });
    await appendTranscriptMessage(
      { sessionId: "route-history", sessionKey, storePath },
      { message: { role: "user", content: "route protected" } },
    );
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "trajectory-history", updatedAt: 3 }),
    });
    appendSqliteTrajectoryRuntimeEvents({ sessionId: "trajectory-history", storePath }, [
      createTrajectoryEvent("trajectory-history", sessionKey),
    ]);
    await resetSessionEntryLifecycle({
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      buildNextEntry: () => ({ sessionId: "live-history", updatedAt: 4 }),
    });
    addRouteReference("route-only", "route-history");
    const admission = await beginSessionWorkAdmission({
      scope: storePath,
      identities: ["admitted-history"],
      assertAllowed: () => {},
    });
    try {
      const before = await measureSessionPhysicalDiskUsage(storePath);
      const result = await enforceSqliteSessionHistoryDiskBudget({
        storePath,
        mode: "enforce",
        maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 0 },
      });

      expect(result?.removedEntries).toBe(1);
      expect(sessionExists("trajectory-history")).toBe(false);
      // Trajectory-only sessions carry no transcript; eviction reclaims their
      // diagnostic telemetry without writing an empty archive artifact.
      expect(readArchiveNames("trajectory-history")).toHaveLength(0);
      expect(sessionExists("admitted-history")).toBe(true);
      expect(sessionExists("route-history")).toBe(true);
      expect(sessionExists("live-history")).toBe(true);
    } finally {
      admission.release();
    }
  });

  it("warn mode reports physical overage without extracting or deleting history", async () => {
    await createHistoricalTranscript({
      content: "warn history",
      nextSessionId: "warn-live",
      sessionId: "warn-old",
      sessionKey: "agent:main:warn-history",
      updatedAt: 1,
    });
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const inspected = await inspectSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 0 },
    });
    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "warn",
      maintenance: { maxDiskBytes: before.totalBytes - 1, highWaterBytes: 0 },
    });

    expect(inspected.diskBudget?.totalBytesBefore).toBe(before.totalBytes);
    expect(inspected.wouldMutate).toBe(false);
    expect(result).toMatchObject({ overBudget: true, removedEntries: 0, removedFiles: 0 });
    expect(sessionExists("warn-old")).toBe(true);
    expect(readArchiveNames("warn-old")).toHaveLength(0);
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

  function addRouteReference(sessionKey: string, sessionId: string): void {
    const owner = database();
    const db = getSessionKysely(owner.db);
    executeSqliteQuerySync(
      owner.db,
      db.insertInto("session_nodes").values({
        session_key: sessionKey,
        current_session_id: sessionId,
        entry_json: "{}",
        updated_at: Date.now(),
      }),
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

  function readArchiveNames(sessionId: string): string[] {
    return fs.readdirSync(tempDir).filter((name) => name.startsWith(`${sessionId}.jsonl.deleted.`));
  }
});

function createTrajectoryEvent(sessionId: string, sessionKey: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "history.test",
    ts: "2026-07-18T00:00:00.000Z",
    seq: 1,
    sessionId,
    sessionKey,
  };
}

describe("kickSessionHistoryDiskBudgetMaintenance", () => {
  it("throttles repeat kicks and skips warn mode entirely", async () => {
    await withOpenClawTestState(
      { prefix: "openclaw-session-history-kick-", layout: "state-only" },
      async (testState) => {
        const tempDir = testState.sessionsDir();
        fs.mkdirSync(tempDir, { recursive: true });
        const storePath = path.join(tempDir, "sessions.json");
        const maintenance = {
          mode: "warn",
          maxDiskBytes: 1,
          highWaterBytes: 0,
        } as never;
        // Warn mode must not schedule background enforcement at all.
        kickSessionHistoryDiskBudgetMaintenance({
          storePath,
          maintenanceConfig: maintenance,
        });
        const enforceMaintenance = {
          mode: "enforce",
          maxDiskBytes: Number.MAX_SAFE_INTEGER,
          highWaterBytes: Number.MAX_SAFE_INTEGER - 1,
        } as never;
        const first = Date.now();
        kickSessionHistoryDiskBudgetMaintenance({
          storePath,
          maintenanceConfig: enforceMaintenance,
          now: first,
        });
        // Second kick inside the throttle window is a no-op (single-slot state).
        kickSessionHistoryDiskBudgetMaintenance({
          storePath,
          maintenanceConfig: enforceMaintenance,
          now: first + 1_000,
        });
        // A queued no-op pass is a deterministic barrier behind the fire-and-forget kick.
        await enforceSqliteSessionHistoryDiskBudget({
          storePath,
          mode: "warn",
          maintenance: { maxDiskBytes: null, highWaterBytes: null },
        });
        closeOpenClawAgentDatabasesForTest();
      },
    );
  });
});
