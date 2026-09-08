import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { getSkillsSnapshotVersion } from "./refresh-state.js";
import { createSkillsWatcherMock } from "./refresh.watcher.test-support.js";

const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
  resolvePluginSkillRootsFromMetadata: () => [],
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

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    refreshTestSupport = await import("./refresh.test-support.js");
  });

  beforeEach(async () => {
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-capacity-"));
    fixtureWorkspaceDir = await createFixtureDirectory("workspace");
    await createFixtureDirectory("workspace/skills");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    await refreshTestSupport.resetSkillsRefreshForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each(["EMFILE", "ENFILE", "ENOSPC"])(
    "refreshes shared skill snapshots during preparation after native %s",
    async (code) => {
      const { resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js");
      const sharedRoot = await createFixtureDirectory("shared/skills");
      const secondWorkspace = await createFixtureDirectory("second-workspace");
      const skillDir = path.join(sharedRoot, "capacity-proof");
      const config = { skills: { load: { extraDirs: [sharedRoot] } } };
      const resolveSnapshot = (workspaceDir: string, existingSnapshot?: SkillSnapshot) =>
        resolveReusableWorkspaceSkillSnapshot({
          workspaceDir,
          config,
          skillFilter: ["capacity-proof", "added-proof"],
          existingSnapshot,
        }).snapshot;
      await writeSkill({
        dir: skillDir,
        name: "capacity-proof",
        description: "Amber lantern catalog description.",
      });
      const first = resolveSnapshot(fixtureWorkspaceDir);
      const second = resolveSnapshot(secondWorkspace);
      expect(first.prompt).toContain("Amber lantern catalog description.");
      expect(second.prompt).toContain("Amber lantern catalog description.");
      const failedWatcher = watchForSkillRoot(sharedRoot).watcher;
      failedWatcher.emit("error", Object.assign(new Error(code), { code, syscall: "watch" }));
      const watcherCount = createdWatchers.length;
      expect(createdWatchers.every((watcher) => watcher.closed)).toBe(true);
      // Real Chokidar close removes listeners while scan rejections can still arrive.
      expect(() => {
        failedWatcher.emit("error", Object.assign(new Error("late scan"), { code: "EACCES" }));
      }).not.toThrow();

      await writeSkill({
        dir: skillDir,
        name: "capacity-proof",
        description: "Cobalt heron catalog description.",
      });
      const editedFirst = resolveSnapshot(fixtureWorkspaceDir, first);
      const editedSecond = resolveSnapshot(secondWorkspace, second);
      for (const snapshot of [editedFirst, editedSecond]) {
        expect(snapshot.prompt).toContain("Cobalt heron catalog description.");
        expect(snapshot.prompt).not.toContain("Amber lantern catalog description.");
      }

      await writeSkill({
        dir: path.join(sharedRoot, "added-proof"),
        name: "added-proof",
        description: "Silver otter new catalog entry.",
      });
      expect(resolveSnapshot(fixtureWorkspaceDir, editedFirst).prompt).toContain(
        "Silver otter new catalog entry.",
      );
      expect(resolveSnapshot(secondWorkspace, editedSecond).prompt).toContain(
        "Silver otter new catalog entry.",
      );
      const lateWorkspace = await createFixtureDirectory("late-workspace");
      expect(resolveSnapshot(lateWorkspace).prompt).toContain("Silver otter new catalog entry.");
      expect(createdWatchers).toHaveLength(watcherCount);

      const disabled = {
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: { watch: false } } },
      };
      refreshModule.ensureSkillsWatcher(disabled);
      const disabledVersion = getSkillsSnapshotVersion(fixtureWorkspaceDir);
      refreshModule.ensureSkillsWatcher(disabled);
      expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBe(disabledVersion);
      expect(createdWatchers).toHaveLength(watcherCount);

      await refreshModule.closeSkillsWatchers();
      refreshModule.ensureSkillsWatcher({ workspaceDir: secondWorkspace, config });
      expect(watchForSkillRoot(sharedRoot).watcher.closed).toBe(false);
    },
  );

  it.each([
    { code: "EACCES", syscall: "watch" },
    { code: "ENOSPC", syscall: "scandir" },
    { code: "EMFILE", syscall: "open" },
  ])("keeps active skill watching after $syscall $code", async ({ code, syscall }) => {
    vi.useFakeTimers();
    refreshModule.ensureSkillsWatcher({ workspaceDir: fixtureWorkspaceDir });
    const watcher = watchForSkillRoot(path.join(fixtureWorkspaceDir, "skills")).watcher;
    watcher.emit("error", Object.assign(new Error(code), { code, syscall }));
    expect(watcher.closed).toBe(false);
    const before = getSkillsSnapshotVersion(fixtureWorkspaceDir);
    watcher.emit("all", "change", path.join(fixtureWorkspaceDir, "skills", "demo", "SKILL.md"));
    await vi.advanceTimersByTimeAsync(250);
    expect(getSkillsSnapshotVersion(fixtureWorkspaceDir)).toBeGreaterThan(before);
  });
});
