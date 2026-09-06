import nativeFs from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

describe.skipIf(process.platform !== "linux")("memory watch capacity", () => {
  it.each([
    { failurePoint: "root", code: "EMFILE" },
    { failurePoint: "root", code: "ENFILE" },
    { failurePoint: "root", code: "ENOSPC" },
    { failurePoint: "parent", code: "EMFILE" },
    { failurePoint: "subtree", code: "EMFILE" },
  ])(
    "keeps later searches fresh after $failurePoint watch $code without per-file watches",
    async ({ failurePoint, code }) => {
      const state = await createOpenClawTestState({ label: "memory-watch-capacity" });
      const memoryDir = path.join(state.workspaceDir, "memory");
      const nestedDir = path.join(memoryDir, "nested");
      const failurePath =
        failurePoint === "root"
          ? memoryDir
          : failurePoint === "parent"
            ? state.workspaceDir
            : nestedDir;
      const originalWatch = nativeFs.watch;
      const opened: nativeFs.FSWatcher[] = [];
      const closed = new Set<nativeFs.FSWatcher>();
      const nativeWatch = vi.spyOn(nativeFs, "watch").mockImplementation((...args) => {
        if (String(args[0]) === failurePath) {
          throw Object.assign(new Error(`${code}: native watch capacity exhausted`), {
            code,
            syscall: "watch",
            path: failurePath,
          });
        }
        const watcher = originalWatch(...args);
        opened.push(watcher);
        watcher.once("close", () => closed.add(watcher));
        return watcher;
      });
      syncBuiltinESMExports();
      let manager: MemoryIndexManager | null = null;
      try {
        await configureMemoryCoreDreamingStateForTests(state.env);
        await fs.mkdir(nestedDir, { recursive: true });
        await fs.writeFile(path.join(memoryDir, "baseline.md"), "Amber lantern baseline.");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
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
        const activeManager = manager;
        await activeManager.sync({ reason: "test-initial-index" });
        expect(
          nativeWatch.mock.calls.some(([watchPath]) => String(watchPath).endsWith(".md")),
        ).toBe(false);
        for (const text of ["Cobalt heron discovered.", "Violet badger replaced it."]) {
          await fs.writeFile(path.join(memoryDir, "fresh.md"), text);
          await expect
            .poll(async () => (await activeManager.search(text)).map((result) => result.snippet), {
              timeout: 10_000,
            })
            .toContain(text);
        }
        expect(await activeManager.search("Cobalt heron")).toEqual([]);
        await activeManager.close();
        await expect.poll(() => closed.size).toBe(opened.length);
      } finally {
        await manager?.close();
        nativeWatch.mockRestore();
        syncBuiltinESMExports();
        resetMemoryCoreDreamingStateForTests();
        await state.cleanup();
      }
    },
    30_000,
  );
});
