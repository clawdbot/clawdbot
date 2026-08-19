// SQLite transcript archive worker tests cover off-main execution and snapshot fencing.
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recordAcpParentStreamEvents } from "../../agents/subagents/spawn/acp-parent-stream-store.sqlite.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { resetMemoryIsolationCutoverForTest } from "../../plugins/memory-cutover.js";
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
import { importConfirmedSqliteTranscriptPolicyArchive } from "./session-accessor.sqlite-import.js";
import {
  deleteMaterializedSqliteSessionStatePlans,
  planSqliteSessionStateDeleteIfUnreferenced,
} from "./session-accessor.sqlite-lifecycle-state.js";
import { touchTranscriptMutationInTransaction } from "./session-accessor.sqlite-transcript-state.js";
import { replaceSqliteTranscriptEvents } from "./session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import {
  readAuthorizedTranscriptEventSeqs,
  resetTranscriptMemoryPolicyForTest,
} from "./session-transcript-memory-policy.js";
import {
  parseTranscriptPolicyArchive,
  restoreConfirmedTranscriptPolicyArchiveInTransaction,
} from "./session-transcript-policy-archive.js";

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
    resetMemoryIsolationCutoverForTest();
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

  it("keeps legacy archives raw JSONL and exports enforced events with immutable companions", async () => {
    const legacySessionId = "legacy-policy-archive-session";
    const legacySessionKey = "agent:main:legacy-policy-archive";
    const legacyEvent = createTranscriptEvent(legacySessionId, "legacy archive bytes");
    await replaceSessionEntry(
      { sessionKey: legacySessionKey, storePath },
      { sessionId: legacySessionId, updatedAt: Date.now() },
    );
    await replaceSqliteTranscriptEvents(
      { sessionKey: legacySessionKey, sessionId: legacySessionId, storePath },
      [legacyEvent],
    );
    const database = openLifecycleTestDatabase(storePath);
    const legacyArchive = materializeSqliteTranscriptArchiveInWorker(
      planArchiveWorker(database, path.dirname(storePath), legacySessionId),
    );
    expect(readArchiveLines(legacyArchive.archivedPath)).toEqual([JSON.stringify(legacyEvent)]);

    const sessionId = "enforced-policy-archive-session";
    const sessionKey = "agent:main:enforced-policy-archive";
    const event = createTranscriptEvent(sessionId, "audited archive bytes");
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [event]);
    const { eventSeq } = seedEnforcedArchivePolicy(database, { sessionId });

    const archive = materializeSqliteTranscriptArchiveInWorker(
      planArchiveWorker(database, path.dirname(storePath), sessionId),
    );
    const lines = readArchiveLines(archive.archivedPath);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(JSON.stringify(event));
    expect(JSON.parse(lines[1] ?? "")).toMatchObject({
      type: "openclaw.memory-policy-archive-v1",
      version: 1,
      agentId: "main",
      sessionId,
      eventSeq,
      subject: expect.objectContaining({
        sessionKey,
        sessionIdentityRevision: expect.any(String),
        subjectRevision: expect.any(String),
      }),
      policy: expect.objectContaining({
        runExposureSetId: "archive-exposure-set",
        sourcePolicySetId: "archive-policy-set",
      }),
      detail: expect.objectContaining({
        sourceEventSeq: eventSeq,
        sourceSessionId: sessionId,
      }),
    });

    const parsed = parseTranscriptPolicyArchive(
      readSessionArchiveContentSync(archive.archivedPath ?? ""),
    );
    expect(parsed).toBeDefined();
    if (!parsed) {
      throw new Error("expected a confirmed archive envelope");
    }
    database.db.exec(/* sqlite-allow-raw: fixture resets a just-restored pending companion. */ `
      DELETE FROM transcript_event_memory_policy_details
       WHERE session_id = '${sessionId}';
      UPDATE transcript_event_memory_policies
         SET authorization_status = 'pending',
             source_policy_set_id = NULL,
             run_exposure_set_id = NULL,
             run_exposure_revision = NULL,
             delivery_audiences_json = NULL,
             session_identity_revision = NULL,
             subject_revision = NULL,
             run_id = NULL,
             context_fingerprint = NULL
       WHERE session_id = '${sessionId}';
    `);
    runOpenClawAgentWriteTransaction(
      (transactionDatabase) =>
        restoreConfirmedTranscriptPolicyArchiveInTransaction({
          archive: parsed,
          database: transactionDatabase,
          sessionId,
          sessionKey,
        }),
      { agentId: database.agentId, path: database.path },
    );
    expect(readAuthorizedTranscriptEventSeqs(database.db, sessionId)).toEqual(new Set([eventSeq]));
    expect(readArchiveLines(archive.archivedPath)).toHaveLength(2);
  });

  it("restores a confirmed archive only through its original immutable session subject", async () => {
    const sessionId = "confirmed-policy-archive-session";
    const sessionKey = "agent:main:confirmed-policy-archive";
    const event = createTranscriptEvent(sessionId, "confirmed archive restore bytes");
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [event]);
    const database = openLifecycleTestDatabase(storePath);
    const { eventSeq } = seedEnforcedArchivePolicy(database, { sessionId });
    const archive = materializeSqliteTranscriptArchiveInWorker(
      planArchiveWorker(database, path.dirname(storePath), sessionId),
    );
    const archiveContent = readSessionArchiveContentSync(archive.archivedPath ?? "");
    const sourceSnapshot = database.db
      .prepare(
        `SELECT session_identity_revision, subject_revision
           FROM session_memory_subject_snapshots
          WHERE session_id = ?`,
      )
      .get(sessionId);

    // Lifecycle deletion removes rows owned by the old session window while the
    // immutable subject snapshot remains available for a confirmed same-agent restore.
    database.db.exec(/* sqlite-allow-raw: fixture simulates post-archive lifecycle reclamation. */ `
      DELETE FROM session_nodes WHERE session_key = '${sessionKey}';
      DELETE FROM session_windows WHERE session_id = '${sessionId}';
    `);
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM session_memory_subjects WHERE session_key = ?")
        .get(sessionKey),
    ).toEqual({ count: 1 });

    await expect(
      importConfirmedSqliteTranscriptPolicyArchive({
        agentId: database.agentId,
        archiveContent,
        entry: { sessionId, updatedAt: Date.now() },
        sessionKey,
        storePath,
      }),
    ).resolves.toEqual({ sessionId, sessionKey, transcriptEvents: 1 });
    expect(readAuthorizedTranscriptEventSeqs(database.db, sessionId)).toEqual(new Set([eventSeq]));
    expect(
      database.db
        .prepare(
          `SELECT session_identity_revision, subject_revision
             FROM session_memory_subject_snapshots
            WHERE session_id = ?`,
        )
        .get(sessionId),
    ).toEqual(sourceSnapshot);
  });

  it("rolls a confirmed archive import back when the retained policy is no longer current", async () => {
    const sessionId = "revoked-confirmed-policy-archive-session";
    const sessionKey = "agent:main:revoked-confirmed-policy-archive";
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "revoked confirmed archive restore bytes"),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    seedEnforcedArchivePolicy(database, { sessionId });
    const archive = materializeSqliteTranscriptArchiveInWorker(
      planArchiveWorker(database, path.dirname(storePath), sessionId),
    );
    const archiveContent = readSessionArchiveContentSync(archive.archivedPath ?? "");
    database.db
      .exec(/* sqlite-allow-raw: fixture revokes after archive confirmation materializes. */ `
      DELETE FROM session_nodes WHERE session_key = '${sessionKey}';
      DELETE FROM session_windows WHERE session_id = '${sessionId}';
      DROP TRIGGER memory_resource_revisions_immutable_fields;
      UPDATE memory_resource_revisions SET expires_at = 1 WHERE revision_id = 'archive-resource-revision';
    `);

    await expect(
      importConfirmedSqliteTranscriptPolicyArchive({
        agentId: database.agentId,
        archiveContent,
        entry: { sessionId, updatedAt: Date.now() },
        sessionKey,
        storePath,
      }),
    ).rejects.toThrow("confirmed transcript archive policy is no longer authorized");
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM session_nodes WHERE session_key = ?")
        .get(sessionKey),
    ).toEqual({ count: 0 });
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS count FROM transcript_events WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ count: 0 });
  });

  it.each([
    ["missing companion", {}],
    ["expired exposed resource", { expiresAt: 1 }],
  ])("fails closed for an enforced archive with %s", async (_name, options) => {
    const sessionId = `blocked-policy-archive-${_name.replaceAll(" ", "-")}`;
    const sessionKey = `agent:main:${sessionId}`;
    await replaceSessionEntry({ sessionKey, storePath }, { sessionId, updatedAt: Date.now() });
    await replaceSqliteTranscriptEvents({ sessionKey, sessionId, storePath }, [
      createTranscriptEvent(sessionId, "must remain in the source database"),
    ]);
    const database = openLifecycleTestDatabase(storePath);
    seedEnforcedArchivePolicy(database, {
      sessionId,
      includeDetail: _name !== "missing companion",
      ...options,
    });

    expect(() =>
      materializeSqliteTranscriptArchiveInWorker(
        planArchiveWorker(database, path.dirname(storePath), sessionId),
      ),
    ).toThrow(`Unauthorized transcript policy archive event for ${sessionId}`);
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

function seedEnforcedArchivePolicy(
  database: ReturnType<typeof openLifecycleTestDatabase>,
  params: { sessionId: string; includeDetail?: boolean; expiresAt?: number },
): { eventSeq: number } {
  const session = database.db
    .prepare(
      `SELECT session_identity_revision, session_key, subject_revision
         FROM session_memory_subject_snapshots
        WHERE session_id = ?`,
    )
    .get(params.sessionId) as
    | { session_identity_revision: string; session_key: string; subject_revision: string }
    | undefined;
  if (!session) {
    throw new Error(`expected session subject snapshot for ${params.sessionId}`);
  }
  const event = database.db
    .prepare(
      `SELECT seq
         FROM transcript_events
        WHERE session_id = ?
        ORDER BY seq ASC
        LIMIT 1`,
    )
    .get(params.sessionId) as { seq: number } | undefined;
  if (!event) {
    throw new Error(`expected transcript event for ${params.sessionId}`);
  }
  database.db.exec(/* sqlite-allow-raw: fixture establishes one evaluable archive lineage. */ `
    INSERT INTO memory_migrations
      (migration_id, source_kind, source_hash, phase, classification_json, plan_hash,
       verified_at, cutover_at, updated_at)
    VALUES ('archive-cutover', 'test', 'archive-source', 'cutover', '{}', 'archive-plan', 1, 1, 1);
    INSERT INTO memory_policies
      (policy_id, agent_id, current_revision_id, revocation_epoch, lifecycle_state, created_at, updated_at)
    VALUES ('archive-policy', 'main', 'archive-policy-revision', 0, 'active', 1, 1);
    INSERT INTO memory_policy_revisions
      (revision_id, policy_id, revision_number, revocation_epoch, lifecycle_state,
       actor_kind, actor_id, reason, created_at)
    VALUES ('archive-policy-revision', 'archive-policy', 1, 0, 'active', 'human', 'alice', 'fixture', 1);
    INSERT INTO memory_policy_sets
      (policy_set_id, agent_id, memory_policy_revision, member_policy_set_ids_json, created_at)
    VALUES ('archive-policy-set', 'main', 'archive-policy-revision', '["plugin-policy-set"]', 1);
    INSERT INTO memory_policy_set_members
      (policy_set_id, policy_id, expected_revision_id, expected_revocation_epoch,
       audience_intersection_json, retention_state, created_at)
    VALUES ('archive-policy-set', 'archive-policy', 'archive-policy-revision', 0,
            '[{"id":"alice","kind":"user"}]', 'retained', 1);
    INSERT INTO memory_storage_roots
      (storage_root_id, agent_id, backend_kind, opaque_locator, path_key_version, path_key,
       authority_kind, authority_owner_id, default_capabilities_json, lifecycle_state, created_at, updated_at)
    VALUES ('archive-root', 'main', 'builtin', 'builtin:v1:archive', 1,
            's1_archive_fixture_path_key_000', 'user', 'alice', '["read"]', 'active', 1, 1);
    INSERT INTO memory_stores
      (store_id, agent_id, storage_root_id, policy_id, scope_kind, audience_kind, audience_id,
       lifecycle_state, created_at, updated_at)
    VALUES ('archive-store', 'main', 'archive-root', 'archive-policy', 'user', 'user', 'alice', 'active', 1, 1);
    INSERT INTO memory_resources
      (resource_id, agent_id, store_id, logical_locator, source, created_at)
    VALUES ('archive-resource', 'main', 'archive-store', 'memory/archive.md', 'memory', 1);
    INSERT INTO memory_resource_revisions
      (revision_id, resource_id, revision_number, artifact_locator, content_hash, content_bytes,
       policy_revision_id, policy_revocation_epoch, source_policy_set_id, lifecycle_state,
       actor_kind, actor_id, expires_at, created_at, activated_at, retired_at)
    VALUES ('archive-resource-revision', 'archive-resource', 1, 'archive.md', 'archive', 7,
            'archive-policy-revision', 0, 'plugin-policy-set', 'active', 'human', 'alice',
            ${params.expiresAt ?? "NULL"}, 1, 1, NULL);
    INSERT INTO memory_run_exposures
      (exposure_set_id, agent_id, run_id, context_fingerprint, plan_id, revision_number,
       previous_exposure_set_id, source_policy_set_ids_json, effective_source_policy_set_id,
       exposed_resource_revisions_json, exposure_receipt_ids_json, egress_receipt_ids_json,
       delivery_audiences_json, delivery_revision, egress_registry_revision, created_at)
    VALUES ('archive-exposure-set', 'main', 'archive-run', 'archive-context', 'archive-plan', 1,
            NULL, '["plugin-policy-set"]', 'archive-policy-set',
            '["archive-resource-revision"]', '["archive-exposure"]', '["archive-egress"]',
            '[{"id":"alice","kind":"user"}]', 'delivery-1', 'egress-1', 1);
    INSERT INTO memory_run_exposure_resources
      (exposure_set_id, resource_revision_id, policy_set_id, created_at)
    VALUES ('archive-exposure-set', 'archive-resource-revision', 'archive-policy-set', 1);
  `);
  database.db
    .prepare(
      `INSERT INTO transcript_event_memory_policies
        (session_id, event_seq, authorization_status, source_policy_set_id, run_exposure_set_id,
         run_exposure_revision, delivery_audiences_json, session_identity_revision,
         subject_revision, run_id, context_fingerprint, created_at)
       VALUES (?, ?, 'authorized', 'archive-policy-set', 'archive-exposure-set', 1,
               '[{"id":"alice","kind":"user"}]', ?, ?, 'archive-run', 'archive-context', 1)`,
    )
    .run(params.sessionId, event.seq, session.session_identity_revision, session.subject_revision);
  if (params.includeDetail !== false) {
    database.db
      .prepare(
        `INSERT INTO transcript_event_memory_policy_details
          (session_id, event_seq, actor_evidence_json, delegation_snapshot_json,
           exposed_resource_revisions_json, exposure_receipt_ids_json, egress_receipt_ids_json,
           normalized_audience_intersection_json, finalized_delivery_audiences_json, retention_state,
           source_session_id, source_event_seq, created_at)
         VALUES (?, ?, '{"version":1}', '{"kind":"none","version":1}',
                 '["archive-resource-revision"]', '["archive-exposure"]', '["archive-egress"]',
                 '[{"id":"alice","kind":"user"}]', '[{"id":"alice","kind":"user"}]',
                 'retained', ?, ?, 1)`,
      )
      .run(params.sessionId, event.seq, params.sessionId, event.seq);
  }
  resetMemoryIsolationCutoverForTest();
  resetTranscriptMemoryPolicyForTest(database.db);
  return { eventSeq: event.seq };
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
