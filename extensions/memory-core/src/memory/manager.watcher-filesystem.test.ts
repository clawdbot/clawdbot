import { AsyncLocalStorage } from "node:async_hooks";
import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_INDEX_CHUNKS_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

function activeFilesystemWatchers() {
  return process.getActiveResourcesInfo().filter((resource) => resource === "FSEventWrap").length;
}

describe("memory watchers on the real filesystem", () => {
  it.each(["EMFILE", "ENFILE", "ENOSPC"] as const)(
    "keeps search fresh through Chokidar polling after native watch reports %s",
    async (code) => {
      const state = await createOpenClawTestState({ label: "memory-watch-capacity" });
      const memoryDir = path.join(state.workspaceDir, "memory");
      await fs.mkdir(memoryDir);
      await fs.writeFile(path.join(memoryDir, "before.md"), "Quartz sentinel.");
      const originalWatch = nativeFs.watch;
      const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        if (path.resolve(String(args[0])) === memoryDir) {
          throw Object.assign(new Error(`${code}: native watcher capacity exhausted`), { code });
        }
        return originalWatch(...args);
      });
      syncBuiltinESMExports();
      let manager: MemoryIndexManager | null = null;
      let index: DatabaseSync | undefined;
      try {
        await configureMemoryCoreDreamingStateForTests(state.env);
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: "main" }] },
          memory: {
            search: {
              provider: "none",
              sources: ["memory"],
              store: { vector: { enabled: false } },
              query: { minScore: 0 },
            },
          },
        };
        manager = await MemoryIndexManager.get({ cfg, agentId: "main" });
        if (!manager) {
          throw new Error("memory manager unavailable");
        }
        await manager.sync({ reason: "test-initial-index" });
        const indexPath = manager.status().dbPath;
        if (!indexPath) {
          throw new Error("memory index path unavailable");
        }
        index = new DatabaseSync(indexPath, { readOnly: true });
        const indexedRows = index.prepare(
          `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
        );
        expect(indexedRows.all()).toEqual([{ path: "memory/before.md", text: "Quartz sentinel." }]);

        await fs.writeFile(path.join(memoryDir, "after.md"), "Topaz sentinel.");

        await expect
          .poll(() => indexedRows.all(), { timeout: 15_000 })
          .toEqual([
            { path: "memory/after.md", text: "Topaz sentinel." },
            { path: "memory/before.md", text: "Quartz sentinel." },
          ]);
      } finally {
        index?.close();
        await manager?.close();
        watchObserver.mockRestore();
        syncBuiltinESMExports();
        resetMemoryCoreDreamingStateForTests();
        await state.cleanup();
      }
    },
    60_000,
  );

  it("keeps search fresh when an active native watcher exhausts capacity", async () => {
    const state = await createOpenClawTestState({ label: "memory-watch-runtime-capacity" });
    const memoryDir = path.join(state.workspaceDir, "memory");
    await fs.mkdir(memoryDir);
    await fs.writeFile(path.join(memoryDir, "before.md"), "Quartz sentinel.");
    const originalWatch = nativeFs.watch;
    let memoryWatcher: nativeFs.FSWatcher | undefined;
    const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
      const watcher = originalWatch(...args);
      if (path.resolve(String(args[0])) === memoryDir) {
        memoryWatcher = watcher;
      }
      return watcher;
    });
    syncBuiltinESMExports();
    let manager: MemoryIndexManager | null = null;
    let restoreSyncSpy: (() => void) | undefined;
    let index: DatabaseSync | undefined;
    try {
      await configureMemoryCoreDreamingStateForTests(state.env);
      const cfg: OpenClawConfig = {
        plugins: { enabled: false },
        agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: "main" }] },
        memory: {
          search: {
            provider: "none",
            sources: ["memory"],
            store: { vector: { enabled: false } },
            query: { minScore: 0 },
          },
        },
      };
      manager = await MemoryIndexManager.get({ cfg, agentId: "main" });
      if (!manager || !memoryWatcher) {
        throw new Error("memory manager native watcher unavailable");
      }
      await manager.sync({ reason: "test-initial-index" });
      const indexPath = manager.status().dbPath;
      if (!indexPath) {
        throw new Error("memory index path unavailable");
      }
      index = new DatabaseSync(indexPath, { readOnly: true });
      const indexedRows = index.prepare(
        `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
      );
      expect(indexedRows.all()).toEqual([{ path: "memory/before.md", text: "Quartz sentinel." }]);

      const originalSync = manager.sync.bind(manager);
      let watchSyncCount = 0;
      let resolveRecoverySync = () => {};
      const recoverySyncCompleted = new Promise<void>((resolve) => {
        resolveRecoverySync = resolve;
      });
      const syncMethodSpy = vi.spyOn(manager, "sync").mockImplementation(async (params) => {
        await originalSync(params);
        if (params?.reason === "watch" && ++watchSyncCount === 1) {
          resolveRecoverySync();
        }
      });
      restoreSyncSpy = () => syncMethodSpy.mockRestore();

      memoryWatcher.emit(
        "error",
        Object.assign(new Error("ENOSPC: native watcher capacity exhausted"), {
          code: "ENOSPC",
        }),
      );
      await recoverySyncCompleted;
      expect(indexedRows.all()).toEqual([{ path: "memory/before.md", text: "Quartz sentinel." }]);

      await fs.writeFile(path.join(memoryDir, "after.md"), "Topaz sentinel.");

      await expect
        .poll(() => indexedRows.all(), { timeout: 15_000 })
        .toEqual([
          { path: "memory/after.md", text: "Topaz sentinel." },
          { path: "memory/before.md", text: "Quartz sentinel." },
        ]);
    } finally {
      restoreSyncSpy?.();
      index?.close();
      await manager?.close();
      watchObserver.mockRestore();
      syncBuiltinESMExports();
      resetMemoryCoreDreamingStateForTests();
      await state.cleanup();
    }
  }, 60_000);

  it.each(["replacement", "removal"] as const)(
    "keeps search fresh after root %s and releases watchers on close",
    async (operation) => {
      const state = await createOpenClawTestState({ label: "memory-watch-filesystem" });
      const initialWatchers = activeFilesystemWatchers();
      const turnContext = new AsyncLocalStorage<string>();
      const pendingInputContext = new AsyncLocalStorage<string>();
      const watcherContexts: Array<{ turn?: string; pendingInput?: string }> = [];
      const timerContexts: typeof watcherContexts = [];
      const originalWatch = nativeFs.watch;
      const watchObserver = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        watcherContexts.push({
          turn: turnContext.getStore(),
          pendingInput: pendingInputContext.getStore(),
        });
        return originalWatch(...args);
      });
      syncBuiltinESMExports();
      const originalSetTimeout = globalThis.setTimeout;
      const timerObserver = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
        // Observe the real startup pressure check and filesystem debounce timers.
        if (args[1] === 10_000 || args[1] === 1500) {
          timerContexts.push({
            turn: turnContext.getStore(),
            pendingInput: pendingInputContext.getStore(),
          });
        }
        return originalSetTimeout(...args);
      });
      let manager: MemoryIndexManager | null = null;
      let index: DatabaseSync | undefined;
      try {
        await configureMemoryCoreDreamingStateForTests(state.env);
        const memoryDir = path.join(state.workspaceDir, "memory");
        await fs.mkdir(memoryDir);
        // Preserve an indexed file while the watched root is absent.
        await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), "Evergreen sentinel.");
        await fs.writeFile(path.join(memoryDir, "old.md"), "Amethyst sentinel.");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: "main" }] },
          memory: {
            search: {
              provider: "none",
              sources: ["memory"],
              store: { vector: { enabled: false } },
              query: { minScore: 0 },
            },
          },
        };
        manager = await turnContext.run("opening turn", () =>
          pendingInputContext.run("accepted input", async () => {
            const opened = await MemoryIndexManager.get({ cfg, agentId: "main" });
            expect(turnContext.getStore()).toBe("opening turn");
            expect(pendingInputContext.getStore()).toBe("accepted input");
            return opened;
          }),
        );
        if (!manager) {
          throw new Error("memory manager unavailable");
        }
        const activeManager = manager;
        await activeManager.sync({ reason: "test-initial-index" });
        expect(activeManager.status().fts?.available).toBe(true);
        expect(activeFilesystemWatchers()).toBeGreaterThan(initialWatchers);
        const indexPath = activeManager.status().dbPath;
        if (!indexPath) {
          throw new Error("memory index path unavailable");
        }
        index = new DatabaseSync(indexPath, { readOnly: true });
        const indexedRows = index.prepare(
          `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
        );
        // Observe committed data without searching: search can synchronize dirty
        // or empty indexes itself and would conceal broken filesystem watchers.
        const expectIndexed = async (files: Array<{ path: string; text: string }>) => {
          await expect
            .poll(() => indexedRows.all(), { timeout: 15_000 })
            .toEqual([{ path: "MEMORY.md", text: "Evergreen sentinel." }, ...files]);
        };
        await expectIndexed([{ path: "memory/old.md", text: "Amethyst sentinel." }]);

        await fs.rename(memoryDir, state.path("previous-memory"));
        if (operation === "removal") {
          // Observe deletion before recreation; the parent must retain coverage
          // even after the dead root's native watchers have been closed.
          await expectIndexed([]);
        }
        await fs.mkdir(memoryDir);
        const fresh = { path: "memory/fresh.md", text: "Heliotrope sentinel." };
        await fs.writeFile(path.join(memoryDir, "fresh.md"), fresh.text);
        await expectIndexed([fresh]);

        const nestedDir = path.join(memoryDir, "nested");
        await fs.mkdir(nestedDir);
        const nested = { path: "memory/nested/note.md", text: "Juniper sentinel." };
        await fs.writeFile(path.join(nestedDir, "note.md"), nested.text);
        await expectIndexed([fresh, nested]);
        nested.text = "Cobalt sentinel.";
        await fs.writeFile(path.join(nestedDir, "note.md"), nested.text);
        await expectIndexed([fresh, nested]);
        await fs.rm(nestedDir, { recursive: true });
        await expectIndexed([fresh]);
        expect((await activeManager.search("Heliotrope")).map((result) => result.path)).toEqual([
          fresh.path,
        ]);
        expect(await activeManager.search("Amethyst")).toEqual([]);
        expect(await activeManager.search("Cobalt")).toEqual([]);
        expect(watcherContexts.length).toBeGreaterThan(0);
        expect(timerContexts.length).toBeGreaterThan(0);
        for (const context of [...watcherContexts, ...timerContexts]) {
          expect(context).toEqual({ turn: undefined, pendingInput: undefined });
        }

        index.close();
        index = undefined;
        await activeManager.close();
        await expect.poll(activeFilesystemWatchers).toBe(initialWatchers);
      } finally {
        index?.close();
        await manager?.close();
        timerObserver.mockRestore();
        watchObserver.mockRestore();
        syncBuiltinESMExports();
        resetMemoryCoreDreamingStateForTests();
        await state.cleanup();
      }
    },
    60_000,
  );
});
