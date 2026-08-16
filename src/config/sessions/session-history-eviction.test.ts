import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const evictionWarnSpy = vi.hoisted(() => vi.fn());
vi.mock("../../logging/subsystem.js", async () => {
  const actual = await vi.importActual<typeof import("../../logging/subsystem.js")>(
    "../../logging/subsystem.js",
  );
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "sessions/history-eviction"
        ? { ...logger, warn: evictionWarnSpy }
        : logger;
    },
  };
});
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
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { measureSessionPhysicalDiskUsage } from "./disk-budget.js";
import {
  appendTranscriptMessage,
  deleteSessionEntryLifecycle,
  replaceSessionEntry,
  resetSessionEntryLifecycle,
} from "./session-accessor.js";
import { getSessionKysely } from "./session-accessor.sqlite-scope.js";
import {
  enforceSqliteSessionHistoryDiskBudget,
  inspectSqliteSessionHistoryDiskBudget,
  kickSessionHistoryDiskBudgetMaintenance,
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
    expect(result?.totalBytesAfter).toBe(
      (await measureSessionPhysicalDiskUsage(storePath)).totalBytes,
    );
    expect(sessionExists("oldest-history")).toBe(false);
    expect(sessionExists("newer-history")).toBe(true);
    expect(sessionExists("live-history")).toBe(true);
    expect(readArchiveNames("oldest-history")).toHaveLength(1);
    expect(readArchiveNames("newer-history")).toHaveLength(0);
  });

  it("remeasures incompressible archive publication before declaring high water", async () => {
    const sessionId = "incompressible-history";
    const sessionKey = "agent:main:incompressible-history";
    await createHistoricalTranscript({
      content: randomBytes(192 * 1024).toString("base64"),
      nextSessionId: "incompressible-live",
      sessionId,
      sessionKey,
      updatedAt: 1,
    });
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);
    const highWaterBytes = before.totalBytes - 1;

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: highWaterBytes,
        highWaterBytes,
      },
    });
    const actualAfter = await measureSessionPhysicalDiskUsage(storePath);

    expect(result?.removedEntries).toBe(1);
    expect(result?.totalBytesAfter).toBe(actualAfter.totalBytes);
    expect(actualAfter.totalBytes).toBeLessThanOrEqual(highWaterBytes);
    expect(sessionExists(sessionId)).toBe(false);
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

  it("prunes the canonical archive row and its derived file before searchable history", async () => {
    const archivedSessionId = "canonical-archive";
    const archivedSessionKey = "agent:main:canonical-archive";
    await replaceSessionEntry(
      { sessionKey: archivedSessionKey, storePath },
      { sessionId: archivedSessionId, updatedAt: 1 },
    );
    await appendTranscriptMessage(
      { sessionId: archivedSessionId, sessionKey: archivedSessionKey, storePath },
      { message: { role: "user", content: "canonical archive pressure" } },
    );
    const deleted = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: archivedSessionKey, storeKeys: [archivedSessionKey] },
    });
    const archivePath = deleted.archivedTranscripts[0]?.archivedPath;
    expect(archivePath).toBeTruthy();

    await createHistoricalTranscript({
      content: "keep searchable history",
      nextSessionId: "canonical-live",
      sessionId: "canonical-history",
      sessionKey: "agent:main:canonical-pressure",
      updatedAt: 2,
    });
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

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 1 });
    expect(fs.existsSync(archivePath ?? "")).toBe(false);
    expect(
      database()
        .db.prepare("SELECT 1 FROM session_transcript_archives WHERE session_id = ?")
        .get(archivedSessionId),
    ).toBeUndefined();
    expect(sessionExists("canonical-history")).toBe(true);
  });

  it("never prunes an unpublished canonical archive under disk pressure", async () => {
    const sessionId = "pending-pressure";
    const sessionKey = "agent:main:pending-pressure";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await appendTranscriptMessage(
      { sessionId, sessionKey, storePath },
      { message: { role: "user", content: "sole crash-recovery copy" } },
    );
    const deleted = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    const pendingArchivePath = deleted.archivedTranscripts[0]?.archivedPath;
    database()
      .db.prepare("UPDATE session_transcript_archives SET published_at = NULL WHERE session_id = ?")
      .run(sessionId);
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

    expect(result).toMatchObject({ removedEntries: 0, removedFiles: 0 });
    expect(
      database()
        .db.prepare("SELECT published_at FROM session_transcript_archives WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ published_at: null });
    expect(fs.existsSync(pendingArchivePath ?? "")).toBe(true);
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

  it("preserves every generation of a recently active session under physical pressure", async () => {
    const now = Date.now();
    const dayMs = 24 * 60 * 60 * 1000;
    const recentKey = "agent:main:recent-history";
    const staleKey = "agent:main:stale-history";
    await createHistoricalTranscript({
      content: "recent history " + "r".repeat(64 * 1024),
      nextSessionId: "recent-live",
      sessionId: "recent-old",
      sessionKey: recentKey,
      updatedAt: now - 8 * dayMs,
    });
    await replaceSessionEntry(
      { sessionKey: recentKey, storePath },
      { sessionId: "recent-live", updatedAt: now },
    );
    await createHistoricalTranscript({
      content: "stale history " + "s".repeat(64 * 1024),
      nextSessionId: "stale-live",
      sessionId: "stale-old",
      sessionKey: staleKey,
      updatedAt: now - 8 * dayMs,
    });
    settlePhysicalUsage();
    const before = await measureSessionPhysicalDiskUsage(storePath);

    const result = await enforceSqliteSessionHistoryDiskBudget({
      storePath,
      mode: "enforce",
      maintenance: {
        maxDiskBytes: before.totalBytes - 1,
        highWaterBytes: 0,
        preserveRecentMs: 7 * dayMs,
      },
    });

    expect(result?.removedEntries).toBe(1);
    expect(sessionExists("recent-old")).toBe(true);
    expect(sessionExists("recent-live")).toBe(true);
    expect(sessionExists("stale-old")).toBe(false);
    expect(sessionExists("stale-live")).toBe(true);
  });

  it("warns when a fire-and-forget budget sweep fails instead of swallowing it", async () => {
    evictionWarnSpy.mockClear();
    // The kick gate reads maxDiskBytes twice synchronously; the queued sweep
    // re-reads it asynchronously. Throwing on the later read rejects the
    // fire-and-forget promise, exercising the catch path deterministically.
    let maxDiskBytesReads = 0;
    const maintenanceConfig = {
      mode: "enforce",
      highWaterBytes: 1,
      get maxDiskBytes() {
        maxDiskBytesReads += 1;
        if (maxDiskBytesReads > 1) {
          throw new Error("sweep exploded");
        }
        return 1;
      },
    } as never;

    kickSessionHistoryDiskBudgetMaintenance({ storePath, force: true, maintenanceConfig });
    await vi.waitFor(() => {
      expect(evictionWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining("disk-budget sweep failed"),
        expect.objectContaining({ storePath }),
      );
    });
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
