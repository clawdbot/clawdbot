// SQLite transcript archive worker tests cover off-main execution and snapshot fencing.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordAcpParentStreamEvents } from "../../agents/subagents/spawn/acp-parent-stream-store.sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { listUsageCountedTranscriptStats } from "../../infra/session-cost-usage-collection.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { decodeSessionArchiveBytes, readSessionArchiveContentSync } from "./archive-compression.js";
import {
  applySessionEntryLifecycleMutation,
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { writeTranscriptArchive } from "./session-accessor.sqlite-archive-files.js";
import { materializeSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import {
  deleteMaterializedSessionStatePlans,
  planSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "./session-transcript-reconcile.js";

type TestTranscriptEvent = {
  id: string;
  [key: string]: unknown;
};

describe("SQLite transcript archive worker", () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sqlite-archive-worker-"));
    storePath = path.join(tempDir, "agents", "main", "sessions", "sessions.json");
  });

  afterEach(async () => {
    // A deferred projection reconcile worker may still hold the agent DB open;
    // Windows cannot unlink open files, so settle it before removing tempDir.
    await waitForSessionTranscriptIndexReconcile({
      agentId: "main",
      path: resolveSqliteTargetFromSessionStorePath(storePath).path,
    });
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("bounds archive filenames for oversized session IDs", async () => {
    const sessionId = `oversized-${"x".repeat(300)}`;
    const sessionKey = "agent:main:oversized-archive-session";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent("oversized-event", "archive me"),
    ]);

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    const archivedPath = result.archivedTranscripts[0]?.archivedPath ?? "";

    expect(result.deleted).toBe(true);
    expect(loadSessionEntry({ sessionKey, storePath })).toBeUndefined();
    expect(Buffer.byteLength(path.basename(archivedPath), "utf8")).toBeLessThan(256);
    expect(path.basename(archivedPath)).toMatch(/^session-[a-f0-9]{64}\.jsonl\.deleted\./);
    expect(readSessionArchiveContentSync(archivedPath)).toContain("oversized-event");
    expect(
      openLifecycleTestDatabase(storePath)
        .db.prepare(
          "SELECT session_id, session_key FROM session_transcript_archives WHERE archive_name = ?",
        )
        .get(path.basename(archivedPath)),
    ).toEqual({ session_id: sessionId, session_key: sessionKey });
    await expect(listUsageCountedTranscriptStats("main", { storePath })).resolves.toEqual([
      expect.objectContaining({ sessionId }),
    ]);
  });

  it("does not reuse lifecycle staging files as legacy archives", () => {
    const sessionId = "staging-reuse";
    const archiveDirectory = path.dirname(storePath);
    const content = `${JSON.stringify(createTranscriptEvent("reuse-event", "archive once"))}\n`;
    fs.mkdirSync(archiveDirectory, { recursive: true });
    const stagedPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-09-02T10-00-00.000Z.generation.jsonl-stage`,
    );
    fs.writeFileSync(stagedPath, content);

    const archivedPath = writeTranscriptArchive({
      archiveDirectory,
      content,
      reason: "deleted",
      sessionId,
    });

    expect(archivedPath).not.toBe(stagedPath);
    expect(fs.existsSync(stagedPath)).toBe(true);
    expect(readSessionArchiveContentSync(archivedPath)).toBe(content);
  });

  it("keeps the event loop responsive while a transcript archive is built", async () => {
    const sessionId = "off-main-archive-session";
    const sessionKey = "agent:main:off-main-archive";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    const events = Array.from({ length: 64 }, (_, index) =>
      createTranscriptEvent(
        `${sessionId}-${index}`,
        index === 0
          ? `first: 你好\n${randomBytes(576 * 1024).toString("base64")}`
          : index === 63
            ? `last: 🦞\n${randomBytes(576 * 1024).toString("base64")}`
            : `${index}:${randomBytes(576 * 1024).toString("base64")}`,
      ),
    );
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, events);

    let heartbeatCount = 0;
    const heartbeat = setInterval(() => {
      heartbeatCount += 1;
    }, 5);
    let materialized: Awaited<ReturnType<typeof materializeSessionStateDeletePlans>>;
    try {
      const database = openLifecycleTestDatabase(storePath);
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      materialized = await materializeSessionStateDeletePlans([plan]);
    } finally {
      clearInterval(heartbeat);
    }

    expect(heartbeatCount).toBeGreaterThan(5);
    expect(materialized).toHaveLength(1);
    const archive = materialized[0]?.archive;
    expect(archive).toBeTruthy();
    expect(fs.existsSync(materialized[0]?.archivedTranscript?.archivedPath ?? "")).toBe(false);
    const expectedContent = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const archivedContent = decodeSessionArchiveBytes(
      archive?.bytes ?? new Uint8Array(),
      archive?.encoding === "zstd",
    );
    expect(Buffer.byteLength(archivedContent)).toBe(Buffer.byteLength(expectedContent));
    expect(sha256(archivedContent)).toBe(sha256(expectedContent));
    const archiveLines = archivedContent.trim().split("\n");
    expect(archiveLines).toHaveLength(events.length);
    expect(archiveLines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(
      events.map((event) => event.id),
    );
  });

  it("processes maintenance across the archive byte limit", async () => {
    const largeContent = "x".repeat(33 * 1024 * 1024);
    const archivedSessions = [0, 1].map((index) => ({
      event: createTranscriptEvent(`worker-byte-session-${index}`, `${index}:${largeContent}`),
      sessionId: `worker-byte-session-${index}`,
      sessionKey: `agent:main:subagent:worker-byte-${index}`,
    }));
    for (const [index, session] of archivedSessions.entries()) {
      await replaceSessionEntry(
        { sessionKey: session.sessionKey, storePath },
        { sessionId: session.sessionId, updatedAt: Date.now() + index },
      );
      await replaceTranscriptEvents(
        { sessionKey: session.sessionKey, sessionId: session.sessionId, storePath },
        [session.event],
      );
    }
    const retainedSession = {
      sessionId: "worker-byte-session-retained",
      sessionKey: "agent:main:subagent:worker-byte-retained",
    };
    await replaceSessionEntry(
      { sessionKey: retainedSession.sessionKey, storePath },
      { sessionId: retainedSession.sessionId, updatedAt: Date.now() + archivedSessions.length },
    );

    const result = await applySessionEntryLifecycleMutation({
      storePath,
      maintenanceOverride: {
        maxEntries: 1,
        mode: "enforce",
        pruneAfterMs: Number.MAX_SAFE_INTEGER,
      },
    });

    expect(result).toMatchObject({
      afterCount: 1,
      beforeCount: archivedSessions.length + 1,
      capped: archivedSessions.length,
      modelRunPruned: 0,
      pruned: 0,
    });
    expect(result.archivedTranscriptDirectories).toEqual([path.dirname(storePath)]);
    expect(loadSessionEntry({ sessionKey: retainedSession.sessionKey, storePath })).toBeDefined();
    const archiveRows = openLifecycleTestDatabase(storePath)
      .db.prepare(
        `SELECT archive_name, archive_sha256, published_at, session_id
           FROM session_transcript_archives
          ORDER BY session_id`,
      )
      .all() as Array<{
      archive_name: string;
      archive_sha256: string;
      published_at: number | null;
      session_id: string;
    }>;
    expect(archiveRows).toHaveLength(archivedSessions.length);
    for (const session of archivedSessions) {
      expect(loadSessionEntry({ sessionKey: session.sessionKey, storePath })).toBeUndefined();
      await expect(
        loadTranscriptEvents({
          sessionKey: session.sessionKey,
          sessionId: session.sessionId,
          storePath,
        }),
      ).resolves.toEqual([]);
      const archive = archiveRows.find((row) => row.session_id === session.sessionId);
      expect(archive).toMatchObject({
        archive_sha256: expect.any(String),
        published_at: expect.any(Number),
      });
      const archivePath = path.join(path.dirname(storePath), archive?.archive_name ?? "");
      expect(sha256(fs.readFileSync(archivePath))).toBe(archive?.archive_sha256);
      const archivedContent = readSessionArchiveContentSync(archivePath);
      const expectedContent = `${JSON.stringify(session.event)}\n`;
      expect(Buffer.byteLength(archivedContent)).toBe(Buffer.byteLength(expectedContent));
      expect(sha256(archivedContent)).toBe(sha256(expectedContent));
    }
  });

  it("commits a canonical archive before publishing its derived file", async () => {
    const sessionId = "durable-delete-session";
    const sessionKey = "agent:main:durable-delete";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
      },
    );
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "durable archive first"),
    ]);

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
      },
    });
    expect(result.deleted).toBe(true);
    const archivedPath = result.archivedTranscripts[0]?.archivedPath;
    expect(archivedPath).toBeTruthy();
    expect(readArchiveLines(archivedPath)).toEqual([
      JSON.stringify(createTranscriptEvent(sessionId, "durable archive first")),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    expect(
      database.db
        .prepare(
          "SELECT session_key, published_at FROM session_transcript_archives WHERE session_id = ?",
        )
        .get(sessionId),
    ).toMatchObject({ published_at: expect.any(Number), session_key: sessionKey });
  });

  it("retains distinct transcript generations after a physical session id is restored", async () => {
    const sessionId = "restored-archive-session";
    const sessionKey = "agent:main:restored-archive";
    const scope = { sessionId, sessionKey, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: 1 });
    await replaceTranscriptEvents(scope, [createTranscriptEvent(sessionId, "first generation")]);
    const first = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    const firstArchive = first.archivedTranscripts[0];
    if (!firstArchive) {
      throw new Error("expected first transcript archive");
    }
    fs.rmSync(firstArchive.archivedPath);
    openLifecycleTestDatabase(storePath)
      .db.prepare(
        `UPDATE session_transcript_archives
            SET published_at = NULL
          WHERE session_id = ? AND generation = ?`,
      )
      .run(sessionId, firstArchive.generation);

    await replaceSessionEntry(scope, { sessionId, updatedAt: 2 });
    await replaceTranscriptEvents(scope, [createTranscriptEvent(sessionId, "second generation")]);
    const second = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(second.archivedTranscripts).toHaveLength(1);
    expect(second.archivedTranscripts[0]?.archivedPath).not.toBe(firstArchive.archivedPath);
    expect(readArchiveLines(firstArchive.archivedPath)).toEqual([
      JSON.stringify(createTranscriptEvent(sessionId, "first generation")),
    ]);
    expect(readArchiveLines(second.archivedTranscripts[0]?.archivedPath)).toEqual([
      JSON.stringify(createTranscriptEvent(sessionId, "second generation")),
    ]);
    expect(
      openLifecycleTestDatabase(storePath)
        .db.prepare(
          "SELECT generation FROM session_transcript_archives WHERE session_id = ? ORDER BY generation",
        )
        .all(sessionId),
    ).toHaveLength(2);
  });

  it("retries a pending archive export when deletion is already committed", async () => {
    const sessionId = `retry-committed-${"x".repeat(300)}`;
    const sessionKey = "agent:main:retry-committed-delete";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "retry pending export"),
    ]);
    const first = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    const archivePath = first.archivedTranscripts[0]?.archivedPath;
    if (!archivePath) {
      throw new Error("expected published archive");
    }
    fs.rmSync(archivePath);
    const archiveSuffix = path.basename(archivePath).slice(path.basename(archivePath).indexOf("."));
    const oversizedArchiveName = `${sessionId}${archiveSuffix}`;
    const database = openLifecycleTestDatabase(storePath);
    database.db
      .prepare(
        "UPDATE session_transcript_archives SET archive_name = ?, published_at = NULL WHERE session_id = ?",
      )
      .run(oversizedArchiveName, sessionId);

    const retry = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });

    expect(retry).toMatchObject({ archivedTranscripts: [], deleted: false });
    const persisted = database.db
      .prepare(
        "SELECT archive_name, published_at FROM session_transcript_archives WHERE session_id = ?",
      )
      .get(sessionId);
    const republishedArchiveName = persisted?.archive_name;
    if (typeof republishedArchiveName !== "string") {
      throw new Error("expected republished archive name");
    }
    expect(persisted).toMatchObject({
      archive_name: expect.stringMatching(/^session-[a-f0-9]{64}\.jsonl\.deleted\./),
      published_at: expect.any(Number),
    });
    const republishedPath = path.join(path.dirname(storePath), republishedArchiveName);
    expect(readArchiveLines(republishedPath)).toEqual([
      JSON.stringify(createTranscriptEvent(sessionId, "retry pending export")),
    ]);
  });

  it("archives a logical agent transcript through the exact database's physical owner", async () => {
    const sharedDatabasePath = path.join(tempDir, "shared.sqlite");
    const mainSessionId = "shared-physical-owner-main-session";
    const mainSessionKey = "agent:main:shared-physical-owner-main";
    const opsSessionId = "shared-physical-owner-ops-session";
    const opsSessionKey = "agent:ops:shared-physical-owner-ops";
    const mainScope = {
      agentId: "main",
      defaultAgentId: "main",
      sessionId: mainSessionId,
      sessionKey: mainSessionKey,
      storePath: sharedDatabasePath,
    };
    const opsScope = {
      agentId: "ops",
      defaultAgentId: "main",
      sessionId: opsSessionId,
      sessionKey: opsSessionKey,
      storePath: sharedDatabasePath,
    };
    const mainEvent = createTranscriptEvent(mainSessionId, "keep physical-owner transcript");
    const opsEvent = createTranscriptEvent(opsSessionId, "archive logical-owner transcript");

    await replaceSessionEntry(mainScope, { sessionId: mainSessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents(mainScope, [mainEvent]);
    await replaceSessionEntry(opsScope, { sessionId: opsSessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents(opsScope, [opsEvent]);

    const opsTarget = resolveSqliteTargetFromSessionStorePath(sharedDatabasePath, {
      agentId: opsScope.agentId,
      defaultAgentId: opsScope.defaultAgentId,
    });
    const database = openLifecycleTestDatabase(sharedDatabasePath);
    expect(opsTarget).toMatchObject({
      agentId: "main",
      path: sharedDatabasePath,
      shared: true,
    });
    expect(database.agentId).toBe("main");
    expect(database.agentId).not.toBe(opsScope.agentId);

    const deleted = await deleteSessionEntryLifecycle({
      agentId: opsScope.agentId,
      archiveTranscript: true,
      storePath: sharedDatabasePath,
      target: { canonicalKey: opsSessionKey, storeKeys: [opsSessionKey] },
    });
    expect(readArchiveLines(deleted.archivedTranscripts[0]?.archivedPath)).toEqual([
      JSON.stringify(opsEvent),
    ]);

    await expect(loadTranscriptEvents(opsScope)).resolves.toEqual([]);
    await expect(loadTranscriptEvents(mainScope)).resolves.toEqual([mainEvent]);
    expect(loadSessionEntry(mainScope)).toMatchObject({ sessionId: mainSessionId });
  });

  it("rejects transcript changes between deletion planning and the worker snapshot", async () => {
    const sessionId = "changed-before-worker-snapshot";
    const scope = {
      sessionKey: "agent:main:changed-before-worker-snapshot",
      sessionId,
      storePath,
    };
    const original = createTranscriptEvent(sessionId, "original transcript");
    await replaceTranscriptEvents(scope, [original]);
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);

    await replaceTranscriptEvents(scope, [
      original,
      createTranscriptEvent("concurrent-event", "concurrent append"),
    ]);

    await expect(materializeSessionStateDeletePlans([plan])).rejects.toThrow(
      `SQLite session state changed before archive materialization for ${sessionId}`,
    );
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(2);
    const archiveDirectory = path.dirname(storePath);
    const archiveNames = fs.existsSync(archiveDirectory) ? fs.readdirSync(archiveDirectory) : [];
    expect(archiveNames.filter((entry) => entry.startsWith(`${sessionId}.jsonl.deleted.`))).toEqual(
      [],
    );
  });

  it("rejects deduped plans with different transcript snapshots", async () => {
    const sessionId = "conflicting-plan-snapshots";
    await replaceTranscriptEvents(
      { sessionKey: "agent:main:conflicting-plan-snapshots", sessionId, storePath },
      [createTranscriptEvent(sessionId, "original transcript")],
    );
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
    const conflictingPlan = {
      ...plan,
      snapshot: {
        ...plan.snapshot,
        transcriptUpdatedAt: (plan.snapshot.transcriptUpdatedAt ?? 0) + 1,
      },
    };

    await expect(materializeSessionStateDeletePlans([plan, conflictingPlan])).rejects.toThrow(
      `Conflicting SQLite transcript archive plans for ${sessionId}`,
    );
  });

  it("rejects the first append after planning an empty transcript", async () => {
    const sessionId = "empty-then-appended-transcript";
    const scope = {
      sessionKey: "agent:main:empty-then-appended-transcript",
      sessionId,
      storePath,
    };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
    expect(plan.snapshot.lastSeq).toBeNull();

    await replaceTranscriptEvents(scope, [
      createTranscriptEvent(sessionId, "first concurrent append"),
    ]);

    await expect(materializeSessionStateDeletePlans([plan])).rejects.toThrow(
      `SQLite session state changed before archive materialization for ${sessionId}`,
    );
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
  });

  it("preserves all lifecycle state when the archive worker rejects publication", async () => {
    const sessionId = "nested/archive-worker-lifecycle-failure";
    const sessionKey = "agent:main:archive-worker-lifecycle-failure";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents(scope, [
      {
        type: "message",
        id: "archive-worker-lifecycle-failure-message",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "preserve every lifecycle row" }],
        },
        timestamp: Date.now(),
      } as unknown as TestTranscriptEvent,
    ]);
    appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, [
      createTestTrajectoryEvent(sessionId),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    recordAcpParentStreamEvents({
      agentId: database.agentId,
      path: database.path,
      sessionId,
      runId: "archive-worker-lifecycle-failure-run",
      events: [{ event: { type: "output", text: "preserve ACP state" }, createdAt: Date.now() }],
    });
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const readLifecycleCounts = () => ({
      acp: executeSqliteQuerySync(
        database.db,
        db.selectFrom("acp_parent_stream_events").select("seq").where("session_id", "=", sessionId),
      ).rows.length,
      fts: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_fts")
          .select("session_id")
          .where("session_id", "=", sessionId),
      ).rows.length,
      indexState: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_transcript_index_state")
          .select("session_id")
          .where("session_id", "=", sessionId),
      ).rows.length,
      nodes: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("session_nodes")
          .select("current_session_id")
          .where("current_session_id", "=", sessionId),
      ).rows.length,
      rewriteWatermarks: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("transcript_rewrite_watermarks")
          .select("session_id")
          .where("session_id", "=", sessionId),
      ).rows.length,
      trajectory: executeSqliteQuerySync(
        database.db,
        db
          .selectFrom("trajectory_runtime_events")
          .select("seq")
          .where("session_id", "=", sessionId),
      ).rows.length,
      transcript: executeSqliteQuerySync(
        database.db,
        db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId),
      ).rows.length,
      windows: executeSqliteQuerySync(
        database.db,
        db.selectFrom("session_windows").select("session_id").where("session_id", "=", sessionId),
      ).rows.length,
    });
    await waitForSessionTranscriptProjection(scope);
    const before = readLifecycleCounts();

    await expect(
      deleteSessionEntryLifecycle({
        archiveTranscript: true,
        storePath,
        target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
      }),
    ).rejects.toThrow("Cannot archive SQLite transcript outside");

    expect(loadSessionEntry({ sessionKey, storePath })?.sessionId).toBe(sessionId);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
    expect(readLifecycleCounts()).toEqual(before);
    expect(before).toEqual({
      acp: 1,
      fts: 1,
      indexState: 1,
      nodes: 1,
      rewriteWatermarks: 1,
      trajectory: 1,
      transcript: 1,
      windows: 1,
    });
  });

  it("captures archive materialization failure without deleting the requested entry", async () => {
    const sessionId = "nested/captured-archive-failure";
    const sessionKey = "agent:main:captured-archive-failure";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    await replaceTranscriptEvents(scope, [createTranscriptEvent(sessionId, "retain on failure")]);

    const result = await applySessionEntryLifecycleMutation({
      captureArtifactCleanupError: true,
      removals: [{ archiveRemovedTranscript: true, sessionKey }],
      skipMaintenance: true,
      storePath,
    });

    expect(result.removedEntries).toBe(0);
    expect(result.artifactCleanupError).toBeInstanceOf(Error);
    expect(loadSessionEntry(scope)).toMatchObject({ sessionId });
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
  });

  it("keeps rows when a transcript changes after its archive snapshot", async () => {
    const sessionId = "stale-archive-snapshot-session";
    const sessionKey = "agent:main:stale-archive-snapshot";
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "archived snapshot"),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSessionStateDeletePlans([plan]);

    appendTranscriptEvent(database, sessionId);

    expect(() => deleteMaterializedPlans(database, materialized, sessionKey)).toThrow(
      `SQLite session state changed before deletion for ${sessionId}`,
    );
    expect(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId),
      ).rows,
    ).toHaveLength(2);
  });

  it.each(["rewrite generation", "transcript mutation watermark", "window metadata"] as const)(
    "keeps rows when the %s changes after archive materialization",
    async (kind) => {
      const sessionId = `stale-${
        kind === "rewrite generation"
          ? "generation"
          : kind === "transcript mutation watermark"
            ? "watermark"
            : "window"
      }-snapshot`;
      const sessionKey = `agent:main:${sessionId}`;
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        createTranscriptEvent(sessionId, "archived transcript"),
      ]);
      const database = openLifecycleTestDatabase(storePath);
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      expect(plan.snapshot.generation).not.toBeNull();
      expect(plan.snapshot.sessionUpdatedAt).not.toBeNull();
      expect(plan.snapshot.transcriptUpdatedAt).not.toBeNull();
      const materialized = await materializeSessionStateDeletePlans([plan]);

      if (kind === "rewrite generation") {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("transcript_rewrite_watermarks")
            .set({
              generation: `${plan.snapshot.generation ?? "missing"}-changed`,
              updated_at: Date.now(),
            })
            .where("session_id", "=", sessionId),
        );
      } else if (kind === "transcript mutation watermark") {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_windows")
            .set({
              transcript_updated_at: (plan.snapshot.transcriptUpdatedAt ?? 0) + 1,
            })
            .where("session_id", "=", sessionId),
        );
      } else {
        executeSqliteQuerySync(
          database.db,
          db
            .updateTable("session_windows")
            .set({
              updated_at: (plan.snapshot.sessionUpdatedAt ?? 0) + 1,
            })
            .where("session_id", "=", sessionId),
        );
      }

      expect(() => deleteMaterializedPlans(database, materialized, sessionKey)).toThrow(
        `SQLite session state changed before deletion for ${sessionId}`,
      );
      expect(
        executeSqliteQuerySync(
          database.db,
          db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId),
        ).rows,
      ).toHaveLength(1);
    },
  );

  it("keeps rows when a non-archive delete plan becomes stale", async () => {
    const sessionId = "stale-non-archive-snapshot-session";
    const sessionKey = "agent:main:stale-non-archive-snapshot";
    await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "planned transcript"),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const plan = planSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      archiveTranscript: false,
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSessionStateDeletePlans([plan]);

    appendTranscriptEvent(database, sessionId);

    expect(() => deleteMaterializedPlans(database, materialized, sessionKey)).toThrow(
      `SQLite session state changed before deletion for ${sessionId}`,
    );
    expect(
      executeSqliteQuerySync(
        database.db,
        db.selectFrom("transcript_events").select("seq").where("session_id", "=", sessionId),
      ).rows,
    ).toHaveLength(2);
  });

  it.each(["trajectory", "ACP parent-stream"] as const)(
    "keeps rows when %s state changes after archive materialization",
    async (kind) => {
      const sessionId = `stale-${kind === "trajectory" ? "trajectory" : "acp"}-snapshot-session`;
      const sessionKey = `agent:main:${sessionId}`;
      await replaceTranscriptEvents({ sessionKey, sessionId, storePath }, [
        createTranscriptEvent(sessionId, "archived transcript"),
      ]);
      const database = openLifecycleTestDatabase(storePath);
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      const materialized = await materializeSessionStateDeletePlans([plan]);

      if (kind === "trajectory") {
        appendSqliteTrajectoryRuntimeEvents({ sessionId, storePath }, [
          createTestTrajectoryEvent(sessionId),
        ]);
      } else {
        recordAcpParentStreamEvents({
          agentId: database.agentId,
          path: database.path,
          sessionId,
          runId: "run-1",
          events: [{ event: { type: "output", text: "concurrent" }, createdAt: Date.now() }],
        });
      }

      expect(() => deleteMaterializedPlans(database, materialized, sessionKey)).toThrow(
        `SQLite session state changed before deletion for ${sessionId}`,
      );
      const rows =
        kind === "trajectory"
          ? executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("trajectory_runtime_events")
                .select("seq")
                .where("session_id", "=", sessionId),
            ).rows
          : executeSqliteQuerySync(
              database.db,
              db
                .selectFrom("acp_parent_stream_events")
                .select("seq")
                .where("session_id", "=", sessionId),
            ).rows;
      expect(rows).toHaveLength(1);
    },
  );
});

function createTranscriptEvent(sessionId: string, content: string): TestTranscriptEvent {
  return JSON.parse(createTranscriptEventLine(sessionId, content)) as TestTranscriptEvent;
}

function createTranscriptEventLine(sessionId: string, content: string): string {
  return JSON.stringify({ type: "session", id: sessionId, content });
}

function createTestTrajectoryEvent(sessionId: string): TrajectoryEvent {
  return {
    traceSchema: "openclaw-trajectory",
    schemaVersion: 1,
    traceId: sessionId,
    source: "runtime",
    type: "test.concurrent-delete",
    ts: "2026-07-22T00:00:00.000Z",
    seq: 1,
    sessionId,
  };
}

function readArchiveLines(archivePath: string | undefined): string[] {
  expect(archivePath).toBeTruthy();
  return readSessionArchiveContentSync(archivePath ?? "")
    .trim()
    .split("\n");
}

function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function openLifecycleTestDatabase(storePath: string) {
  const target = resolveSqliteTargetFromSessionStorePath(storePath);
  if (!target.path) {
    throw new Error(`Could not resolve SQLite database path for ${storePath}`);
  }
  return openOpenClawAgentDatabase({
    agentId: target.agentId ?? "main",
    path: target.path,
  });
}

function planArchiveWorker(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  archiveDirectory: string,
  sessionId: string,
) {
  const plan = planSessionStateDeleteIfUnreferenced({
    archiveDirectory,
    database,
    referencedSessionIds: new Set(),
    sessionId,
  });
  if (!plan) {
    throw new Error(`expected an archive plan for ${sessionId}`);
  }
  return plan;
}

function appendTranscriptEvent(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  sessionId: string,
): void {
  runOpenClawAgentWriteTransaction(
    (transactionDb) => {
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(transactionDb.db);
      executeSqliteQuerySync(
        transactionDb.db,
        db.insertInto("transcript_events").values({
          session_id: sessionId,
          seq: 1,
          event_json: createTranscriptEventLine("concurrent-event", "concurrent append"),
          created_at: Date.now(),
        }),
      );
      touchTranscriptMutationInTransaction(transactionDb, sessionId);
    },
    { agentId: database.agentId, path: database.path },
  );
}

function deleteMaterializedPlans(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  plans: Parameters<typeof deleteMaterializedSessionStatePlans>[1],
  excludedSessionKey: string,
): void {
  runOpenClawAgentWriteTransaction(
    (transactionDb) =>
      deleteMaterializedSessionStatePlans(
        transactionDb,
        plans,
        undefined,
        new Set([excludedSessionKey]),
      ),
    { agentId: database.agentId, path: database.path },
  );
}
