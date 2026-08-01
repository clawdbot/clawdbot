import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";
import "./test-runtime-mocks.js";

const originalStateDir = process.env.OPENCLAW_STATE_DIR;

describe("memory manager vector status", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let caseId = 0;
  let managers: MemoryIndexManager[] = [];

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-memory-vector-status-"));
  });

  beforeEach(async () => {
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
  });

  afterEach(async () => {
    for (const manager of managers.toReversed()) {
      await manager.close();
    }
    managers = [];
    await closeAllMemorySearchManagers();
    if (originalStateDir === undefined) {
      Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
    } else {
      Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalStateDir);
    }
  });

  afterAll(async () => {
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function createStatusManager(): Promise<MemoryIndexManager> {
    const cfg = isolateMemoryManagerTestConfig({
      memory: {
        backend: "builtin",
        search: {
          provider: "auto",
          model: "",
          store: { vector: { enabled: true } },
          cache: { enabled: false },
          sync: { watch: false, onSessionStart: false, onSearch: false },
        },
      },
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig);
    const result = await getMemorySearchManager({ cfg, agentId: "main", purpose: "status" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managers.push(manager);
    return manager;
  }

  it("exposes persisted vector metadata without claiming live store readiness", async () => {
    const seedManager = await createStatusManager();
    (seedManager as unknown as { writeMeta(meta: MemoryIndexMeta): void }).writeMeta({
      provider: "gemini",
      model: "gemini-embed",
      chunkTokens: 512,
      chunkOverlap: 64,
      vectorDims: 4,
    });

    const statusManager = await createStatusManager();

    expect(Reflect.get(statusManager, "vector")).toMatchObject({ available: null, dims: 4 });
    expect(statusManager.status().vector).toMatchObject({
      enabled: true,
      dims: 4,
      storeAvailable: undefined,
    });
  });

  it("does not infer vector readiness from chunks without vector metadata", async () => {
    const seedManager = await createStatusManager();
    const db = Reflect.get(seedManager, "db") as DatabaseSync;
    db.prepare(
      `INSERT INTO memory_index_chunks
       (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "fts-only-chunk",
      "MEMORY.md",
      "memory",
      1,
      1,
      "fts-only-hash",
      "fts-only",
      "indexed text without semantic vectors",
      "[]",
      Date.now(),
    );

    const status = (await createStatusManager()).status();

    expect(status.chunks).toBeGreaterThan(0);
    expect(status.vector?.storeAvailable).toBeUndefined();
    expect(status.vector?.dims).toBeUndefined();
  });
});
