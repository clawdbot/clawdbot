import { unlinkSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  listSessionTranscriptCorpusEntriesForAgent,
  sessionPathForFile,
  sessionPathForSessionIdentity,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import {
  ensureMemoryChunkProvenance,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recordMemorySessionTombstones } from "../memory-entry-origins.js";
import { MemoryIndexRevisionConflictError } from "./manager-db.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import { closeAllMemoryIndexManagers, MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

function managerDatabase(manager: MemoryIndexManager): DatabaseSync {
  return (manager as unknown as { db: DatabaseSync }).db;
}

describe("memory manager shared agent connection", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const createConfig = () => fixture.createConfig({ provider: "none", vectorEnabled: false });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(["default", "cli", "maintenance"] as const)(
    "borrows the verified connection without another open or integrity scan for %s",
    async (purpose) => {
      const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
      const physicalOpen = vi.spyOn(sqliteRuntime, "openNodeSqliteDatabase");
      const prepare = vi.spyOn(shared.db, "prepare");
      const manager = await MemoryIndexManager.get({
        cfg: createConfig(),
        agentId: "main",
        purpose,
      });
      expect(manager).not.toBeNull();
      if (!manager) {
        throw new Error("manager missing");
      }
      fixture.trackManager(manager);

      expect(physicalOpen.mock.calls.filter(([location]) => location === shared.path)).toEqual([]);
      expect(
        prepare.mock.calls.filter(([sql]) => /integrity_check|foreign_key_check/i.test(sql)),
      ).toEqual([]);
      expect(managerDatabase(manager) === shared.db).toBe(true);
      await manager.close();
      expect(shared.db.isOpen).toBe(true);
      expect(shared.db.prepare("SELECT 1 AS alive").get()).toEqual({ alive: 1 });
    },
  );

  it("opens a hot-created agent through the same canonical owner", async () => {
    const cfg = createConfig();
    cfg.agents!.list!.push({ id: "hot", workspace: fixture.paths.workspace });
    const manager = await MemoryIndexManager.get({ cfg, agentId: "hot" });
    expect(manager).not.toBeNull();
    if (!manager) {
      throw new Error("manager missing");
    }
    fixture.trackManager(manager);
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "hot" });

    expect(managerDatabase(manager) === shared.db).toBe(true);
    expect(manager.status().dbPath).toBe(shared.path);
    await manager.sync({ reason: "test", force: true });
    expect((await manager.search("Alpha")).length).toBeGreaterThan(0);
  });

  it("keeps the borrowed connection alive across settings replacement and shutdown", async () => {
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const first = await fixture.getFreshManager(createConfig());
    const replacement = await fixture.getFreshManager(
      fixture.createConfig({
        provider: "none",
        vectorEnabled: false,
        minScore: 0.1,
      }),
    );

    expect(replacement === first).toBe(false);
    expect(managerDatabase(first) === shared.db).toBe(true);
    expect(managerDatabase(replacement) === shared.db).toBe(true);
    await first.close();
    await replacement.sync({ reason: "test", force: true });
    expect((await replacement.search("Alpha")).length).toBeGreaterThan(0);
    await closeAllMemorySearchManagers();
    expect(shared.db.isOpen).toBe(true);
    expect(shared.db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks").get()).toEqual({
      count: 1,
    });
  });

  it("rejects shared integrity failure before exposing a manager", async () => {
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    closeOpenClawAgentDatabasesForTest();
    const damaged = new DatabaseSync(shared.path);
    try {
      damaged.exec(`
        PRAGMA foreign_keys = OFF;
        CREATE TABLE fixture_parent (id INTEGER PRIMARY KEY);
        CREATE TABLE fixture_child (parent_id INTEGER REFERENCES fixture_parent(id));
        INSERT INTO fixture_child VALUES (1);
      `);
    } finally {
      damaged.close();
    }

    expect(() => sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" })).toThrow(
      /foreign_key_check/,
    );
    const result = await getMemorySearchManager({ cfg: createConfig(), agentId: "main" });
    expect(result.manager).toBeNull();
    expect(result.error).toMatch(/foreign_key_check/);
  });

  it("retains the borrowed connection through agent-cache eviction until manager close", async () => {
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const manager = await fixture.getFreshManager(createConfig());
    // Cross the shared owner's 64-handle LRU cap while the manager is idle.
    for (let index = 0; index < 65; index += 1) {
      sqliteRuntime.openOpenClawAgentDatabase({ agentId: `churn-${index}` });
    }

    expect(shared.db.isOpen).toBe(true);
    expect(managerDatabase(manager) === shared.db).toBe(true);
    await manager.sync({ reason: "test", force: true });
    expect((await manager.search("Alpha")).length).toBeGreaterThan(0);
    await manager.close();
    for (let index = 0; index < 65; index += 1) {
      sqliteRuntime.openOpenClawAgentDatabase({ agentId: `released-${index}` });
    }
    expect(shared.db.isOpen).toBe(false);
  });

  it("loads vectors on the shared connection with native loading disabled between calls", async () => {
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const manager = await fixture.getFreshManager(createConfig());
    expect(managerDatabase(manager) === shared.db).toBe(true);
    expect(() => shared.db.loadExtension("not-a-real-extension")).toThrow(
      "extension loading is not allowed",
    );
    expect((await loadSqliteVecExtension({ db: shared.db })).ok).toBe(true);
    expect(shared.db.prepare("SELECT vec_version() AS version").get()).toEqual({
      version: expect.any(String),
    });
    expect(() => shared.db.loadExtension("not-a-real-extension")).toThrow(
      "extension loading is not allowed",
    );
    expect(() => shared.db.prepare("SELECT load_extension(?)").get("not-a-real-extension")).toThrow(
      "not authorized",
    );
  });

  it("shares retained manager handles and trims released handles on the next open", async () => {
    const cfg = createConfig();
    const agents = Array.from({ length: 65 }, (_, index) => ({
      id: `retained-${index}`,
      workspace: fixture.paths.workspace,
    }));
    cfg.agents!.list = agents;
    const handles = new Set<DatabaseSync>();
    const countOpenHandles = () => [...handles].filter((db) => db.isOpen).length;
    for (const { id: agentId } of agents) {
      handles.add(sqliteRuntime.openOpenClawAgentDatabase({ agentId }).db);
      const manager = await MemoryIndexManager.get({ cfg, agentId });
      if (!manager) {
        throw new Error("manager missing");
      }
      fixture.trackManager(manager);
      handles.add(managerDatabase(manager));
    }
    const retained = countOpenHandles();

    await closeAllMemoryIndexManagers();
    const afterRelease = countOpenHandles();
    handles.add(sqliteRuntime.openOpenClawAgentDatabase({ agentId: "after-release" }).db);

    expect({ retained, afterRelease, afterOpen: countOpenHandles() }).toEqual({
      retained: agents.length,
      afterRelease: agents.length,
      afterOpen: 64,
    });
  });

  it("replaces a revoked shared handle without an old release closing its replacement", async () => {
    const first = await fixture.getFreshManager(createConfig());
    const originalDb = managerDatabase(first);
    closeOpenClawAgentDatabasesForTest();
    expect(originalDb.isOpen).toBe(false);
    const replacement = await fixture.getFreshManager(createConfig());
    expect(replacement).not.toBe(first);
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    expect(managerDatabase(replacement) === shared.db).toBe(true);
    await first.close();
    await replacement.sync({ reason: "test", force: true });
    expect((await replacement.search("Alpha")).length).toBeGreaterThan(0);
  });

  it("serves published hits while dirty maintenance setup meets a separate writer lock", async () => {
    const manager = await fixture.getFreshManager(createConfig());
    await manager.sync({ reason: "baseline", force: true });
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const writer = new DatabaseSync(shared.path);
    writer.exec("BEGIN IMMEDIATE");
    try {
      Reflect.set(manager, "dirty", true);
      const started = performance.now();
      const results = await manager.search("Alpha");
      expect(results.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
      await manager.close();
    }
  });

  it("preserves a newer source when archive cleanup waits for write admission", async () => {
    const sessionId = "archive-publication-race";
    await fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", timestamp: Date.now(), content: "Violet archived memory." }],
    });
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    await deleteSessionEntry({
      agentId: "main",
      sessionKey: `agent:main:memory:${sessionId}`,
      expectedSessionId: sessionId,
      archiveTranscript: true,
    });
    const archive = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
      (entry) => entry.sessionId === sessionId,
    );
    expect(archive?.artifactKind).toBe("archive-artifact");
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const writer = new DatabaseSync(shared.path);
    const livePath = sessionPathForSessionIdentity("main", sessionId);
    let releaseWriter: NodeJS.Timeout | undefined;
    try {
      await manager.sync({
        reason: "archive-cleanup",
        archiveFiles: [archive!.sessionFile],
        progress: ({ completed, total }) => {
          if (total > 0 && completed === total && !releaseWriter) {
            writer.exec("BEGIN IMMEDIATE");
            writer
              .prepare(
                "UPDATE memory_index_sources SET hash = 'newer-publication' WHERE source = 'sessions' AND path = ?",
              )
              .run(livePath);
            releaseWriter = setTimeout(() => writer.exec("COMMIT"), 100);
          }
        },
      });
      expect(releaseWriter).toBeDefined();
      expect(
        shared.db
          .prepare("SELECT hash FROM memory_index_sources WHERE source = 'sessions' AND path = ?")
          .get(livePath),
      ).toEqual({ hash: "newer-publication" });
    } finally {
      clearTimeout(releaseWriter);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      await manager.close();
    }
  });

  it("rebuilds a session snapshot after metadata refresh loses to schema invalidation", async () => {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    const transcript = path.join(
      sessionsDir,
      "metadata-race.jsonl.deleted.2026-09-01T00-00-00.000Z",
    );
    await fs.mkdir(sessionsDir, { recursive: true });
    const writeTranscript = (content: string) =>
      fs.writeFile(
        transcript,
        `${JSON.stringify({ type: "message", message: { role: "user", content } })}\n`,
      );
    await writeTranscript("Old violet history.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    const sourcePath = sessionPathForFile(transcript);
    const readSource = shared.db.prepare(
      "SELECT hash FROM memory_index_sources WHERE path = ? AND source = 'sessions'",
    );
    expect(readSource.get(sourcePath)).toBeDefined();
    // Legacy/imported chunks can await a later constructor's provenance reconciliation.
    shared.db
      .prepare(
        "DELETE FROM memory_index_chunk_provenance WHERE chunk_id IN (SELECT id FROM memory_index_chunks WHERE path = ? AND source = 'sessions')",
      )
      .run(sourcePath);
    Reflect.set(manager, "sessionsDirty", true);
    Reflect.set(manager, "sessionsDirtyFiles", new Set([transcript]));
    const writer = new DatabaseSync(shared.path);
    writer.exec("BEGIN IMMEDIATE");
    const admissionBlocked = createDeferred<void>();
    const exec = shared.db.exec.bind(shared.db);
    const observeAdmission = vi.spyOn(shared.db, "exec").mockImplementation((sql) => {
      try {
        return exec(sql);
      } catch (error) {
        admissionBlocked.resolve();
        throw error;
      }
    });
    const sync = manager.sync({ reason: "session-delta" });
    void sync.catch(() => undefined);
    try {
      await Promise.race([admissionBlocked.promise, sync]);
      ensureMemoryChunkProvenance(writer);
      await writeTranscript("Newest violet history.");
      writer.exec("COMMIT");
      const outcome = await sync.then(
        () => null,
        (error: unknown) => error,
      );
      expect(readSource.get(sourcePath)).toEqual({ hash: "" });
      expect(outcome).toBeInstanceOf(MemoryIndexRevisionConflictError);
      expect(manager.status().dirty).toBe(true);
      await manager.sync({ reason: "retry-metadata" });
      const indexed = shared.db
        .prepare("SELECT text FROM memory_index_chunks WHERE path = ? AND source = 'sessions'")
        .all(sourcePath)
        .map((row) => row.text)
        .join("\n");
      expect(indexed).toContain("Newest violet history.");
      expect(indexed).not.toContain("Old violet history.");
      expect(manager.status().dirty).toBe(false);
    } finally {
      observeAdmission.mockRestore();
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      await sync.catch(() => undefined);
      await manager.close();
    }
  });

  it.each([false, true])(
    "preserves a newer publication during rejected media cleanup (previously indexed: %s)",
    async (previouslyIndexed) => {
      const mediaDir = path.join(fixture.paths.workspace, "media-memory");
      const imagePath = path.join(mediaDir, "diagram.png");
      const sourcePath = "media-memory/diagram.png";
      await fs.mkdir(mediaDir, { recursive: true });
      if (previouslyIndexed) {
        await fs.writeFile(imagePath, Buffer.from("png"));
      }
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: "gemini",
          model: "gemini-embedding-2-preview",
          vectorEnabled: false,
          extraPaths: [mediaDir],
          multimodal: { enabled: true, modalities: ["image"], maxFileBytes: 128 },
        }),
        "cli",
      );
      await manager.sync({ reason: "baseline", force: true });
      await fs.writeFile(imagePath, Buffer.from("changed png"));
      Reflect.set(manager, "dirty", true);
      const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
      const readSource = shared.db.prepare(
        "SELECT hash FROM memory_index_sources WHERE path = ? AND source = 'memory'",
      );
      expect(readSource.get(sourcePath) !== undefined).toBe(previouslyIndexed);
      const writer = new DatabaseSync(shared.path);
      let releaseWriter: NodeJS.Timeout | undefined;
      try {
        await manager.sync({
          reason: "watch",
          progress: ({ label }) => {
            if (label?.startsWith("Indexing memory files") && !releaseWriter) {
              unlinkSync(imagePath);
              writer.exec("BEGIN IMMEDIATE");
              writer
                .prepare(
                  "INSERT INTO memory_index_sources(path, source, hash, mtime, size) VALUES (?, 'memory', 'newer-media-publication', 1, 1) ON CONFLICT(path, source) DO UPDATE SET hash = excluded.hash",
                )
                .run(sourcePath);
              releaseWriter = setTimeout(() => writer.exec("COMMIT"), 100);
            }
          },
        });
        expect(releaseWriter).toBeDefined();
        expect(readSource.get(sourcePath)).toEqual({ hash: "newer-media-publication" });
      } finally {
        clearTimeout(releaseWriter);
        if (writer.isTransaction) {
          writer.exec("ROLLBACK");
        }
        writer.close();
        await manager.close();
      }
    },
  );

  it.each([
    "watched-file",
    "deleted-memory",
    "deleted-session",
    "session-fingerprint",
    "cache-prune",
  ])("keeps searches and timers responsive during contended %s maintenance", async (scenario) => {
    const sessionWork = scenario === "deleted-session" || scenario === "session-fingerprint";
    const sessionId = "maintenance-session";
    if (sessionWork) {
      await fixture.seedSessionTranscript({
        sessionId,
        messages: [{ role: "user", timestamp: Date.now(), content: "Violet session content." }],
      });
    }
    const cfg = fixture.createConfig({
      provider: "none",
      vectorEnabled: false,
      sources: sessionWork ? ["memory", "sessions"] : ["memory"],
      sessionMemory: sessionWork,
    });
    const manager = await fixture.getFreshManager(cfg, "cli");
    const changedPath = path.join(fixture.paths.memory, "updated.md");
    await fs.writeFile(changedPath, "Updated violet memory.");
    await manager.sync({ reason: "baseline", force: true });
    const reader = await fixture.getFreshManager(cfg, "cli");
    await reader.search("Alpha");
    const shared = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    if (scenario === "deleted-memory") {
      await fs.unlink(changedPath);
      shared.db
        .prepare(
          "INSERT INTO memory_index_chunks_fts(text, id, path, source, model, start_line, end_line) VALUES ('old-model violet', 'old-model', 'memory/updated.md', 'memory', 'old-model', 1, 1)",
        )
        .run();
      shared.db
        .prepare(
          "INSERT INTO memory_index_chunks_fts(text, id, path, source, model, start_line, end_line) VALUES ('other-source', 'other-source', 'memory/updated.md', 'sessions', 'old-model', 1, 1)",
        )
        .run();
    } else if (scenario === "watched-file") {
      await fs.writeFile(changedPath, "Refreshed violet memory.");
    }
    if (scenario === "cache-prune") {
      const owner = manager as unknown as { cache: { maxEntries: number } };
      owner.cache.maxEntries = 2;
      const insert = shared.db.prepare(
        "INSERT INTO memory_embedding_cache(provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ('fixture', 'fixture', 'fixture', ?, '[1]', 1, ?)",
      );
      for (let index = 0; index < 331; index += 1) {
        insert.run(`cache-${index}`, index);
      }
    }
    if (sessionWork) {
      const session = (await listSessionTranscriptCorpusEntriesForAgent("main")).find(
        (entry) => entry.sessionId === sessionId,
      );
      expect(session).toBeDefined();
      Reflect.set(manager, "sessionsDirty", true);
      if (scenario === "deleted-session") {
        recordMemorySessionTombstones({ agentId: "main", sessionIds: [sessionId] });
        Reflect.set(manager, "sessionsReconcileDirty", true);
      } else {
        shared.db
          .prepare("UPDATE memory_index_sources SET mtime = 0, size = 0 WHERE source = 'sessions'")
          .run();
        Reflect.set(manager, "sessionsDirtyFiles", new Set([session!.sessionFile]));
      }
    } else if (scenario !== "cache-prune") {
      Reflect.set(manager, "dirty", true);
    }
    const writer = new DatabaseSync(shared.path);
    writer.exec("BEGIN IMMEDIATE");
    const started = performance.now();
    const observedCacheCounts = new Set<number>();
    let observeCacheTimer: NodeJS.Immediate | undefined;
    const observeCache = () => {
      observedCacheCounts.add(
        Number(
          shared.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get()?.count,
        ),
      );
      observeCacheTimer = setImmediate(observeCache);
    };
    const releaseWriter = setTimeout(() => {
      writer.exec("ROLLBACK");
      if (scenario === "cache-prune") {
        observeCache();
      }
    }, 100);
    const sync = manager.sync({ reason: sessionWork ? "session-delta" : "watch" });
    try {
      const [results] = await Promise.all([reader.search("Alpha"), sync]);
      expect(results.some((result) => result.path === "memory/2026-01-12.md")).toBe(true);
      expect(performance.now() - started).toBeLessThan(1000);
      if (scenario === "deleted-memory") {
        expect(
          shared.db
            .prepare(
              "SELECT model FROM memory_index_chunks_fts WHERE path = 'memory/updated.md' ORDER BY source",
            )
            .all(),
        ).toEqual([{ model: "old-model" }]);
        expect(
          (await reader.search("violet", { sources: ["memory"] })).some(
            (result) => result.path === "memory/updated.md",
          ),
        ).toBe(false);
      } else if (scenario === "deleted-session") {
        expect(
          shared.db
            .prepare("SELECT path FROM memory_index_sources WHERE source = 'sessions'")
            .all(),
        ).toEqual([]);
        expect(
          shared.db.prepare("SELECT text FROM memory_index_chunks WHERE source = 'sessions'").all(),
        ).toEqual([]);
      } else if (scenario === "session-fingerprint") {
        expect(
          shared.db
            .prepare(
              "SELECT mtime > 0 AS refreshed FROM memory_index_sources WHERE source = 'sessions'",
            )
            .get(),
        ).toEqual({ refreshed: 1 });
      } else if (scenario === "cache-prune") {
        expect(
          shared.db.prepare("SELECT hash FROM memory_embedding_cache ORDER BY updated_at").all(),
        ).toEqual([{ hash: "cache-329" }, { hash: "cache-330" }]);
        expect([...observedCacheCounts].some((count) => count > 2 && count < 331)).toBe(true);
      } else {
        expect(
          (await reader.search("violet")).some((result) => result.snippet.includes("Refreshed")),
        ).toBe(true);
      }
    } finally {
      clearTimeout(releaseWriter);
      clearImmediate(observeCacheTimer);
      if (writer.isTransaction) {
        writer.exec("ROLLBACK");
      }
      writer.close();
      await sync.catch(() => undefined);
      await manager.close();
    }
  });
});
