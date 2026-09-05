import { DatabaseSync } from "node:sqlite";
import { MEMORY_CHUNKING_VERSION } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search after a chunking upgrade", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  function createConfig(onSearch: boolean, onSessionStart: boolean, model = "mock-embed") {
    const cfg = fixture.createConfig({ onSearch, model, vectorEnabled: false });
    const search = cfg.memory?.search;
    if (!search) {
      throw new Error("fixture memory search configuration is missing");
    }
    search.sync = { ...search.sync, onSearch, onSessionStart, watch: false, intervalMinutes: 0 };
    return cfg;
  }

  function withDatabase<T>(dbPath: string, run: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(dbPath);
    try {
      return run(db);
    } finally {
      db.close();
    }
  }

  function readMeta(db: DatabaseSync): MemoryIndexMeta {
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get();
    if (typeof row?.value !== "string") {
      throw new Error("fixture index metadata is missing");
    }
    return JSON.parse(row.value) as MemoryIndexMeta;
  }

  async function seedIndex(
    cfg: ReturnType<typeof createConfig>,
    oldChunkingVersion = true,
  ): Promise<string> {
    const manager = await fixture.getFreshManager(cfg);
    await manager.sync({ reason: "test", force: true });
    const dbPath = manager.status().dbPath;
    if (!dbPath) {
      throw new Error("fixture database path is missing");
    }
    await manager.close();
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    if (oldChunkingVersion) {
      // Keep real indexed files unchanged, but reopen the publication as an older runtime's index.
      withDatabase(dbPath, (db) => {
        const meta = readMeta(db);
        db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
          JSON.stringify({ ...meta, chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }),
        );
      });
    }
    return dbPath;
  }

  it.each([
    { mode: "search sync", onSearch: true, onSessionStart: false, purpose: "default" },
    { mode: "session-start sync", onSearch: false, onSessionStart: true, purpose: "default" },
    { mode: "CLI search", onSearch: true, onSessionStart: false, purpose: "cli" },
  ] as const)("rebuilds unchanged prior-version content through $mode", async (settings) => {
    const cfg = createConfig(settings.onSearch, settings.onSessionStart);
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg, settings.purpose);

    const results = await manager.search("alpha", { lexicalOnly: true });

    expect(results).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION);
  });

  it("preserves the upgrade mismatch when automatic search sync is disabled", async () => {
    const cfg = createConfig(false, false);
    const dbPath = await seedIndex(cfg);
    const manager = await fixture.getFreshManager(cfg);

    await expect(manager.search("alpha", { lexicalOnly: true })).resolves.toEqual([]);
    expect(manager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
      code: "chunking_version",
      owner: "openclaw",
    });
    expect(withDatabase(dbPath, readMeta).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION - 1);
  });

  it("preserves configuration-only mismatch behavior", async () => {
    await seedIndex(createConfig(true, false, "old-model"), false);
    const manager = await fixture.getFreshManager(createConfig(true, false, "new-model"));

    await expect(manager.search("alpha", { lexicalOnly: true })).resolves.toEqual([]);
    expect(manager.status().custom?.indexIdentity).toMatchObject({
      status: "mismatched",
      code: "model",
      owner: "configuration",
    });
  });

  it("uses current configured settings when an eligible upgrade rebuild runs", async () => {
    const dbPath = await seedIndex(createConfig(true, false, "old-model"));
    const manager = await fixture.getFreshManager(createConfig(true, false, "new-model"));

    expect(await manager.search("alpha", { lexicalOnly: true })).not.toEqual([]);
    expect(withDatabase(dbPath, readMeta)).toMatchObject({
      chunkingVersion: MEMORY_CHUNKING_VERSION,
      model: "new-model",
    });
  });
});
