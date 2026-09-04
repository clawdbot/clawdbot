import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";
import { getMemoryWatchCapacityCode } from "./watch-capacity.js";

const CHOKIDAR_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const NATIVE_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

describe("memory watch capacity", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, CHOKIDAR_FACTORY_KEY);
    Reflect.deleteProperty(globalThis, NATIVE_FACTORY_KEY);
    resetMemoryCoreDreamingStateForTests();
  });

  it.each(["EMFILE", "ENFILE", "ENOSPC"])("classifies %s as exhausted capacity", (code) => {
    expect(getMemoryWatchCapacityCode(Object.assign(new Error(code), { code }))).toBe(code);
  });

  it.each(["root", "parent", "subtree"] as const)(
    "skips chokidar and refreshes on search after Linux %s watch capacity exhaustion",
    async (failurePoint) => {
      const state = await createOpenClawTestState({
        label: `memory-watch-capacity-${failurePoint}`,
      });
      const originalPlatform = process.platform;
      const memoryDir = path.join(state.workspaceDir, "memory");
      const capacityError = () =>
        Object.assign(new Error("EMFILE: too many open files, watch"), { code: "EMFILE" });
      const chokidarWatch = vi.fn();
      const nativeWatchers: Array<{
        on: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      }> = [];
      const nativeWatch = vi.fn((watchPath: string) => {
        if (
          (failurePoint === "root" && watchPath === memoryDir) ||
          (failurePoint === "parent" && watchPath === state.workspaceDir)
        ) {
          throw capacityError();
        }
        const watcher = {
          on: vi.fn(() => watcher),
          close: vi.fn(),
        };
        nativeWatchers.push(watcher);
        return watcher;
      });
      const originalReaddir = fsSync.readdirSync.bind(fsSync);
      const readdirSpy = vi.spyOn(fsSync, "readdirSync");
      readdirSpy.mockImplementation((...args: Parameters<typeof fsSync.readdirSync>) => {
        if (failurePoint === "subtree" && String(args[0]) === memoryDir) {
          throw capacityError();
        }
        return originalReaddir(...args);
      });
      Reflect.set(globalThis, CHOKIDAR_FACTORY_KEY, chokidarWatch);
      Reflect.set(globalThis, NATIVE_FACTORY_KEY, nativeWatch);
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      let manager: MemoryIndexManager | null = null;
      try {
        await configureMemoryCoreDreamingStateForTests(state.env);
        await fs.mkdir(memoryDir);
        await fs.writeFile(path.join(memoryDir, "baseline.md"), "Existing memory content.");
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
        await manager.sync({ reason: "test", force: true });
        const content = "Fresh content discovered after watch capacity exhaustion.";
        await fs.writeFile(path.join(memoryDir, "capacity-refresh.md"), content);

        expect(nativeWatch).toHaveBeenCalled();
        expect(chokidarWatch).not.toHaveBeenCalled();
        const staleResults = await manager.search("watch capacity exhaustion");
        expect(staleResults).toEqual([]);
        const fields = manager as unknown as { awaitManagerIdle: () => Promise<void> };
        await fields.awaitManagerIdle();
        const refreshedResults = await manager.search("watch capacity exhaustion");
        expect(refreshedResults).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              source: "memory",
              snippet: expect.stringContaining(content),
            }),
          ]),
        );
        await fields.awaitManagerIdle();
        if (failurePoint !== "root") {
          expect(nativeWatchers.every((watcher) => watcher.close.mock.calls.length > 0)).toBe(true);
        }
      } finally {
        readdirSpy.mockRestore();
        await manager?.close();
        Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
        await state.cleanup();
      }
    },
  );
});
