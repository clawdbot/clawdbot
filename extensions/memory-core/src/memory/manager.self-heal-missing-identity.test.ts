import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

const createEmbeddingProviderMock = vi.hoisted(() =>
  vi.fn(async () => ({
    requestedProvider: "auto",
    provider: null,
    providerUnavailableReason: "No embeddings provider available.",
  })),
);
const originalSelfHealStateDir = process.env.OPENCLAW_STATE_DIR;

function setSelfHealStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreSelfHealStateDir(): void {
  if (originalSelfHealStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalSelfHealStateDir);
  }
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager self-heal missing identity with FTS-only chunks", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let managers: MemoryIndexManager[] = [];

  function indexIdentityStatus(memoryManager: MemoryIndexManager): string | undefined {
    const identity = memoryManager.status().custom?.indexIdentity as
      | { status?: string }
      | undefined;
    return identity?.status;
  }

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-self-heal-91167-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
    setSelfHealStateDir(path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    for (const activeManager of managers.toReversed()) {
      await activeManager.close();
    }
    managers = [];
    await closeAllMemorySearchManagers();
    restoreSelfHealStateDir();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(
    params: {
      provider?: string;
      vectorEnabled?: boolean;
      purpose?: "default" | "status" | "cli";
    } = {},
  ): Promise<MemoryIndexManager> {
    const store =
      params.vectorEnabled === undefined
        ? undefined
        : { vector: { enabled: params.vectorEnabled } };
    const cfg = {
      memory: {
        backend: "builtin",
        search: {
          provider: params.provider ?? "auto",
          model: "",
          store,
          cache: { enabled: false },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({
      cfg,
      agentId: "main",
      purpose: params.purpose,
    });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    const activeManager = result.manager as unknown as MemoryIndexManager;
    managers.push(activeManager);
    return activeManager;
  }

  async function seedChunksWithNoMeta(model = "fts-only"): Promise<void> {
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const db = new DatabaseSync(indexPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memory_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memory_index_chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_index_sources (
        path TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'memory',
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL,
        PRIMARY KEY (path, source)
      );
      INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 3, 'hash-1', '${model}', 'Alpha topic keep note', '[]', ${Date.now()});
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'hash-1', ${Date.now()}, 100);
    `);
    db.close();
  }

  it("self-heals missing identity on non-forced gateway sync when all chunks are FTS-only and provider is unavailable", async () => {
    await seedChunksWithNoMeta();
    const memoryManager = await createManager({ vectorEnabled: false });

    expect(indexIdentityStatus(memoryManager)).toBe("missing");

    // Non-forced sync simulates the gateway's periodic sync loop
    await memoryManager.sync();

    const statusAfter = memoryManager.status();
    expect(indexIdentityStatus(memoryManager)).toBe("valid");
    expect(statusAfter.chunks).toBeGreaterThan(0);
    expect(statusAfter.dirty).toBe(false);
  });

  it("does not rebuild missing-identity semantic chunks when the provider is unavailable", async () => {
    await seedChunksWithNoMeta("text-embedding-3-small");
    const memoryManager = await createManager({ vectorEnabled: false });

    await memoryManager.sync();

    const statusAfter = memoryManager.status();
    expect(indexIdentityStatus(memoryManager)).toBe("missing");
    expect(statusAfter.chunks).toBe(1);
    expect(statusAfter.dirty).toBe(true);
  });

  it("observes a separate CLI reindex without reopening the live gateway manager", async () => {
    const liveManager = await createManager({ provider: "none", vectorEnabled: false });
    await liveManager.sync({ reason: "test", force: true });
    (
      liveManager as unknown as {
        db: { exec: (sql: string) => void };
      }
    ).db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`);
    expect(indexIdentityStatus(liveManager)).toBe("missing");

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Beta topic\n\nKeep this repaired note.",
    );
    const cliManager = await createManager({
      provider: "none",
      vectorEnabled: false,
      purpose: "cli",
    });
    await cliManager.sync({ reason: "cli", force: true });

    expect(indexIdentityStatus(liveManager)).toBe("valid");
    const results = await liveManager.search("beta repaired");
    expect(results.some((result) => result.snippet.includes("Beta topic"))).toBe(true);
  });
});
