// Fast-path status must report the vector store as available when indexed
// chunks exist, even though lazy vector init has not run (#92102).
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
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

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager fast-path vector store availability (#92102)", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let managers: MemoryIndexManager[] = [];

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-status-92102-"));
  });

  beforeEach(async () => {
    createEmbeddingProviderMock.mockClear();
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    for (const activeManager of managers.toReversed()) {
      await activeManager.close();
    }
    managers = [];
    await closeAllMemorySearchManagers();
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function createManager(params: { vectorEnabled?: boolean; purpose?: "status" } = {}) {
    const store =
      params.vectorEnabled === undefined
        ? undefined
        : { vector: { enabled: params.vectorEnabled } };
    const cfg = isolateMemoryManagerTestConfig({
      memory: {
        backend: "builtin",
        search: {
          provider: "auto",
          model: "",
          store,
          cache: { enabled: false },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      agents: {
        defaults: { workspace: workspaceDir },
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

  async function seedChunk(id: string): Promise<void> {
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    const db = new DatabaseSync(indexPath);
    db.exec(`
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
      INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('${id}', 'MEMORY.md', 'memory', 1, 3, 'hash-1', 'fts-only', 'Alpha topic', '[]', ${Date.now()});
    `);
    db.close();
  }

  it("reports vector store available from indexed chunks on the fast status path", async () => {
    await seedChunk("chunk-1");
    const memoryManager = await createManager({ vectorEnabled: true, purpose: "status" });

    const status = memoryManager.status();
    expect(status.vector.storeAvailable).toBe(true);
  });

  it("reports unknown when no indexed chunks exist", async () => {
    const memoryManager = await createManager({ vectorEnabled: true, purpose: "status" });

    const status = memoryManager.status();
    expect(status.vector.storeAvailable).toBeUndefined();
  });
});
