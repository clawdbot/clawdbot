import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";
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
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager self-heal missing identity with FTS-only chunks", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
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
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    resetPluginStateStoreForTests();
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
    const cfg = isolateMemoryManagerTestConfig({
      memory: {
        backend: "builtin",
        search: {
          provider: params.provider ?? "auto",
          model: "",
          store,
          cache: { enabled: false },
        },
      },
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig);
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

  function seedChunksWithNoMeta(model = "fts-only"): void {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec(`
      INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 3, 'hash-1', '${model}', 'Alpha topic keep note', '[]', ${Date.now()});
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'hash-1', ${Date.now()}, 100);
    `);
  }

  it("self-heals missing identity on non-forced gateway sync when all chunks are FTS-only and provider is unavailable", async () => {
    seedChunksWithNoMeta();
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
    seedChunksWithNoMeta("text-embedding-3-small");
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
