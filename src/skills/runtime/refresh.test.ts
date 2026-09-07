// Skill refresh tests cover runtime reload events and refresh-state updates.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { withEnvAsync } from "../../test-utils/env.js";
import {
  bumpSkillsSnapshotVersion,
  getSkillsSnapshotVersion,
  shouldRefreshSnapshotForVersion,
} from "./refresh-state.js";
import { createSkillsWatcherMock } from "./refresh.watcher.test-support.js";

type SkillsChangeEvent = NonNullable<Parameters<typeof bumpSkillsSnapshotVersion>[0]>;

const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();

const pluginSkillsMocks = vi.hoisted(() => ({
  resolvePluginSkillRoots: vi.fn((): Array<{ dir: string; rejectHardlinks: boolean }> => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(
    (): Array<{ dir: string; rejectHardlinks: boolean }> => [],
  ),
}));

let refreshModule: typeof import("./refresh.js");
let refreshTestSupport: typeof import("./refresh.test-support.js");
let fixtureRoot: string;
let fixtureWorkspaceDir: string;

async function createFixtureDirectory(relativePath: string): Promise<string> {
  const directory = path.join(fixtureRoot, relativePath);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));

vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: pluginSkillsMocks.resolvePluginSkillRoots,
  resolvePluginSkillRootsFromMetadata: pluginSkillsMocks.resolvePluginSkillRootsFromMetadata,
}));

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    refreshTestSupport = await import("./refresh.test-support.js");
  });

  beforeEach(async () => {
    watchMock.mockClear();
    createdWatchers.length = 0;
    pluginSkillsMocks.resolvePluginSkillRoots.mockClear();
    pluginSkillsMocks.resolvePluginSkillRootsFromMetadata.mockClear();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-fixture-"));
    fixtureWorkspaceDir = await createFixtureDirectory("workspace");
    await createFixtureDirectory("workspace/skills");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await refreshTestSupport.resetSkillsRefreshForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it("watches skill roots and filters non-skill churn", async () => {
    const workspaceDir = fixtureWorkspaceDir;
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    const workspaceSkillsRoot = path.join(workspaceDir, "skills");
    const projectSkillsRoot = path.join(workspaceDir, ".agents", "skills");
    const { options, watchRoot } = watchForSkillRoot(workspaceSkillsRoot);
    expect(watchRoot).toBe(workspaceSkillsRoot.replaceAll("\\", "/"));
    expect(options.followSymlinks).toBe(false);
    expect(options.depth).toBe(6);
    const projectWatch = watchForSkillRoot(projectSkillsRoot);
    expect(projectWatch.watchRoot).toBe(workspaceDir.replaceAll("\\", "/"));
    expect(projectWatch.options.depth).toBe(8);
    expect(
      watchForSkillRoot(path.join(os.homedir(), ".agents", "skills")).options.followSymlinks,
    ).toBe(false);
    expect(watchMock.mock.calls.every(([target]) => !target.includes("*"))).toBe(true);

    for (const ignoredPath of [
      "node_modules/pkg/index.js",
      "dist/index.js",
      ".git/config",
      "scripts/.venv/bin/python",
      "venv/lib/python3.10/site.py",
      "__pycache__/module.pyc",
      ".mypy_cache/3.10/foo.json",
      ".pytest_cache/v/cache",
      "build/output.js",
      ".cache/data.json",
    ]) {
      expect(options.ignored(path.join(workspaceSkillsRoot, ignoredPath))).toBe(true);
    }
    // Unknown paths within the root remain visible until Chokidar can classify them.
    expect(options.ignored(path.join(workspaceSkillsRoot, ".hidden", "index.md"))).toBe(false);
    const skillDir = path.join(workspaceSkillsRoot, "my-skill");
    expect(options.ignored(skillDir, { isDirectory: () => true })).toBe(false);
    expect(options.ignored(skillDir, { isSymbolicLink: () => true })).toBe(false);
    expect(options.ignored(path.join(skillDir, "README.md"), {})).toBe(true);
    expect(options.ignored(path.join(skillDir, "SKILL.md"), {})).toBe(true);
    expect(options.ignored(path.join(workspaceDir, "unrelated"), { isDirectory: () => true })).toBe(
      true,
    );
  });

  it("does not watch home-scoped personal skills for a non-default state directory", async () => {
    const createdRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-isolated-"));
    const root = await fs.realpath(createdRoot);
    try {
      await withEnvAsync(
        {
          HOME: root,
          OPENCLAW_HOME: undefined,
          OPENCLAW_STATE_DIR: path.join(root, "scratch-state"),
        },
        async () => {
          await fs.mkdir(path.join(root, ".agents", "skills"), { recursive: true });
          refreshModule.ensureSkillsWatcher({ workspaceDir: path.join(root, "workspace") });
          const calls = watchMock.mock.calls as unknown as Array<[string]>;
          const targets = calls.map(([target]) => target);
          expect(targets).not.toContain(path.join(os.homedir(), ".agents", "skills"));
        },
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps SKILL.md file watches in chokidar polling mode", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-polling-"));
    const previousPolling = process.env.CHOKIDAR_USEPOLLING;
    try {
      process.env.CHOKIDAR_USEPOLLING = "true";
      refreshModule.ensureSkillsWatcher({ workspaceDir });

      const opts = watchForSkillRoot(path.join(workspaceDir, "skills")).options;
      expect(opts.usePolling).toBe(true);
      expect(opts.ignored?.(path.join(workspaceDir, "skills", "my-skill", "SKILL.md"), {})).toBe(
        false,
      );
    } finally {
      if (previousPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = previousPolling;
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("does not double-refresh polling SKILL.md changes from raw events", async () => {
    vi.useFakeTimers();
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-polling-raw-"));
    const previousPolling = process.env.CHOKIDAR_USEPOLLING;
    const seen: SkillsChangeEvent[] = [];
    try {
      process.env.CHOKIDAR_USEPOLLING = "true";
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir,
        config: { skills: { load: {} } },
      });

      watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit(
        "raw",
        "change",
        path.join(workspaceDir, "skills", "demo", "SKILL.md"),
        {
          watchedPath: path.join(workspaceDir, "skills", "demo"),
        },
      );
      await vi.advanceTimersByTimeAsync(500);

      expect(seen).toEqual([]);
    } finally {
      if (previousPolling === undefined) {
        delete process.env.CHOKIDAR_USEPOLLING;
      } else {
        process.env.CHOKIDAR_USEPOLLING = previousPolling;
      }
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps grouped skill folders within the watcher traversal depth", async () => {
    vi.useFakeTimers();
    const workspaceDir = await createFixtureDirectory("watch-depth");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const watched = watchForSkillRoot(path.join(workspaceDir, "skills"));
    expect(watched.watchRoot).toBe(workspaceDir.replaceAll("\\", "/"));
    expect(watched.options.depth).toBe(7);

    const changedPath = path.join(workspaceDir, "skills", "group", "demo", "SKILL.md");
    watched.watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath,
      },
    ]);
  });

  it("refreshes snapshots from raw directory events for SKILL.md files", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit(
      "raw",
      "rename",
      "README.md",
      {
        watchedPath: path.join(fixtureWorkspaceDir, "skills", "demo"),
      },
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "rename", "SKILL.md", {
      watchedPath: path.join(fixtureWorkspaceDir, "skills", "demo"),
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"),
      },
    ]);
  });

  it("falls back to a watched-directory refresh when raw events omit a filename", async () => {
    vi.useFakeTimers();
    const workspaceDir = fixtureWorkspaceDir;
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "rename", undefined, {
      watchedPath: path.join(fixtureWorkspaceDir, "skills"),
    });
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: path.join(fixtureWorkspaceDir, "skills"),
      },
    ]);
  });

  it("waits for raw SKILL.md files to stabilize before refreshing", async () => {
    vi.useFakeTimers();
    const workspaceDir = await createFixtureDirectory("watch-stable");
    const skillDir = path.join(workspaceDir, "skills", "demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    const seen: SkillsChangeEvent[] = [];
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, "---\nname: demo\ndescription: Demo\n---\n");
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    watchForSkillRoot(path.join(workspaceDir, "skills")).watcher.emit("raw", "change", "SKILL.md", {
      watchedPath: skillDir,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([]);

    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([
      {
        workspaceDir,
        reason: "watch",
        changedPath: skillFile,
      },
    ]);
  });

  it("retires raw-file stability polling without publishing after watchers close", async () => {
    vi.useFakeTimers();
    const skillDir = await createFixtureDirectory("workspace/skills/demo");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(skillFile, "skill content");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watched = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills"));
    const versionBefore = getSkillsSnapshotVersion(fixtureWorkspaceDir);
    const stat = vi.spyOn(fsSync, "statSync");

    watched.watcher.emit("raw", "change", "SKILL.md", { watchedPath: skillDir });
    await refreshModule.closeSkillsWatchers();
    expect(watched.watcher.close).toHaveBeenCalledOnce();
    stat.mockClear();
    for (let tick = 0; tick < 4; tick += 1) {
      await fs.appendFile(skillFile, " still writing");
      await vi.advanceTimersByTimeAsync(100);
    }

    expect(seen).toEqual([]);
    expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBe(versionBefore);
    expect({
      postCloseReads: stat.mock.calls.filter(([file]) => file === skillFile).length,
      pendingTimers: vi.getTimerCount(),
    }).toEqual({ postCloseReads: 0, pendingTimers: 0 });
  });

  it.runIf(process.platform !== "win32")(
    "watches allowed symlink skill targets without following every root symlink",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-symlink-"));
      const targetRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-symlink-target-"));
      try {
        const workspaceSkillsDir = path.join(workspaceDir, "skills");
        const targetSkillDir = path.join(targetRoot, "linked-skill");
        const groupedLinkDir = path.join(workspaceSkillsDir, "group");
        await fs.mkdir(groupedLinkDir, { recursive: true });
        await fs.mkdir(targetSkillDir, { recursive: true });
        await fs.writeFile(
          path.join(targetSkillDir, "SKILL.md"),
          "---\nname: linked-skill\ndescription: Linked\n---\n",
        );
        await fs.symlink(targetSkillDir, path.join(groupedLinkDir, "linked-skill"), "dir");

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { allowSymlinkTargets: [targetRoot] } } },
        });

        const calls = watchMock.mock.calls as unknown as Array<
          [string, { followSymlinks?: boolean }]
        >;
        const target = (await fs.realpath(targetSkillDir)).replaceAll("\\", "/");
        expect(calls.find(([p]) => p.replaceAll("\\", "/") === target)?.[1].followSymlinks).toBe(
          false,
        );
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(targetRoot, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform !== "win32")("watches symlinked skill root targets", async () => {
    const workspaceDir = await createFixtureDirectory("watch-root-link");
    const targetSkillsDir = await createFixtureDirectory("watch-root-link-target");
    await fs.writeFile(
      path.join(targetSkillsDir, "SKILL.md"),
      "---\nname: linked-root\ndescription: Linked root\n---\n",
    );
    await fs.symlink(targetSkillsDir, path.join(workspaceDir, "skills"), "dir");

    refreshModule.ensureSkillsWatcher({ workspaceDir });

    const calls = watchMock.mock.calls as unknown as Array<[string, { followSymlinks?: boolean }]>;
    const target = (await fs.realpath(targetSkillsDir)).replaceAll("\\", "/");
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === target)?.[1].followSymlinks).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "does not watch untrusted companion skills symlink targets",
    async () => {
      const workspaceDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-watch-untrusted-link-"),
      );
      const repoDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-untrusted-repo-"));
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-watch-untrusted-target-"),
      );
      try {
        await fs.writeFile(
          path.join(outsideDir, "SKILL.md"),
          "---\nname: untrusted\ndescription: Untrusted\n---\n",
        );
        await fs.symlink(outsideDir, path.join(repoDir, "skills"), "dir");

        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: { skills: { load: { extraDirs: [repoDir] } } },
        });

        const target = (await fs.realpath(outsideDir)).replaceAll("\\", "/");
        const targets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(targets).not.toContain(target);
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(repoDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("watches nested skills roots for repo-style extra dirs", async () => {
    const repoDir = await createFixtureDirectory("skills-watch");
    await fs.mkdir(path.join(repoDir, "skills", "group", "demo"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [repoDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
    const repoRoot = repoDir.replaceAll("\\", "/");
    const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
    expect(targets).toContain(nestedRoot);
    expect(targets).toContain(repoRoot);
    expect(targets).not.toContain(path.join(repoDir, "SKILL.md").replaceAll("\\", "/"));
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(2);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(6);
  });

  it("watches nested skills roots for built-in workspace skill dirs", async () => {
    const workspaceDir = await createFixtureDirectory("workspace-skills");
    await fs.mkdir(path.join(workspaceDir, "skills", "skills", "group", "demo"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(workspaceDir, "skills", "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );

    refreshModule.ensureSkillsWatcher({ workspaceDir });

    const targets = (watchMock.mock.calls as unknown as Array<[string, object]>).map(([p]) =>
      p.replaceAll("\\", "/"),
    );
    expect(targets).toContain(path.join(workspaceDir, "skills").replaceAll("\\", "/"));
    expect(targets).toContain(path.join(workspaceDir, "skills", "skills").replaceAll("\\", "/"));
  });

  it("reuses watch roots while config is unchanged", async () => {
    const repoDir = await createFixtureDirectory("skills-watch-cache");
    await fs.mkdir(path.join(repoDir, "skills", "group", "demo"), { recursive: true });
    await fs.writeFile(
      path.join(repoDir, "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    const config = { skills: { load: { extraDirs: [repoDir] } } };

    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    const firstCallCount = watchMock.mock.calls.length;
    await fs.rm(path.join(repoDir, "skills"), { recursive: true, force: true });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
    const repoRoot = repoDir.replaceAll("\\", "/");
    const nestedRoot = path.join(repoDir, "skills").replaceAll("\\", "/");
    expect(watchMock).toHaveBeenCalledTimes(firstCallCount);
    expect(targets).toContain(nestedRoot);
    expect(targets).toContain(repoRoot);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === repoRoot)?.[1].depth).toBe(2);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(6);
  });

  it("reuses prepared plugin metadata when reconciling watch targets", () => {
    const config = { skills: { load: {} } };
    const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config,
      pluginMetadataSnapshot,
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config,
      pluginMetadataSnapshot,
    });

    expect(pluginSkillsMocks.resolvePluginSkillRoots).not.toHaveBeenCalled();
    expect(pluginSkillsMocks.resolvePluginSkillRootsFromMetadata).toHaveBeenCalledTimes(2);
    expect(pluginSkillsMocks.resolvePluginSkillRootsFromMetadata).toHaveBeenLastCalledWith({
      workspaceDir: fixtureWorkspaceDir,
      config,
      metadataSnapshot: pluginMetadataSnapshot,
    });
  });

  it("watches extra-dir roots and companion skills folders without resolving them", async () => {
    const repoDir = await createFixtureDirectory("skills-watch-pair");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [repoDir] } } },
    });

    const rootWatch = watchForSkillRoot(repoDir);
    const companionWatch = watchForSkillRoot(path.join(repoDir, "skills"));
    expect(rootWatch.watchRoot).toBe(repoDir.replaceAll("\\", "/"));
    expect(companionWatch.watchRoot).toBe(rootWatch.watchRoot);
    expect(rootWatch.options.depth).toBe(2);
    expect(companionWatch.options.depth).toBe(7);
    expect(companionWatch.options.ignored(path.join(repoDir, "other"))).toBe(true);
  });

  it("bumps missing configured root depth for first nested skill creation", async () => {
    const parentDir = await createFixtureDirectory("missing-skill-root");
    const missingRoot = path.join(parentDir, "repo");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [missingRoot] } } },
    });

    const rootWatch = watchForSkillRoot(missingRoot);
    const companionWatch = watchForSkillRoot(path.join(missingRoot, "skills"));
    expect(rootWatch.watchRoot).toBe(parentDir.replaceAll("\\", "/"));
    expect(companionWatch.watchRoot).toBe(rootWatch.watchRoot);
    expect(rootWatch.options.depth).toBe(3);
    expect(companionWatch.options.depth).toBe(8);
  });

  it("watches configured roots named skills at grouped depth", async () => {
    const parentDir = await createFixtureDirectory("configured-skills-root");
    const skillsDir = path.join(parentDir, "skills");
    await fs.mkdir(skillsDir, { recursive: true });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [skillsDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const root = skillsDir.replaceAll("\\", "/");
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === root)?.[1].depth).toBe(6);
  });

  it("dedupes overlapping watch roots by path while keeping the deepest depth", async () => {
    const workspaceDir = await createFixtureDirectory("watch-dedupe");
    const skillsDir = path.join(workspaceDir, "skills");
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { extraDirs: [skillsDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const root = skillsDir.replaceAll("\\", "/");
    const overlapping = calls.filter(([p]) => p.replaceAll("\\", "/") === root);
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]?.[1].depth).toBe(6);
  });

  it("does not downgrade a shared watcher when a shallow subscriber arrives later", async () => {
    const workspaceDir = await createFixtureDirectory("watch-share-a");
    const otherDir = await createFixtureDirectory("watch-share-b");
    const skillsDir = path.join(workspaceDir, "skills");
    await fs.mkdir(path.join(skillsDir, "skills"), { recursive: true });
    refreshModule.ensureSkillsWatcher({ workspaceDir });
    const firstCalls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const root = skillsDir.replaceAll("\\", "/");
    const firstIndex = firstCalls.findIndex(([p]) => p.replaceAll("\\", "/") === root);

    refreshModule.ensureSkillsWatcher({
      workspaceDir: otherDir,
      config: { skills: { load: { extraDirs: [skillsDir] } } },
    });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const overlapping = calls.filter(([p]) => p.replaceAll("\\", "/") === root);
    expect(overlapping).toHaveLength(1);
    expect(overlapping[0]?.[1].depth).toBe(6);
    expect(createdWatchers[firstIndex]?.close).not.toHaveBeenCalled();
  });

  it("preserves deeper shared coverage when a physical ancestor is replaced", async () => {
    vi.useFakeTimers();
    const ancestor = await createFixtureDirectory("ancestor");
    const logicalRoot = path.join(ancestor, "a", "b", "c", "d", "repo");
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const config = { skills: { load: { extraDirs: [logicalRoot] } } };
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    const shallow = watchForSkillRoot(logicalRoot);
    expect(shallow.watchRoot).toBe(ancestor.replaceAll("\\", "/"));
    expect(shallow.options.depth).toBe(7);

    await fs.mkdir(logicalRoot, { recursive: true });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: secondWorkspace,
      executionSkillsDir: logicalRoot,
    });
    const deeper = watchForSkillRoot(logicalRoot);
    expect(shallow.watcher.close).toHaveBeenCalledOnce();
    expect(deeper.watchRoot).toBe(logicalRoot.replaceAll("\\", "/"));
    // The old physical depth was seven, but covered only two logical levels.
    expect(deeper.options.depth).toBe(6);

    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    const versionBefore = getSkillsSnapshotVersion(fixtureWorkspaceDir);
    const removedParent = path.dirname(logicalRoot);
    await fs.rm(removedParent, { recursive: true });
    deeper.watcher.emit("all", "unlinkDir", logicalRoot);
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBeGreaterThan(versionBefore);

    // A shallow subscriber reconciles first; the surviving deeper subscriber
    // still requires six levels below the logical root on the new ancestor.
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    const rebuilt = watchForSkillRoot(logicalRoot);
    expect(deeper.watcher.close).toHaveBeenCalledOnce();
    expect(rebuilt.watchRoot).toBe(path.dirname(removedParent).replaceAll("\\", "/"));
    expect(rebuilt.options.depth).toBe(8);
    seen.length = 0;
    const changedPath = path.join(logicalRoot, "group", "nested", "demo", "SKILL.md");
    rebuilt.watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath },
      { workspaceDir: secondWorkspace, reason: "watch", changedPath },
    ]);
  });

  it("watches extra-dir skills folders for first nested skill creation", async () => {
    const repoDir = await createFixtureDirectory("skills-watch-create");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [repoDir] } } },
    });

    const nestedRoot = path.join(repoDir, "skills");
    const watched = watchForSkillRoot(nestedRoot);
    expect(watched.watchRoot).toBe(repoDir.replaceAll("\\", "/"));
    expect(watched.options.depth).toBe(7);
    expect(watched.options.ignored(path.join(repoDir, "unrelated"))).toBe(true);
  });

  it("watches nested skills roots for plugin skill dirs", async () => {
    const pluginDir = await createFixtureDirectory("plugin-skills-watch");
    await fs.mkdir(path.join(pluginDir, "skills", "group", "demo"), { recursive: true });
    await fs.writeFile(
      path.join(pluginDir, "skills", "group", "demo", "SKILL.md"),
      "---\nname: demo\ndescription: Demo\n---\n",
    );
    const pluginSkills = await import("../loading/plugin-skills.js");
    vi.mocked(pluginSkills.resolvePluginSkillRoots).mockReturnValueOnce([
      { dir: pluginDir, rejectHardlinks: true },
    ]);

    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });

    const calls = watchMock.mock.calls as unknown as Array<[string, { depth?: number }]>;
    const targets = calls.map(([p]) => p.replaceAll("\\", "/"));
    const pluginRoot = pluginDir.replaceAll("\\", "/");
    const nestedRoot = path.join(pluginDir, "skills").replaceAll("\\", "/");
    expect(targets).toContain(nestedRoot);
    expect(targets).toContain(pluginRoot);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === pluginRoot)?.[1].depth).toBe(2);
    expect(calls.find(([p]) => p.replaceAll("\\", "/") === nestedRoot)?.[1].depth).toBe(6);
  });

  it("watches plugin skills folders for first nested skill creation", async () => {
    const pluginDir = await createFixtureDirectory("plugin-skills-watch-create");
    const pluginSkills = await import("../loading/plugin-skills.js");
    vi.mocked(pluginSkills.resolvePluginSkillRoots).mockReturnValueOnce([
      { dir: pluginDir, rejectHardlinks: true },
    ]);

    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });

    const nestedRoot = path.join(pluginDir, "skills");
    const watched = watchForSkillRoot(nestedRoot);
    expect(watched.watchRoot).toBe(pluginDir.replaceAll("\\", "/"));
    expect(watched.options.depth).toBe(7);
    expect(watched.options.ignored(path.join(pluginDir, "unrelated"))).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "does not watch untrusted plugin skill symlink targets",
    async () => {
      const pluginDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-plugin-skills-untrusted-link-"),
      );
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "openclaw-plugin-skills-untrusted-target-"),
      );
      try {
        await fs.mkdir(path.join(pluginDir, "skills"), { recursive: true });
        await fs.writeFile(
          path.join(outsideDir, "SKILL.md"),
          "---\nname: untrusted-plugin\ndescription: Untrusted plugin\n---\n",
        );
        await fs.symlink(outsideDir, path.join(pluginDir, "skills", "untrusted"), "dir");
        const pluginSkills = await import("../loading/plugin-skills.js");
        vi.mocked(pluginSkills.resolvePluginSkillRoots).mockReturnValueOnce([
          { dir: pluginDir, rejectHardlinks: true },
        ]);

        refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });

        const target = (await fs.realpath(outsideDir)).replaceAll("\\", "/");
        const targets = (watchMock.mock.calls as unknown as Array<[string]>).map(([p]) =>
          p.replaceAll("\\", "/"),
        );
        expect(targets).not.toContain(target);
      } finally {
        await fs.rm(pluginDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it.each(["add", "addDir", "change", "unlink", "unlinkDir"] as const)(
    "refreshes skills snapshots on %s",
    async (event) => {
      vi.useFakeTimers();
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: {} } },
      });

      watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher.emit(
        "all",
        event,
        path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"),
      );
      await vi.advanceTimersByTimeAsync(250);

      expect(seen).toEqual([
        {
          workspaceDir: fixtureWorkspaceDir,
          reason: "watch",
          changedPath: path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"),
        },
      ]);
    },
  );

  it.each(["add", "change", "unlink"] as const)(
    "refreshes the owning snapshot when an execution-directory skill emits %s",
    async (event) => {
      vi.useFakeTimers();
      const workspaceDir = fixtureWorkspaceDir;
      const executionSkillsDir = await createFixtureDirectory("execution-workspace/skills");
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({ workspaceDir, executionSkillsDir });
      const versionBefore = getSkillsSnapshotVersion(workspaceDir);
      const watched = watchForSkillRoot(executionSkillsDir);
      const changedPath = path.join(executionSkillsDir, "demo", "SKILL.md");
      watched.watcher.emit("all", event, changedPath);
      await vi.advanceTimersByTimeAsync(250);

      const versionAfter = getSkillsSnapshotVersion(workspaceDir);
      expect(shouldRefreshSnapshotForVersion(versionBefore, versionAfter)).toBe(true);
      expect(seen).toContainEqual({
        workspaceDir,
        reason: "watch",
        changedPath,
      });
    },
  );

  it("refreshes skills snapshots when watched skill roots change", async () => {
    const sharedA = await createFixtureDirectory("shared-a");
    const sharedB = await createFixtureDirectory("shared-b");
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedA] } } },
    });
    const previousWatcher = watchForSkillRoot(sharedA).watcher;

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedB] } } },
    });

    expect(previousWatcher.close).toHaveBeenCalledTimes(1);
    expect(watchForSkillRoot(sharedB).watchRoot).toBe(sharedB.replaceAll("\\", "/"));
    expect(seen).toEqual([
      {
        workspaceDir: fixtureWorkspaceDir,
        reason: "watch-targets",
        changedPath: expect.stringContaining(sharedB.replaceAll("\\", "/")),
      },
    ]);
  });

  it("reuses one watcher when multiple workspaces watch the same shared skill root", async () => {
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedSkillsRoot = await createFixtureDirectory("shared/skills");
    const sharedRoot = path.dirname(sharedSkillsRoot);
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    const firstRootWatcher = watchForSkillRoot(sharedRoot).watcher;
    const firstSkillsWatcher = watchForSkillRoot(sharedSkillsRoot).watcher;
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });

    expect(watchForSkillRoot(sharedRoot).watcher).toBe(firstRootWatcher);
    expect(watchForSkillRoot(sharedSkillsRoot).watcher).toBe(firstSkillsWatcher);
    const callPaths = watchMock.mock.calls.map(([watchRoot]) => watchRoot);
    expect(callPaths.filter((target) => target === sharedRoot.replaceAll("\\", "/"))).toHaveLength(
      1,
    );
    expect(
      callPaths.filter((target) => target === sharedSkillsRoot.replaceAll("\\", "/")),
    ).toHaveLength(1);
  });

  it("isolates logical roots sharing an ancestor across traversal and event streams", async () => {
    vi.useFakeTimers();
    const ancestor = await createFixtureDirectory("shared-ancestor");
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const firstRoot = path.join(ancestor, "left", "skills");
    const secondRoot = path.join(ancestor, "right", "skills");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [firstRoot] } } },
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: secondWorkspace,
      config: { skills: { load: { extraDirs: [secondRoot] } } },
    });
    const first = watchForSkillRoot(firstRoot);
    const second = watchForSkillRoot(secondRoot);
    expect(first.watchRoot).toBe(ancestor.replaceAll("\\", "/"));
    expect(second.watchRoot).toBe(first.watchRoot);
    expect(first.watcher).not.toBe(second.watcher);
    for (const [watched, root, sibling] of [
      [first, firstRoot, secondRoot],
      [second, secondRoot, firstRoot],
    ] as const) {
      for (const included of [ancestor, path.dirname(root), root, path.join(root, "group")]) {
        expect(watched.options.ignored(included, { isDirectory: () => true })).toBe(false);
      }
      for (const excluded of [sibling, path.join(path.dirname(root), "unrelated")]) {
        expect(watched.options.ignored(excluded, { isDirectory: () => true })).toBe(true);
      }
    }
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => seen.push(change));
    const watchers = [first.watcher, second.watcher];
    for (const watcher of watchers) {
      watcher.emit("all", "addDir", path.join(ancestor, "unrelated"));
      watcher.emit("raw", "change", "SKILL.md", { watchedPath: ancestor });
      watcher.emit("raw", "rename", undefined, { watchedPath: ancestor });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([]);

    const firstChanged = path.join(firstRoot, "demo", "SKILL.md");
    for (const watcher of watchers) {
      watcher.emit("all", "change", firstChanged);
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: firstChanged },
    ]);
    seen.length = 0;
    const secondChanged = path.join(secondRoot, "demo", "SKILL.md");
    for (const watcher of watchers) {
      watcher.emit("raw", "change", "SKILL.md", { watchedPath: path.dirname(secondChanged) });
    }
    await vi.advanceTimersByTimeAsync(500);
    expect(seen).toEqual([
      { workspaceDir: secondWorkspace, reason: "watch", changedPath: secondChanged },
    ]);
    seen.length = 0;
    for (const watcher of watchers) {
      watcher.emit("raw", "rename", undefined, { watchedPath: firstRoot });
    }
    await vi.advanceTimersByTimeAsync(250);
    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath: firstRoot },
    ]);
  });

  it("fans out a shared-directory change to every subscribed workspace", async () => {
    vi.useFakeTimers();
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedRoot = await createFixtureDirectory("shared");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
    watchForSkillRoot(sharedRoot).watcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([
      { workspaceDir: fixtureWorkspaceDir, reason: "watch", changedPath },
      { workspaceDir: secondWorkspace, reason: "watch", changedPath },
    ]);
  });

  it("stops fanning a shared-directory change to a workspace after it unsubscribes", async () => {
    vi.useFakeTimers();
    const secondWorkspace = await createFixtureDirectory("second-workspace");
    const sharedRoot = await createFixtureDirectory("shared");
    const config = { skills: { load: { extraDirs: [sharedRoot] } } };
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir, config });
    refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
    const sharedWatcher = watchForSkillRoot(sharedRoot).watcher;

    refreshModule.ensureSkillsWatcher({
      workspaceDir: fixtureWorkspaceDir,
      config: { skills: { load: { extraDirs: [sharedRoot], watch: false } } },
    });
    seen.length = 0;
    expect(sharedWatcher.close).not.toHaveBeenCalled();
    const changedPath = path.join(sharedRoot, "demo", "SKILL.md");
    sharedWatcher.emit("all", "change", changedPath);
    await vi.advanceTimersByTimeAsync(250);

    expect(seen).toEqual([{ workspaceDir: secondWorkspace, reason: "watch", changedPath }]);
  });

  it("clears workspace version state on watch disable without losing pending invalidation", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const workspaceDir = fixtureWorkspaceDir;
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: {} } },
    });

    const firstVersion = bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch",
      changedPath: `${workspaceDir}/skills/demo/SKILL.md`,
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    const nextVersion = getSkillsSnapshotVersion(workspaceDir);
    expect(nextVersion).toBeGreaterThan(firstVersion);
    expect(shouldRefreshSnapshotForVersion(firstVersion, nextVersion)).toBe(true);
    vi.setSystemTime(new Date(nextVersion));
    const followupVersion = bumpSkillsSnapshotVersion({
      workspaceDir,
      reason: "watch",
    });
    expect(followupVersion).toBeGreaterThan(nextVersion);
  });

  it("evicts idle workspace subscriptions on a later ensure call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const idleWorkspaceDir = fixtureWorkspaceDir;
    const activeWorkspaceDir = await createFixtureDirectory("workspace-active");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: idleWorkspaceDir,
      config: { skills: { load: {} } },
    });
    const idleSkillsWatcher = watchForSkillRoot(path.join(idleWorkspaceDir, "skills")).watcher;
    const firstVersion = bumpSkillsSnapshotVersion({
      workspaceDir: idleWorkspaceDir,
      reason: "watch",
    });

    vi.advanceTimersByTime(60 * 60_000 + 1_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });

    expect(idleSkillsWatcher.close).toHaveBeenCalledTimes(1);
    const evictedVersion = getSkillsSnapshotVersion(idleWorkspaceDir);
    expect(evictedVersion).toBeGreaterThan(firstVersion);
    expect(shouldRefreshSnapshotForVersion(firstVersion, evictedVersion)).toBe(true);
    vi.setSystemTime(new Date(evictedVersion));
    const followupVersion = bumpSkillsSnapshotVersion({
      workspaceDir: idleWorkspaceDir,
    });
    expect(followupVersion).toBeGreaterThan(evictedVersion);
  });

  it("keeps refreshed workspace subscriptions within the idle TTL", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const activeWorkspaceDir = fixtureWorkspaceDir;
    const otherWorkspaceDir = await createFixtureDirectory("workspace-other");
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });
    const activeSkillsWatcher = watchForSkillRoot(path.join(activeWorkspaceDir, "skills")).watcher;

    vi.advanceTimersByTime(30 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: {} } },
    });
    vi.advanceTimersByTime(31 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: otherWorkspaceDir,
      config: { skills: { load: {} } },
    });

    expect(activeSkillsWatcher.close).not.toHaveBeenCalled();
  });
});
