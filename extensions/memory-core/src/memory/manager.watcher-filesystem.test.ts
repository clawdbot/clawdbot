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
  it.each(["replacement", "removal"] as const)(
    "keeps search fresh after root %s and releases watchers on close",
    async (operation) => {
      const state = await createOpenClawTestState({ label: "memory-watch-filesystem" });
      const initialWatchers = activeFilesystemWatchers();
      const openWatchers = new Set<nativeFs.FSWatcher>();
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
        const watcher = originalWatch(...args);
        openWatchers.add(watcher);
        watcher.once("close", () => openWatchers.delete(watcher));
        return watcher;
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
        expect(openWatchers.size).toBeGreaterThan(0);
        // Bun emits watcher close events but does not expose Node's FSEventWrap census.
        if (!process.versions.bun) {
          expect(activeFilesystemWatchers()).toBeGreaterThan(initialWatchers);
        }
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
        await expect.poll(() => openWatchers.size).toBe(0);
        if (!process.versions.bun) {
          await expect.poll(activeFilesystemWatchers).toBe(initialWatchers);
        }
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
