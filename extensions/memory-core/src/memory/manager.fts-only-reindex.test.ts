import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available.",
  }),
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

type MemoryIndexModule = typeof import("./index.js");

describe("memory manager FTS-only reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let manager: MemoryIndexManager | null = null;
  let getMemorySearchManager: MemoryIndexModule["getMemorySearchManager"];
  let closeAllMemorySearchManagers: MemoryIndexModule["closeAllMemorySearchManagers"];

  beforeAll(async () => {
    vi.resetModules();
    ({ getMemorySearchManager, closeAllMemorySearchManagers } = await import("./index.js"));
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
  });

  beforeEach(async () => {
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
    indexPath = path.join(workspaceDir, "index.sqlite");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await closeAllMemorySearchManagers();
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      vi.resetModules();
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    vi.resetModules();
  });

  async function createManager(): Promise<MemoryIndexManager> {
    const cfg = {
      memory: {
        backend: "builtin",
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "auto",
            model: "",
            store: { path: indexPath },
            cache: { enabled: false },
            sync: { watch: false, onSessionStart: false, onSearch: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  function countChunksContaining(term: string): number {
    const db = new DatabaseSync(indexPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM chunks WHERE text LIKE ?`)
        .get(`%${term}%`) as { c: number } | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  it("preserves indexed chunks across forced reindex in FTS-only mode", async () => {
    const memoryManager = await createManager();

    await memoryManager.sync({ force: true });
    const firstStatus = memoryManager.status();
    expect(firstStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);

    await memoryManager.sync({ force: true });
    const secondStatus = memoryManager.status();
    expect(secondStatus.chunks).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("refreshes FTS-only indexed content after memory file updates", async () => {
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Beta refresh marker\n\nUpdated memory content.",
    );
    await memoryManager.sync({ force: true });

    expect(countChunksContaining("refresh marker")).toBeGreaterThan(0);
    expect(countChunksContaining("Alpha topic")).toBe(0);
  });
});
