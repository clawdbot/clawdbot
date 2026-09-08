import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { MockInstance } from "vitest";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSkillsWatcherMock } from "./refresh.watcher.test-support.js";

const { createdWatchers, watchMock, watchForSkillRoot } = createSkillsWatcherMock();
let refreshModule: typeof import("./refresh.js");
let refreshTestSupport: typeof import("./refresh.test-support.js");
let fixtureRoot: string;
let fixtureWorkspaceDir: string;

vi.mock("chokidar", () => ({ default: { watch: watchMock } }));
vi.mock("../loading/plugin-skills.js", () => ({
  resolvePluginSkillRoots: vi.fn(() => []),
  resolvePluginSkillRootsFromMetadata: vi.fn(() => []),
}));

describe("Windows skills watcher paths", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
    refreshTestSupport = await import("./refresh.test-support.js");
  });
  beforeEach(async () => {
    watchMock.mockClear();
    createdWatchers.length = 0;
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-watch-fixture-"));
    fixtureWorkspaceDir = path.join(fixtureRoot, "workspace");
    await fs.mkdir(path.join(fixtureWorkspaceDir, "skills"), { recursive: true });
  });
  afterEach(async () => {
    await refreshTestSupport.resetSkillsRefreshForTest();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  it.each(["existing", "missing", "untrusted-link", "trusted-link"] as const)(
    "expands Windows short watch paths without changing %s root behavior",
    async (scenario) => {
      const root = await fs.realpath(
        await fs.mkdtemp(path.join(os.tmpdir(), "skills-short-path-")),
      );
      const shortRoot = path.join(root, "SHORT~1");
      const longRoot = path.join(root, "Expanded directory");
      const workspaceDir = path.join(shortRoot, "workspace");
      const repoDir = path.join(shortRoot, "repo");
      const outsideDir = path.join(root, "outside");
      const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
      const nativeRealpath = fsSync.realpathSync.native;
      let realpathSpy: MockInstance<typeof fsSync.realpathSync.native> | undefined;
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(repoDir);
        await fs.mkdir(path.join(longRoot, "workspace"), { recursive: true });
        await fs.mkdir(path.join(longRoot, "repo"));
        await fs.mkdir(outsideDir);
        if (scenario === "existing") {
          await fs.mkdir(path.join(workspaceDir, "skills"));
          await fs.mkdir(path.join(longRoot, "workspace", "skills"));
        }
        if (scenario.endsWith("link")) {
          await fs.symlink(outsideDir, path.join(repoDir, "skills"), "junction");
          await fs.symlink(outsideDir, path.join(longRoot, "repo", "skills"), "junction");
        }
        Object.defineProperty(process, "platform", { ...platform, value: "win32" });
        realpathSpy = vi.spyOn(fsSync.realpathSync, "native").mockImplementation((input) => {
          const resolved = nativeRealpath(input);
          return typeof resolved === "string" &&
            (resolved === shortRoot || resolved.startsWith(`${shortRoot}${path.sep}`))
            ? `${longRoot}${resolved.slice(shortRoot.length)}`
            : resolved;
        });
        refreshModule.ensureSkillsWatcher({
          workspaceDir,
          config: {
            skills: {
              load: {
                extraDirs: [repoDir],
                ...(scenario === "trusted-link" ? { allowSymlinkTargets: [outsideDir] } : {}),
              },
            },
          },
        });
        const normalized = (value: string) => value.replaceAll("\\", "/");
        const skillsRoot = path.join(longRoot, "workspace", "skills");
        const skillsWatch = watchForSkillRoot(skillsRoot);
        expect(skillsWatch.watchRoot).toBe(
          normalized(scenario === "existing" ? skillsRoot : path.dirname(skillsRoot)),
        );
        expect(skillsWatch.options).toMatchObject({
          depth: scenario === "existing" ? 6 : 7,
          followSymlinks: false,
        });
        const repoSkillsRoot = path.join(longRoot, "repo", "skills");
        expect(watchForSkillRoot(repoSkillsRoot).watchRoot).toBe(
          normalized(scenario.endsWith("link") ? repoSkillsRoot : path.dirname(repoSkillsRoot)),
        );
        expect(watchMock.mock.calls.some(([target]) => target === normalized(outsideDir))).toBe(
          scenario === "trusted-link",
        );
      } finally {
        realpathSpy?.mockRestore();
        Object.defineProperty(process, "platform", platform);
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "keeps a missing drive-child root anchored absolutely",
    () => {
      const driveRoot = path.parse(fixtureRoot).root;
      const missingRoot = path.join(driveRoot, `${path.basename(fixtureRoot)}-missing`);
      expect(fsSync.existsSync(missingRoot)).toBe(false);
      refreshModule.ensureSkillsWatcher({
        workspaceDir: fixtureWorkspaceDir,
        config: { skills: { load: { extraDirs: [missingRoot] } } },
      });
      const subscription = watchForSkillRoot(missingRoot);
      expect(subscription.watchRoot).toBe(driveRoot.replaceAll("\\", "/"));
      expect(path.isAbsolute(subscription.watchRoot)).toBe(true);
      expect(subscription.options.followSymlinks).toBe(false);
    },
  );
});
