// SQLite transcript archive worker tests cover off-main execution and snapshot fencing.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAcpParentStreamEvents } from "../../agents/subagents/spawn/acp-parent-stream-store.sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../../state/openclaw-agent-db.generated.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { appendSqliteTrajectoryRuntimeEvents } from "../../trajectory/runtime-store.sqlite.js";
import type { TrajectoryEvent } from "../../trajectory/types.js";
import { readSessionArchiveContentSync } from "./archive-compression.js";
import {
  deleteSessionEntryLifecycle,
  loadSessionEntry,
  loadTranscriptEvents,
  replaceSessionEntry,
} from "./session-accessor.js";
import { materializeSqliteSessionStateDeletePlans } from "./session-accessor.sqlite-archive.js";
import { materializeSqliteTranscriptArchiveInWorker } from "./session-accessor.sqlite-archive.worker.js";
import {
  deleteMaterializedSqliteSessionStatePlans,
  planSqliteSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";

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

  afterEach(() => {
    closeOpenClawAgentDatabasesForTest();
    fs.rmSync(tempDir, { recursive: true, force: true });
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
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, events);

    const heartbeatTimes = [performance.now()];
    const heartbeat = setInterval(() => {
      heartbeatTimes.push(performance.now());
    }, 5);
    let materialized: Awaited<ReturnType<typeof materializeSqliteSessionStateDeletePlans>>;
    try {
      const database = openLifecycleTestDatabase(storePath);
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      materialized = await materializeSqliteSessionStateDeletePlans([plan]);
    } finally {
      heartbeatTimes.push(performance.now());
      clearInterval(heartbeat);
    }

    const heartbeatGaps: number[] = [];
    for (let index = 1; index < heartbeatTimes.length; index += 1) {
      const current = heartbeatTimes[index];
      const previous = heartbeatTimes[index - 1];
      if (current !== undefined && previous !== undefined) {
        heartbeatGaps.push(current - previous);
      }
    }
    expect(heartbeatTimes.length - 2).toBeGreaterThan(5);
    expect(Math.max(...heartbeatGaps)).toBeLessThan(150);
    expect(materialized).toHaveLength(1);
    const archivedPath = materialized[0]?.archivedTranscript?.archivedPath;
    expect(archivedPath).toBeTruthy();
    const expectedContent = `${events.map((event) => JSON.stringify(event)).join("\n")}\n`;
    const archivedContent = readSessionArchiveContentSync(archivedPath ?? "");
    expect(Buffer.byteLength(archivedContent)).toBe(Buffer.byteLength(expectedContent));
    expect(sha256(archivedContent)).toBe(sha256(expectedContent));
    const archiveLines = readArchiveLines(archivedPath);
    expect(archiveLines).toHaveLength(events.length);
    expect(archiveLines.map((line) => (JSON.parse(line) as { id: string }).id)).toEqual(
      events.map((event) => event.id),
    );
  });

  it("publishes a durable archive before lifecycle deletion", async () => {
    const sessionId = "durable-delete-session";
    const sessionKey = "agent:main:durable-delete";
    await replaceSessionEntry(
      { sessionKey, storePath },
      {
        sessionId,
        updatedAt: Date.now(),
      },
    );
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "durable archive first"),
    ]);

    const originalLinkSync = fs.linkSync;
    const originalRenameSync = fs.renameSync;
    const entryObservedDuringArchivePublish: boolean[] = [];
    const observeArchivePublish = (archivePath: unknown) => {
      if (String(archivePath).includes(`${sessionId}.jsonl.deleted.`)) {
        entryObservedDuringArchivePublish.push(
          loadSessionEntry({ sessionKey, storePath })?.sessionId === sessionId,
        );
      }
    };
    const openSpy = vi.spyOn(fs, "openSync");
    const fsyncSpy = vi.spyOn(fs, "fsyncSync");
    const linkSpy = vi.spyOn(fs, "linkSync").mockImplementation((...args) => {
      observeArchivePublish(args[1]);
      return originalLinkSync(...args);
    });
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((...args) => {
      observeArchivePublish(args[1]);
      return originalRenameSync(...args);
    });

    let archivedPath: string | null = null;
    try {
      const database = openLifecycleTestDatabase(storePath);
      const workerResult = materializeSqliteTranscriptArchiveInWorker(
        planArchiveWorker(database, path.dirname(storePath), sessionId),
      );
      archivedPath = workerResult.archivedPath;
      expect(archivedPath).not.toBeNull();
      expect(entryObservedDuringArchivePublish).toEqual([true]);
      const archiveTempOpenIndexes = openSpy.mock.calls.flatMap((args, index) =>
        String(args[0]).includes(`${sessionId}.jsonl.deleted.`) && args[1] === "wx" ? [index] : [],
      );
      expect(archiveTempOpenIndexes).toHaveLength(1);
      const archiveTempOpenIndex = archiveTempOpenIndexes[0] ?? -1;
      expect(fsyncSpy).toHaveBeenCalledWith(openSpy.mock.results[archiveTempOpenIndex]?.value);
    } finally {
      renameSpy.mockRestore();
      linkSpy.mockRestore();
      fsyncSpy.mockRestore();
      openSpy.mockRestore();
    }

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: {
        canonicalKey: sessionKey,
        storeKeys: [sessionKey],
      },
    });
    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts.map((archive) => archive.archivedPath)).toEqual([
      archivedPath,
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
    await replaceSqliteTranscriptEvents(mainScope, [mainEvent]);
    await replaceSessionEntry(opsScope, { sessionId: opsSessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents(opsScope, [opsEvent]);

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

    const plan = planArchiveWorker(database, tempDir, opsSessionId);
    expect(plan).toMatchObject({
      agentId: database.agentId,
      databasePath: database.path,
      sessionId: opsSessionId,
    });
    const materialized = await materializeSqliteSessionStateDeletePlans([plan]);
    const archivedPath = materialized[0]?.archivedTranscript?.archivedPath;
    expect(readArchiveLines(archivedPath ?? undefined)).toEqual([JSON.stringify(opsEvent)]);

    deleteMaterializedPlans(database, materialized, opsSessionKey);

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
    await replaceSqliteTranscriptEvents(scope, [original]);
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);

    await replaceSqliteTranscriptEvents(scope, [
      original,
      createTranscriptEvent("concurrent-event", "concurrent append"),
    ]);

    await expect(materializeSqliteSessionStateDeletePlans([plan])).rejects.toThrow(
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
    await replaceSqliteTranscriptEvents(
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

    await expect(materializeSqliteSessionStateDeletePlans([plan, conflictingPlan])).rejects.toThrow(
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

    await replaceSqliteTranscriptEvents(scope, [
      createTranscriptEvent(sessionId, "first concurrent append"),
    ]);

    await expect(materializeSqliteSessionStateDeletePlans([plan])).rejects.toThrow(
      `SQLite session state changed before archive materialization for ${sessionId}`,
    );
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
  });

  it("recovers the lifecycle archive queue after a worker file failure", async () => {
    const sessionId = "archive-file-failure-session";
    const scope = {
      sessionKey: "agent:main:archive-file-failure",
      sessionId,
      storePath,
    };
    await replaceSqliteTranscriptEvents(scope, [
      createTranscriptEvent(sessionId, "preserve after file failure"),
    ]);
    const blockedArchiveDirectory = path.join(tempDir, "archive-path-is-a-file");
    fs.writeFileSync(blockedArchiveDirectory, "not a directory", "utf8");
    const database = openLifecycleTestDatabase(storePath);
    const plan = planArchiveWorker(database, blockedArchiveDirectory, sessionId);
    const recoverySessionId = "archive-after-file-failure-session";
    const recoveryScope = {
      sessionKey: "agent:main:archive-after-file-failure",
      sessionId: recoverySessionId,
      storePath,
    };
    await replaceSqliteTranscriptEvents(recoveryScope, [
      createTranscriptEvent(recoverySessionId, "archive after queued failure"),
    ]);
    const recoveryPlan = planArchiveWorker(database, path.dirname(storePath), recoverySessionId);

    const failedArchive = materializeSqliteSessionStateDeletePlans([plan]);
    const recoveredArchive = materializeSqliteSessionStateDeletePlans([recoveryPlan]);

    await expect(failedArchive).rejects.toThrow();
    await expect(recoveredArchive).resolves.toMatchObject([
      {
        archivedTranscript: {
          archivedPath: expect.stringContaining(`${recoverySessionId}.jsonl.deleted.`),
        },
        sessionId: recoverySessionId,
      },
    ]);
    await expect(loadTranscriptEvents(scope)).resolves.toHaveLength(1);
    expect(fs.readFileSync(blockedArchiveDirectory, "utf8")).toBe("not a directory");
  });

  it("preserves all lifecycle state when the archive worker rejects publication", async () => {
    const sessionId = "nested/archive-worker-lifecycle-failure";
    const sessionKey = "agent:main:archive-worker-lifecycle-failure";
    const scope = { sessionKey, sessionId, storePath };
    await replaceSessionEntry(scope, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents(scope, [
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

  it("keeps rows when a transcript changes after its archive snapshot", async () => {
    const sessionId = "stale-archive-snapshot-session";
    const sessionKey = "agent:main:stale-archive-snapshot";
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "archived snapshot"),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

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
      await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
        createTranscriptEvent(sessionId, "archived transcript"),
      ]);
      const database = openLifecycleTestDatabase(storePath);
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      expect(plan.snapshot.generation).not.toBeNull();
      expect(plan.snapshot.sessionUpdatedAt).not.toBeNull();
      expect(plan.snapshot.transcriptUpdatedAt).not.toBeNull();
      const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

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
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "planned transcript"),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
    const plan = planSqliteSessionStateDeleteIfUnreferenced({
      archiveDirectory: path.dirname(storePath),
      archiveTranscript: false,
      database,
      referencedSessionIds: new Set(),
      sessionId,
    });
    if (!plan) {
      throw new Error("expected an unreferenced SQLite transcript delete plan");
    }
    const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

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
      await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
        createTranscriptEvent(sessionId, "archived transcript"),
      ]);
      const database = openLifecycleTestDatabase(storePath);
      const db = getNodeSqliteKysely<OpenClawAgentKyselyDatabase>(database.db);
      const plan = planArchiveWorker(database, path.dirname(storePath), sessionId);
      const materialized = await materializeSqliteSessionStateDeletePlans([plan]);

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

  it("does not reuse a matching in-flight temp file as an archive", async () => {
    const sessionId = "in-flight-temp-archive-session";
    const line = createTranscriptEventLine(sessionId, "in-flight temp archive");
    await replaceSqliteTranscriptEvents(
      { sessionKey: "agent:main:in-flight-temp-archive", sessionId, storePath },
      [JSON.parse(line) as TestTranscriptEvent],
    );
    const archiveDirectory = path.dirname(storePath);
    const tempPath = path.join(
      archiveDirectory,
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z.writer.tmp`,
    );
    fs.mkdirSync(archiveDirectory, { recursive: true });
    fs.writeFileSync(tempPath, `${line}\n`, "utf8");

    const database = openLifecycleTestDatabase(storePath);
    const result = materializeSqliteTranscriptArchiveInWorker(
      planArchiveWorker(database, archiveDirectory, sessionId),
    );

    expect(result.archivedPath).not.toBe(tempPath);
    expect(fs.existsSync(tempPath)).toBe(true);
    expect(readArchiveLines(result.archivedPath ?? undefined)).toEqual([line]);
  });

  it("reuses a matching archive before deleting entry rows", async () => {
    const sessionId = "duplicate-archive-session";
    const sessionKey = "agent:main:duplicate-archive";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "reuse archive"),
    ]);
    const archivePath = path.join(
      path.dirname(storePath),
      `${sessionId}.jsonl.deleted.2026-01-01T00-00-00.000Z`,
    );
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(
      archivePath,
      `${createTranscriptEventLine(sessionId, "reuse archive")}\n`,
      "utf-8",
    );

    const originalReaddirSync = fs.readdirSync;
    const entryObservedDuringDuplicateProbe: boolean[] = [];
    const readdirSpy = vi.spyOn(fs, "readdirSync").mockImplementation((...args) => {
      if (String(args[0]) === path.dirname(storePath)) {
        entryObservedDuringDuplicateProbe.push(
          loadSessionEntry({ sessionKey, storePath })?.sessionId === sessionId,
        );
      }
      return originalReaddirSync(...args);
    });

    try {
      const database = openLifecycleTestDatabase(storePath);
      const workerResult = materializeSqliteTranscriptArchiveInWorker(
        planArchiveWorker(database, path.dirname(storePath), sessionId),
      );
      expect(workerResult.archivedPath).toBe(archivePath);
      expect(entryObservedDuringDuplicateProbe).toEqual([true]);
    } finally {
      readdirSpy.mockRestore();
    }

    const result = await deleteSessionEntryLifecycle({
      archiveTranscript: true,
      storePath,
      target: { canonicalKey: sessionKey, storeKeys: [sessionKey] },
    });
    expect(result.deleted).toBe(true);
    expect(result.archivedTranscripts).toEqual([
      {
        archivedPath: archivePath,
        sourcePath: path.join(path.dirname(storePath), `${sessionId}.jsonl`),
      },
    ]);
  });
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

function sha256(content: string): string {
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
  const plan = planSqliteSessionStateDeleteIfUnreferenced({
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
  plans: Parameters<typeof deleteMaterializedSqliteSessionStatePlans>[1],
  excludedSessionKey: string,
): void {
  runOpenClawAgentWriteTransaction(
    (transactionDb) =>
      deleteMaterializedSqliteSessionStatePlans(
        transactionDb,
        plans,
        undefined,
        new Set([excludedSessionKey]),
      ),
    { agentId: database.agentId, path: database.path },
  );
}
