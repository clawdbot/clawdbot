import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { listSessionTranscriptCorpusEntriesForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { MemorySessionSyncTarget } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { deleteSessionEntry, upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import { recordMemorySessionTombstones } from "../memory-entry-origins.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory session update sync", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, getFreshManager, seedSessionTranscript } = fixture;

  function seedIndexedSession(database: DatabaseSync, sessionPath: string, text: string): void {
    database
      .prepare(
        "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, 'sessions', ?, ?, ?)",
      )
      .run(sessionPath, "stale-session", 10, 20);
    database
      .prepare(
        "INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, 'sessions', 1, 1, ?, ?, ?, ?, ?)",
      )
      .run(sessionPath, sessionPath, "stale-chunk", "fts-only", text, "[]", 10);
    database
      .prepare(
        "INSERT INTO memory_index_chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, 'sessions', ?, 1, 1)",
      )
      .run(text, sessionPath, sessionPath, "fts-only");
    database
      .prepare(
        "INSERT INTO memory_index_chunk_provenance (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'system', 'subagent', ?)",
      )
      .run(sessionPath, 10);
  }

  function expectSessionIndexRemoved(database: DatabaseSync, sessionPath: string): void {
    expect(
      database
        .prepare("SELECT path FROM memory_index_sources WHERE path = ? AND source = 'sessions'")
        .get(sessionPath),
    ).toBeUndefined();
    expect(
      database
        .prepare("SELECT path FROM memory_index_chunks WHERE path = ? AND source = 'sessions'")
        .get(sessionPath),
    ).toBeUndefined();
    expect(
      database
        .prepare(
          "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? AND path = ?",
        )
        .all("violet", sessionPath),
    ).toEqual([]);
  }

  it("indexes an update that arrives before an active sync clears dirty state", async () => {
    fixture.setStateDir(path.join(fixture.paths.workspace, ".state-session-update-during-sync"));
    const sessionId = "session-update-during-sync";
    const sessionKey = `agent:main:proof:${sessionId}`;
    const updatedMarker = "UPDATE DURING ACTIVE SYNC 811";
    const manager = await getFreshManager(
      createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    const owner = manager as unknown as {
      queuedSessionSync: Promise<void> | null;
      sessionPendingTargets: Map<string, MemorySessionSyncTarget>;
      sessionsDirty: boolean;
      sessionsReconcileDirty: boolean;
      syncArchiveFiles: (params: unknown) => Promise<void>;
      processSessionUpdateBatch: () => Promise<void>;
    };
    let releaseActiveSync = () => {};
    const activeSyncGate = new Promise<void>((resolve) => {
      releaseActiveSync = resolve;
    });
    let markActiveSyncIndexed = () => {};
    const activeSyncIndexed = new Promise<void>((resolve) => {
      markActiveSyncIndexed = resolve;
    });
    let syncArchiveFilesSpy: { mockRestore: () => void } | undefined;
    try {
      await seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "user", timestamp: Date.now(), content: "initial transcript" }],
      });
      await manager.sync({ reason: "test-baseline", force: true });

      owner.sessionsDirty = true;
      owner.sessionsReconcileDirty = true;
      const syncArchiveFiles = owner.syncArchiveFiles.bind(manager);
      syncArchiveFilesSpy = vi
        .spyOn(owner, "syncArchiveFiles")
        .mockImplementationOnce(async (params) => {
          await syncArchiveFiles(params);
          markActiveSyncIndexed();
          await activeSyncGate;
        });
      const activeSync = manager.sync({ reason: "test-active" });
      await activeSyncIndexed;

      await seedSessionTranscript({
        sessionId,
        sessionKey,
        messages: [{ role: "assistant", timestamp: Date.now(), content: updatedMarker }],
      });
      owner.sessionPendingTargets.set(sessionKey, { agentId: "main", sessionId, sessionKey });
      await owner.processSessionUpdateBatch();
      const queuedSessionSync = owner.queuedSessionSync;
      expect(queuedSessionSync).not.toBeNull();

      releaseActiveSync();
      await activeSync;
      await queuedSessionSync;

      const observer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
        readOnly: true,
      });
      try {
        const row = observer
          .prepare(
            "SELECT COUNT(*) AS count FROM memory_index_chunks WHERE source = 'sessions' AND text LIKE ?",
          )
          .get(`%${updatedMarker}%`) as { count: number };
        expect(row.count).toBeGreaterThan(0);
      } finally {
        observer.close();
      }
      expect(manager.status().dirty).toBe(false);
    } finally {
      syncArchiveFilesSpy?.mockRestore();
      releaseActiveSync();
      await manager.close?.();
      fixture.restoreStateDir();
    }
  });

  it.each(["startup catch-up", "forced reindex"] as const)(
    "removes previously indexed dreaming narratives during %s",
    async (mode) => {
      const sessionId = "narrative-thread";
      await seedSessionTranscript({
        sessionId,
        sessionKey: "agent:main:dreaming-narrative-run-1",
        messages: [
          {
            role: "user",
            timestamp: Date.now(),
            content: "Internal narrative violet fragment that must never remain indexed.",
          },
        ],
      });
      const manager = await getFreshManager(
        createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
        "cli",
      );
      const database = Reflect.get(manager, "db") as DatabaseSync;
      const sessionPath = `sessions/main/${sessionId}.jsonl`;
      seedIndexedSession(database, sessionPath, "Internal narrative violet fragment");

      if (mode === "startup catch-up") {
        await (
          manager as unknown as { runSessionStartupCatchup: () => Promise<string[]> }
        ).runSessionStartupCatchup();
        await manager.sync({ reason: "await-startup-catchup" });
      } else {
        await manager.sync({ reason: "forced-reindex", force: true });
      }

      expectSessionIndexRemoved(database, sessionPath);
    },
  );

  it.each([
    {
      description: "narrative archive through CLI forced indexing",
      sessionKey: "agent:main:dreaming-narrative-memory-core-v2-light-real",
      runId: "dreaming-narrative-main-light-real",
      force: true,
    },
    {
      description: "unchanged narrative archive through regular reconciliation",
      sessionKey: "agent:main:dreaming-narrative-memory-core-v2-light-real",
      runId: "dreaming-narrative-main-light-real",
      force: false,
    },
    {
      description: "cron archive through CLI forced indexing",
      sessionKey: "agent:main:cron:job-1:run:run-1",
      runId: "internal-cron-run-1",
      force: true,
    },
    {
      description: "heartbeat archive through CLI forced indexing",
      sessionKey: "agent:main:chat:base:heartbeat",
      runId: "internal-heartbeat-run-1",
      force: true,
    },
  ])("prunes a real compressed $description", async (scenario) => {
    const sessionId = "3cb3f634-6821-4123-8123-abcdef123456";
    const sessionKey = scenario.sessionKey;
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const storePath = path.join(sessionsDir, "sessions.json");
    await seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [
        {
          role: "user",
          timestamp: Date.now(),
          content: "Previously retained violet fragment.",
        },
      ],
    });
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId,
      sessionKey,
      storePath,
      message: {
        role: "assistant",
        timestamp: Date.now(),
        content: [{ type: "text", text: "A narrative derived from that violet fragment." }],
        __openclaw: { runId: scenario.runId },
      },
    });
    await expect(
      deleteSessionEntry({
        agentId: "main",
        archiveTranscript: true,
        expectedSessionId: sessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(true);
    const archiveName = (await fs.readdir(sessionsDir)).find(
      (name) => name.startsWith(`${sessionId}.jsonl.deleted.`) && name.endsWith(".zst"),
    );
    expect(archiveName).toBeDefined();
    const manager = await getFreshManager(
      createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
      true,
    );
    expect(manager.status().sourceCounts?.find((source) => source.source === "sessions")).toEqual(
      expect.objectContaining({ eligible: 0 }),
    );
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const sessionPath = `sessions/main/${archiveName}`;
    expect(
      database
        .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
        .get(sessionId),
    ).toBeUndefined();
    expect(
      (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
        (entry) => entry.sessionId === sessionId,
      ),
    ).toMatchObject({ artifactKind: "archive-artifact", sessionKind: "unknown" });
    seedIndexedSession(database, sessionPath, "Previously retained violet fragment");
    database
      .prepare(
        "UPDATE memory_index_chunk_provenance SET origin_class = 'owner', session_kind = 'unknown' WHERE chunk_id = ?",
      )
      .run(sessionPath);
    const archiveStat = await fs.stat(path.join(sessionsDir, archiveName!));
    database
      .prepare("UPDATE memory_index_sources SET mtime = ?, size = ? WHERE path = ?")
      .run(archiveStat.mtimeMs, archiveStat.size, sessionPath);

    if (scenario.force) {
      await manager.sync({ reason: "cli", force: true });
    } else {
      await (
        manager as unknown as { runSessionStartupCatchup: () => Promise<string[]> }
      ).runSessionStartupCatchup();
      await manager.sync({ reason: "await-startup-catchup" });
    }

    expectSessionIndexRemoved(database, sessionPath);
  });

  it("never reindexes a tombstoned session while preserving its source transcript", async () => {
    const sessionId = "forgotten-transcript";
    const sessionKey = `agent:main:chat:${sessionId}`;
    await seedSessionTranscript({
      sessionId,
      sessionKey,
      messages: [
        { role: "user", timestamp: Date.now(), content: "Previously indexed violet fragment." },
      ],
    });
    const manager = await getFreshManager(
      createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    const database = Reflect.get(manager, "db") as DatabaseSync;
    const sessionPath = `sessions/main/${sessionId}.jsonl`;
    await manager.sync({ reason: "index-before-forget", force: true });
    expect(
      database.prepare("SELECT path FROM memory_index_chunks WHERE path = ?").get(sessionPath),
    ).toEqual({ path: sessionPath });

    recordMemorySessionTombstones({ agentId: "main", sessionIds: [sessionId] });
    await manager.sync({ reason: "forced-reindex-after-forget", force: true });

    expectSessionIndexRemoved(database, sessionPath);
    expect(
      database
        .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
        .get(sessionId),
    ).toEqual({ session_id: sessionId });
    await manager.sync({
      reason: "targeted-update-after-forget",
      sessions: [{ agentId: "main", sessionId, sessionKey }],
    });
    expectSessionIndexRemoved(database, sessionPath);
  });

  it.each([
    { description: "system-only", includeUserTurn: false, indexable: false },
    { description: "mixed user/system", includeUserTurn: true, indexable: true },
  ])("indexes only eligible $description archived transcripts", async (scenario) => {
    const archiveName = "internal-turn.jsonl.deleted.2026-08-26T11-00-00.000Z";
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const records = [
      {
        type: "message",
        message: {
          role: "user",
          content: "Internal system-generated fragment",
          provenance: { kind: "internal_system", sourceTool: "internal-maintenance" },
        },
      },
      ...(scenario.includeUserTurn
        ? [
            {
              type: "message",
              message: {
                role: "user",
                content: "Real user conversation about agent:main:dreaming-narrative-run-1",
              },
            },
          ]
        : []),
    ];
    await fs.writeFile(
      path.join(sessionsDir, archiveName),
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
    );
    const manager = await getFreshManager(
      createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );

    await manager.sync({ reason: "forced-reindex", force: true });

    const database = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      database
        .prepare("SELECT DISTINCT path FROM memory_index_chunks WHERE source = 'sessions'")
        .all(),
    ).toEqual(scenario.indexable ? [{ path: `sessions/main/${archiveName}` }] : []);
  });

  it.each([
    { kind: "cron", sessionKey: "agent:main:cron:job-1:run:run-1" },
    { kind: "dreaming narrative", sessionKey: "agent:main:dreaming-narrative-run-1" },
    {
      kind: "heartbeat",
      sessionKey: "agent:main:heartbeat:run-1",
      heartbeatIsolatedBaseSessionKey: "agent:main:chat:base",
    },
  ])("excludes $kind transcripts from targeted memory indexing", async (systemSession) => {
    const sessionId = "system-thread";
    await seedSessionTranscript({
      sessionId,
      sessionKey: systemSession.sessionKey,
      messages: [{ role: "assistant", timestamp: Date.now(), content: "Internal system output." }],
    });
    if (systemSession.heartbeatIsolatedBaseSessionKey) {
      await upsertSessionEntry({
        agentId: "main",
        sessionKey: systemSession.sessionKey,
        storePath: path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json"),
        entry: {
          sessionId,
          updatedAt: Date.now(),
          heartbeatIsolatedBaseSessionKey: systemSession.heartbeatIsolatedBaseSessionKey,
        },
      });
    }
    const manager = await getFreshManager(
      createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );

    await manager.sync({
      reason: "targeted-generated-session",
      sessions: [{ agentId: "main", sessionId, sessionKey: systemSession.sessionKey }],
    });

    const database = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      database.prepare("SELECT path FROM memory_index_chunks WHERE source = 'sessions'").all(),
    ).toEqual([]);
  });
});
