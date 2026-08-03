import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";

// Regression coverage for #92102 lives in its own small file so the memory-core
// vitest shard does not have to transform the full index.test.ts graph to run it.

describe("memory manager vector store status (#92102)", () => {
  let fixtureRoot = "";
  let workspaceDir = "";

  beforeEach(async () => {
    resetEmbeddingMocks();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-vector-status-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
  });

  afterEach(async () => {
    const { closeAllMemorySearchManagers } = await import("./index.js");
    await closeAllMemorySearchManagers();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  async function openManager(): Promise<MemoryIndexManager> {
    const cfg: OpenClawConfig = {
      memory: {
        backend: "builtin",
        search: {
          provider: "none",
          model: "mock-embed",
          store: { vector: { enabled: true } },
          cache: { enabled: false },
        },
      },
      agents: {
        defaults: { workspace: workspaceDir },
        list: [{ id: "main", default: true }],
      },
    };
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    return result.manager as unknown as MemoryIndexManager;
  }

  it("reports vector store ready from persisted semantic chunks on the unprobed fast path", async () => {
    const manager = await openManager();
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const vector = Reflect.get(manager, "vector") as { available: boolean | null };

    // The CLI status fast path never live-probes sqlite-vec, so vector.available
    // stays null (the lazy-init default set in the constructor).
    vector.available = null;

    // No persisted chunks yet -> still unknown (undefined); the fix does not
    // fabricate readiness when nothing has been indexed.
    expect(manager.status().vector?.storeAvailable).toBeUndefined();

    // Persist a real semantic (non-fts-only) chunk as a prior indexing would.
    db.exec(
      `INSERT INTO memory_index_chunks
         (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES
         ('chunk-1', 'memory/2026-01-12.md', 'memory', 1, 2, 'h1',
          'mock-embed', 'semantic chunk body', '[]', 0)`,
    );

    // Unprobed fast path now reports ready, mirroring --deep, instead of the
    // misleading "unknown" that made operators think vector search was down.
    expect(manager.status().vector?.storeAvailable).toBe(true);

    // fts-only chunks are not semantic vectors and must not count as ready.
    db.exec(
      `DELETE FROM memory_index_chunks;
       INSERT INTO memory_index_chunks
         (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES
         ('chunk-fts', 'memory/2026-01-12.md', 'memory', 1, 2, 'h2',
          'fts-only', 'fts only body', '[]', 0)`,
    );
    vector.available = null;
    expect(manager.status().vector?.storeAvailable).toBeUndefined();
  });
});
