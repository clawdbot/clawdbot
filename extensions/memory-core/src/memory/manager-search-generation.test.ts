import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import * as knnSubprocess from "./manager-search-knn-subprocess.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory search generation", () => {
  const { createConfig: createCfg, getPersistentManager } = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

  it("keeps one search generation while a concurrent reindex waits to publish", async ({
    signal,
  }) => {
    const manager = await getPersistentManager(
      createCfg({
        vectorEnabled: true,
        minScore: 0,
      }),
    );
    await manager.sync({ reason: "test" });
    const fields = manager as unknown as {
      db: DatabaseSync;
      provider: EmbeddingProvider;
      syncMemoryFiles: (params: { needsFullReindex: boolean }) => Promise<unknown>;
    };
    const queryStarted = createDeferred<void>();
    const releaseQuery = createDeferred<void>();
    const shadowReady = createDeferred<void>();
    const releaseReindex = createDeferred<void>();
    const childReady = createDeferred<void>();
    const releaseChild = createDeferred<void>();
    const publishedDb = fields.db;
    const publishedChunks = manager.status().chunks;
    let shadowDb: DatabaseSync | undefined;
    const syncMemoryFiles = fields.syncMemoryFiles.bind(manager);
    const runKnn = knnSubprocess.runVectorKnnInSubprocess;
    const querySpy = vi.spyOn(fields.provider, "embed").mockImplementation(async () => {
      queryStarted.resolve();
      await releaseQuery.promise;
      return [1, 0, 0, 0];
    });
    const syncSpy = vi.spyOn(fields, "syncMemoryFiles").mockImplementation(async (params) => {
      shadowDb = fields.db;
      expect(manager.status().chunks).toBe(publishedChunks);
      const lexical = await manager.search("zebra", { lexicalOnly: true, minScore: 0 });
      expect(lexical.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      const result = await syncMemoryFiles(params);
      shadowReady.resolve();
      await releaseReindex.promise;
      return result;
    });
    const childSpy = vi
      .spyOn(knnSubprocess, "runVectorKnnInSubprocess")
      .mockImplementation(async (params) => {
        try {
          const result = await runKnn(params);
          expect(result.rows.length).toBeGreaterThan(0);
          childReady.resolve();
          await releaseChild.promise;
          return result;
        } catch (error) {
          childReady.reject(error);
          throw error;
        }
      });
    let search: ReturnType<typeof manager.search> | undefined;
    let reindex: ReturnType<typeof manager.sync> | undefined;
    const aborted = createDeferred<never>();
    const releaseGates = () => {
      releaseQuery.resolve();
      releaseReindex.resolve();
      releaseChild.resolve();
    };
    const abort = () => {
      releaseGates();
      aborted.reject(signal.reason);
    };
    const waitForSignal = async (
      ready: Promise<void>,
      operation: Promise<unknown>,
      phase: string,
    ) => {
      await Promise.race([
        ready,
        aborted.promise,
        operation.then(() => {
          throw new Error(`Operation completed before ${phase}`);
        }),
      ]);
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      search = manager.search("semantic needle without lexical overlap", { signal });
      await waitForSignal(queryStarted.promise, search, "query embedding started");
      reindex = manager.sync({ reason: "test", force: true });
      await waitForSignal(shadowReady.promise, reindex, "shadow index ready");
      expect(fields.db).toBe(publishedDb);
      releaseQuery.resolve();
      await waitForSignal(childReady.promise, search, "KNN child ready");
      releaseReindex.resolve();
      let reindexSettled = false;
      void reindex.then(() => {
        reindexSettled = true;
      });
      await Promise.resolve();
      expect(reindexSettled).toBe(false);

      releaseChild.resolve();
      const results = await search;
      expect(results.some((entry) => entry.path === "memory/2026-01-12.md")).toBe(true);
      await reindex;
      expect(shadowDb?.isOpen).toBe(false);
    } finally {
      signal.removeEventListener("abort", abort);
      releaseGates();
      await Promise.allSettled([search, reindex]);
      childSpy.mockRestore();
      syncSpy.mockRestore();
      querySpy.mockRestore();
    }
  });
});
