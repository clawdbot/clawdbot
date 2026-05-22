import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsChangeEvent } from "./refresh.js";

type WatchEvent = "add" | "change" | "unlink" | "unlinkDir" | "error";
type WatchCallback = (watchPath: string) => void;

function createMockWatcher() {
  const handlers = new Map<WatchEvent, WatchCallback[]>();
  const watcher = {
    on: vi.fn((event: WatchEvent, callback: WatchCallback) => {
      handlers.set(event, [...(handlers.get(event) ?? []), callback]);
      return watcher;
    }),
    close: vi.fn(async () => undefined),
    emit: (event: WatchEvent, watchPath: string) => {
      for (const callback of handlers.get(event) ?? []) {
        callback(watchPath);
      }
    },
  };
  return watcher;
}

const createdWatchers: Array<ReturnType<typeof createMockWatcher>> = [];
const watchMock = vi.fn(() => {
  const watcher = createMockWatcher();
  createdWatchers.push(watcher);
  return watcher;
});

let refreshModule: typeof import("./refresh.js");

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: vi.fn(() => []),
}));

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    watchMock.mockClear();
    createdWatchers.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("watches skill roots and filters non-skill churn", () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    // Each unique directory gets its own watcher (one path argument per call).
    const calls = watchMock.mock.calls as unknown as Array<
      [string, { depth?: number; ignored?: unknown }]
    >;
    expect(calls.length).toBeGreaterThan(0);
    const targets = calls.map((call) => call[0]);
    const opts = calls[0]?.[1] ?? {};

    expect(opts.ignored).toBe(refreshModule.shouldIgnoreSkillsWatchPath);
    expect(opts.depth).toBe(2);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toContain(posix(path.join("/tmp/workspace", "skills")));
    expect(targets).toContain(posix(path.join("/tmp/workspace", ".agents", "skills")));
    expect(targets).toContain(posix(path.join(os.homedir(), ".agents", "skills")));
    const wildcardTargets = targets.filter((target) => target.includes("*"));
    expect(wildcardTargets).toStrictEqual([]);
    const ignored = refreshModule.shouldIgnoreSkillsWatchPath;

    // Node/JS paths
    expect(ignored("/tmp/workspace/skills/node_modules/pkg/index.js")).toBe(true);
    expect(ignored("/tmp/workspace/skills/dist/index.js")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.git/config")).toBe(true);

    // Python virtual environments and caches
    expect(ignored("/tmp/workspace/skills/scripts/.venv/bin/python")).toBe(true);
    expect(ignored("/tmp/workspace/skills/venv/lib/python3.10/site.py")).toBe(true);
    expect(ignored("/tmp/workspace/skills/__pycache__/module.pyc")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.mypy_cache/3.10/foo.json")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.pytest_cache/v/cache")).toBe(true);

    // Build artifacts and caches
    expect(ignored("/tmp/workspace/skills/build/output.js")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.cache/data.json")).toBe(true);

    // Should NOT ignore normal skill files
    expect(ignored("/tmp/.hidden/skills/index.md")).toBe(false);
    expect(ignored("/tmp/workspace/skills/my-skill", { isDirectory: () => true })).toBe(false);
    expect(ignored("/tmp/workspace/skills/my-skill/README.md", {})).toBe(true);
    expect(ignored("/tmp/workspace/skills/my-skill/SKILL.md", {})).toBe(false);
  });

  it("keeps grouped skill folders within the watcher traversal depth", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string, { depth?: number; ignored?: unknown }]>
    )[0];
    expect(firstCall?.[1]?.depth).toBe(2);

    createdWatchers[0]?.emit("change", "/tmp/workspace/skills/group/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toEqual([
      {
        workspaceDir: "/tmp/workspace",
        reason: "watch",
        changedPath: "/tmp/workspace/skills/group/demo/SKILL.md",
      },
    ]);
  });

  it.each(["add", "change", "unlink", "unlinkDir"] as const)(
    "refreshes skills snapshots on %s",
    async (event) => {
      vi.useFakeTimers();
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { watchDebounceMs: 10 } } },
      });

      createdWatchers[0]?.emit(event, "/tmp/workspace/skills/demo/SKILL.md");
      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toEqual([
        {
          workspaceDir: "/tmp/workspace",
          reason: "watch",
          changedPath: "/tmp/workspace/skills/demo/SKILL.md",
        },
      ]);
    },
  );

  it("refreshes skills snapshots when watched skill roots change", () => {
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { extraDirs: ["/tmp/shared-a"] } } },
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { extraDirs: ["/tmp/shared-b"] } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedAIndex = callPaths.findIndex((target) => target.includes("/tmp/shared-a"));
    // The dropped extra dir is unsubscribed and its watcher closed; the new dir
    // gets a fresh watcher.
    expect(sharedAIndex).toBeGreaterThanOrEqual(0);
    expect(createdWatchers[sharedAIndex]?.close).toHaveBeenCalledTimes(1);
    expect(callPaths.some((target) => target.includes("/tmp/shared-b"))).toBe(true);
    expect(seen).toEqual([
      {
        workspaceDir: "/tmp/workspace",
        reason: "watch-targets",
        changedPath: expect.stringContaining("/tmp/shared-b"),
      },
    ]);
  });

  it("reuses one watcher when multiple workspaces watch the same shared skill root", () => {
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"] } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"] } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    // The shared directory is watched exactly once even though two workspaces
    // include it, instead of one watcher per workspace (the EMFILE root cause).
    const sharedWatchers = callPaths.filter((target) => target.includes("/tmp/shared"));
    expect(sharedWatchers).toHaveLength(1);
  });

  it("fans out a shared-directory change to every subscribed workspace", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedIndex = callPaths.findIndex((target) => target.includes("/tmp/shared"));
    expect(sharedIndex).toBeGreaterThanOrEqual(0);

    createdWatchers[sharedIndex]?.emit("change", "/tmp/shared/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-a",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-b",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
  });

  it("stops fanning a shared-directory change to a workspace after it unsubscribes", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });

    // ws-a turns watching off: it unsubscribes, but the shared watcher stays
    // alive for ws-b (torn down only when the last subscriber leaves).
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watch: false } } },
    });

    const callPaths = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedIndex = callPaths.findIndex((target) => target.includes("/tmp/shared"));
    expect(sharedIndex).toBeGreaterThanOrEqual(0);

    createdWatchers[sharedIndex]?.emit("change", "/tmp/shared/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-b",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
    expect(seen.some((change) => change.workspaceDir === "/tmp/ws-a")).toBe(false);
  });

  it("rebuilds a shared watcher with last-writer debounce while preserving subscribers", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-a",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 10 } } },
    });
    const callPaths1 = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const firstSharedIndex = callPaths1.findIndex((target) => target.includes("/tmp/shared"));

    // ws-b subscribes to the same path with a different debounce: the shared
    // watcher is rebuilt once, the previous instance closed, and both
    // workspaces remain subscribed.
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/ws-b",
      config: { skills: { load: { extraDirs: ["/tmp/shared"], watchDebounceMs: 50 } } },
    });

    expect(createdWatchers[firstSharedIndex]?.close).toHaveBeenCalledTimes(1);
    const callPaths2 = (watchMock.mock.calls as unknown as Array<[string]>).map((call) => call[0]);
    const sharedIndices = callPaths2
      .map((target, index) => (target.includes("/tmp/shared") ? index : -1))
      .filter((index) => index >= 0);
    expect(sharedIndices).toHaveLength(2);
    const liveSharedIndex = sharedIndices[sharedIndices.length - 1] ?? -1;

    createdWatchers[liveSharedIndex]?.emit("change", "/tmp/shared/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(50);

    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-a",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
    expect(seen).toContainEqual({
      workspaceDir: "/tmp/ws-b",
      reason: "watch",
      changedPath: "/tmp/shared/demo/SKILL.md",
    });
  });
});
