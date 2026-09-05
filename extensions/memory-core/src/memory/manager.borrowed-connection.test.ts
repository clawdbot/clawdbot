import { DatabaseSync } from "node:sqlite";
import { loadSqliteVecExtension } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
