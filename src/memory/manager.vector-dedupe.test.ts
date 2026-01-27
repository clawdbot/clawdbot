import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMemorySearchManager, type MemoryIndexManager } from "./index.js";
import { buildFileEntry } from "./internal.js";

vi.mock("./embeddings.js", () => {
  return {
    createEmbeddingProvider: async () => ({
      requestedProvider: "openai",
      provider: {
        id: "mock",
        model: "mock-embed",
        embedQuery: async () => [0.1, 0.2, 0.3],
        embedBatch: async (texts: string[]) => texts.map((_, index) => [index + 1, 0, 0]),
      },
    }),
  };
});

describe("memory vector dedupe", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello memory.");
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("deletes existing vector rows before inserting replacements", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: true } },
            sync: { watch: false, onSessionStart: false, onSearch: false },
            cache: { enabled: false },
          },
        },
        list: [{ id: "main", default: true }],
      },
    };

    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    expect(result.manager).not.toBeNull();
    if (!result.manager) throw new Error("manager missing");
    manager = result.manager;

    const db = (
      manager as unknown as {
        db: { exec: (sql: string) => void; prepare: (sql: string) => unknown };
      }
    ).db;
    db.exec("CREATE TABLE IF NOT EXISTS chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");

    const sqlSeen: string[] = [];
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => {
      if (sql.includes("chunks_vec")) {
        sqlSeen.push(sql);
      }
      return originalPrepare(sql);
    };

    (
      manager as unknown as { ensureVectorReady: (dims?: number) => Promise<boolean> }
    ).ensureVectorReady = async () => true;

    const entry = await buildFileEntry(path.join(workspaceDir, "MEMORY.md"), workspaceDir);
    await (
      manager as unknown as {
        indexFile: (entry: unknown, options: { source: "memory" }) => Promise<void>;
      }
    ).indexFile(entry, { source: "memory" });

    const deleteIndex = sqlSeen.findIndex((sql) =>
      sql.includes("DELETE FROM chunks_vec WHERE id = ?"),
    );
    const insertIndex = sqlSeen.findIndex((sql) => sql.includes("INSERT INTO chunks_vec"));
    expect(deleteIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(-1);
    expect(deleteIndex).toBeLessThan(insertIndex);
  });
});
