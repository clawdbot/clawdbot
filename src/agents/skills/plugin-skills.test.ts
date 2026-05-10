import fsSync, { type Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __testing as acpRuntimeTesting,
  registerAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { __testing } from "./plugin-skills.js";

const hoisted = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  const loadPluginMetadataSnapshot = vi.fn(() => {
    const manifestRegistry = loadManifestRegistry();
    return {
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      normalizePluginId: (pluginId: string) =>
        manifestRegistry.plugins.find((plugin: { id: string; legacyPluginIds?: string[] }) =>
          plugin.legacyPluginIds?.includes(pluginId),
        )?.id ?? pluginId,
    };
  });
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginMetadataSnapshot,
    loadPluginRegistrySnapshot: vi.fn(() => ({ plugins: [] })),
  };
});

vi.mock("../../plugins/manifest-registry-installed.js", () => ({
  loadPluginManifestRegistryForInstalledIndex: hoisted.loadPluginManifestRegistryForInstalledIndex,
}));

vi.mock("../../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: hoisted.loadPluginManifestRegistryForPluginRegistry,
  loadPluginRegistrySnapshot: hoisted.loadPluginRegistrySnapshot,
}));

vi.mock("../../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: hoisted.loadPluginMetadataSnapshot,
}));

let resolvePluginSkillDirs: typeof import("./plugin-skills.js").resolvePluginSkillDirs;

const tempDirs = createTrackedTempDirs();

async function expectPathMissing(targetPath: string): Promise<void> {
  try {
    await fs.lstat(targetPath);
  } catch (error) {
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
    return;
  }
  throw new Error(`Expected path to be missing: ${targetPath}`);
}

function buildRegistry(params: { acpxRoot: string; helperRoot: string }): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "acpx",
        name: "ACPX Runtime",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: ["./skills"],
        hooks: [],
        origin: "workspace",
        rootDir: params.acpxRoot,
        source: params.acpxRoot,
        manifestPath: path.join(params.acpxRoot, "openclaw.plugin.json"),
      },
      {
        id: "helper",
        name: "Helper",
        channels: [],
        providers: [],
        cliBackends: [],
        skills: ["./skills"],
        hooks: [],
        origin: "workspace",
        rootDir: params.helperRoot,
        source: params.helperRoot,
        manifestPath: path.join(params.helperRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

function createSinglePluginRegistry(params: {
  pluginRoot: string;
  skills: string[];
  format?: "openclaw" | "bundle";
  legacyPluginIds?: string[];
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "helper",
        name: "Helper",
        format: params.format,
        channels: [],
        providers: [],
        cliBackends: [],
        legacyPluginIds: params.legacyPluginIds,
        skills: params.skills,
        hooks: [],
        origin: "workspace",
        rootDir: params.pluginRoot,
        source: params.pluginRoot,
        manifestPath: path.join(params.pluginRoot, "openclaw.plugin.json"),
      },
    ],
  };
}

async function setupAcpxAndHelperRegistry() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const acpxRoot = await tempDirs.make("openclaw-acpx-plugin-");
  const helperRoot = await tempDirs.make("openclaw-helper-plugin-");
  await fs.mkdir(path.join(acpxRoot, "skills"), { recursive: true });
  await fs.mkdir(path.join(helperRoot, "skills"), { recursive: true });
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
    buildRegistry({ acpxRoot, helperRoot }),
  );
  return { workspaceDir, acpxRoot, helperRoot };
}

async function setupPluginOutsideSkills() {
  const workspaceDir = await tempDirs.make("openclaw-");
  const pluginRoot = await tempDirs.make("openclaw-plugin-");
  const outsideDir = await tempDirs.make("openclaw-outside-");
  const outsideSkills = path.join(outsideDir, "skills");
  return { workspaceDir, pluginRoot, outsideSkills };
}

function registerHealthyAcpBackend() {
  registerAcpRuntimeBackend({
    id: "acpx",
    runtime: {
      async ensureSession(input) {
        return {
          sessionKey: input.sessionKey,
          backend: "acpx",
          runtimeSessionName: input.sessionKey,
        };
      },
      async *runTurn() {
        yield { type: "done" as const };
      },
      async cancel() {},
      async close() {},
    },
  });
}

afterEach(async () => {
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
  hoisted.loadPluginMetadataSnapshot.mockClear();
  hoisted.loadPluginRegistrySnapshot.mockReset();
  acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
  await tempDirs.cleanup();
});

describe("resolvePluginSkillDirs", () => {
  beforeAll(async () => {
    ({ resolvePluginSkillDirs } = await import("./plugin-skills.js"));
  });

  beforeEach(() => {
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });
    hoisted.loadPluginMetadataSnapshot.mockClear();
    hoisted.loadPluginRegistrySnapshot.mockReset();
    hoisted.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });

  it.each([
    {
      name: "keeps acpx plugin skills when ACP runtime is available",
      acpEnabled: true,
      backendAvailable: true,
      expectedDirs: ({ acpxRoot, helperRoot }: { acpxRoot: string; helperRoot: string }) => [
        path.resolve(acpxRoot, "skills"),
        path.resolve(helperRoot, "skills"),
      ],
    },
    {
      name: "skips acpx plugin skills when ACP is disabled",
      acpEnabled: false,
      backendAvailable: true,
      expectedDirs: ({ helperRoot }: { acpxRoot: string; helperRoot: string }) => [
        path.resolve(helperRoot, "skills"),
      ],
    },
    {
      name: "skips acpx plugin skills when no ACP runtime backend is loaded",
      acpEnabled: true,
      backendAvailable: false,
      expectedDirs: ({ helperRoot }: { acpxRoot: string; helperRoot: string }) => [
        path.resolve(helperRoot, "skills"),
      ],
    },
  ])("$name", async ({ acpEnabled, backendAvailable, expectedDirs }) => {
    const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();
    if (backendAvailable) {
      registerHealthyAcpBackend();
    }

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        acp: { enabled: acpEnabled },
        plugins: {
          entries: {
            acpx: { enabled: true },
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual(expectedDirs({ acpxRoot, helperRoot }));
  });

  it("rejects plugin skill paths that escape the plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
    await fs.mkdir(outsideSkills, { recursive: true });
    const escapePath = path.relative(pluginRoot, outsideSkills);

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills", escapePath],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(pluginRoot, "skills")]);
  });

  it("rejects plugin skill symlinks that resolve outside plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    const linkPath = path.join(pluginRoot, "skills-link");
    await fs.mkdir(outsideSkills, { recursive: true });
    await fs.symlink(
      outsideSkills,
      linkPath,
      process.platform === "win32" ? ("junction" as const) : ("dir" as const),
    );

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills-link"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toStrictEqual([]);
  });

  it("cleans up generated plugin skill links when the plugin registry is empty", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const staleRoot = await tempDirs.make("stale-plugin-skills-");
    const staleSkill = path.join(staleRoot, "stale-skill");
    await fs.mkdir(staleSkill, { recursive: true });
    fsSync.symlinkSync(staleSkill, path.join(pluginSkillsDir, "stale-skill"), "dir");

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {} as OpenClawConfig,
      pluginSkillsDir,
    });

    expect(dirs).toStrictEqual([]);
    await expectPathMissing(path.join(pluginSkillsDir, "stale-skill"));
  });

  it("cleans up generated plugin skill links when no workspace is active", async () => {
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const staleRoot = await tempDirs.make("stale-plugin-skills-");
    const staleSkill = path.join(staleRoot, "stale-skill");
    await fs.mkdir(staleSkill, { recursive: true });
    fsSync.symlinkSync(staleSkill, path.join(pluginSkillsDir, "stale-skill"), "dir");

    const dirs = resolvePluginSkillDirs({
      workspaceDir: undefined,
      config: {} as OpenClawConfig,
      pluginSkillsDir,
    });

    expect(dirs).toStrictEqual([]);
    await expectPathMissing(path.join(pluginSkillsDir, "stale-skill"));
  });

  it("resolves Claude bundle command roots through the normal plugin skill path", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-claude-bundle-");
    await fs.mkdir(path.join(pluginRoot, "commands"), { recursive: true });
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        format: "bundle",
        skills: ["./skills", "./commands"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([
      path.resolve(pluginRoot, "skills"),
      path.resolve(pluginRoot, "commands"),
    ]);
  });

  it("resolves enabled plugin skills through legacy manifest aliases", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-legacy-plugin-");
    await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills"],
        legacyPluginIds: ["helper-legacy"],
      }),
    );

    const dirs = resolvePluginSkillDirs({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            "helper-legacy": { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(dirs).toEqual([path.resolve(pluginRoot, "skills")]);
  });
});

describe("publishPluginSkills", () => {
  const { isGeneratedPluginSkillEntry, publishPluginSkills, resolvePluginSkillLinkType } =
    __testing;

  function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { configurable: true, value: platform });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", { configurable: true, value: originalPlatform });
    }
  }

  async function writeSkillDir(
    parentDir: string,
    name: string,
    description = `${name} description`,
  ) {
    const dir = path.join(parentDir, name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    );
    return dir;
  }

  it("creates symlinks for each plugin skill dir", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dirA = await writeSkillDir(skillParent, "skill-a");
    const dirB = await writeSkillDir(skillParent, "skill-b");

    publishPluginSkills([dirA, dirB], {
      pluginSkillsDir: managedDir,
    });

    const linkA = path.join(managedDir, "skill-a");
    const linkB = path.join(managedDir, "skill-b");
    expect(fsSync.readlinkSync(linkA)).toBe(dirA);
    expect(fsSync.readlinkSync(linkB)).toBe(dirB);
  });

  it("uses junction links for plugin skill directories on Windows", () => {
    expect(resolvePluginSkillLinkType("win32")).toBe("junction");
    expect(resolvePluginSkillLinkType("linux")).toBe("dir");
    expect(resolvePluginSkillLinkType("darwin")).toBe("dir");
  });

  it("is idempotent: skips symlinks that already point to the same target", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "my-skill");

    publishPluginSkills([dir], { pluginSkillsDir: managedDir });
    const mtimeAfterFirst = (await fs.lstat(path.join(managedDir, "my-skill"))).mtimeMs;

    // Second call with same input should preserve the existing symlink.
    publishPluginSkills([dir], { pluginSkillsDir: managedDir });
    const mtimeAfterSecond = (await fs.lstat(path.join(managedDir, "my-skill"))).mtimeMs;

    expect(mtimeAfterSecond).toBe(mtimeAfterFirst);
    expect(fsSync.readlinkSync(path.join(managedDir, "my-skill"))).toBe(dir);
  });

  it("replaces owned generated symlinks when a plugin skill target moves", async () => {
    const skillParent1 = await tempDirs.make("plugin-skills-1-");
    const skillParent2 = await tempDirs.make("plugin-skills-2-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir1 = await writeSkillDir(skillParent1, "my-skill", "old");
    const dir2 = await writeSkillDir(skillParent2, "my-skill", "new");

    fsSync.symlinkSync(dir1, path.join(managedDir, "my-skill"), "dir");

    publishPluginSkills([dir2], { pluginSkillsDir: managedDir });

    expect(fsSync.readlinkSync(path.join(managedDir, "my-skill"))).toBe(dir2);
  });

  it("cleans up stale symlinks whose targets still exist", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "current-skill");
    const staleDir = await writeSkillDir(skillParent, "stale-skill");

    fsSync.symlinkSync(staleDir, path.join(managedDir, "stale-skill"), "dir");

    publishPluginSkills([dir], { pluginSkillsDir: managedDir });

    expect(fsSync.existsSync(path.join(managedDir, "current-skill"))).toBe(true);
    expect(fsSync.existsSync(path.join(managedDir, "stale-skill"))).toBe(false);
  });

  it("cleans up stale generated junction-like directories on Windows", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "current-skill");
    const staleDir = path.join(managedDir, "stale-skill");
    await fs.mkdir(staleDir, { recursive: true });

    await withPlatform("win32", async () => {
      publishPluginSkills([dir], { pluginSkillsDir: managedDir });
    });

    expect(fsSync.existsSync(path.join(managedDir, "current-skill"))).toBe(true);
    expect(fsSync.existsSync(staleDir)).toBe(false);
  });

  it("treats Windows directory entries as generated plugin skill entries", () => {
    const directoryEntry = {
      isDirectory: () => true,
      isSymbolicLink: () => false,
    } as Dirent;
    const regularEntry = {
      isDirectory: () => false,
      isSymbolicLink: () => false,
    } as Dirent;

    expect(withPlatform("win32", () => isGeneratedPluginSkillEntry(directoryEntry))).toBe(true);
    expect(withPlatform("linux", () => isGeneratedPluginSkillEntry(directoryEntry))).toBe(false);
    expect(withPlatform("win32", () => isGeneratedPluginSkillEntry(regularEntry))).toBe(false);
  });

  it("cleans up broken symlinks (dangling)", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "current-skill");
    const nonexistentDir = path.join(skillParent, "nonexistent");

    // Create a symlink to a nonexistent directory.
    fsSync.symlinkSync(nonexistentDir, path.join(managedDir, "broken-skill"), "dir");

    publishPluginSkills([dir], { pluginSkillsDir: managedDir });

    expect(fsSync.existsSync(path.join(managedDir, "current-skill"))).toBe(true);
    // Broken symlink pointing to nonexistent target should be removed.
    expect(fsSync.existsSync(path.join(managedDir, "broken-skill"))).toBe(false);
  });

  it.runIf(process.platform !== "win32")(
    "skips child skill directories whose SKILL.md symlinks outside the declared root",
    async () => {
      const skillParent = await tempDirs.make("plugin-skills-");
      const managedDir = await tempDirs.make("managed-skills-");
      const outsideDir = await tempDirs.make("outside-skill-file-");
      const parentDir = path.join(skillParent, "skills");
      const leakDir = path.join(parentDir, "leak");
      await fs.mkdir(leakDir, { recursive: true });
      await fs.writeFile(
        path.join(outsideDir, "SKILL.md"),
        "---\nname: leak\ndescription: Outside\n---\n",
      );
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(leakDir, "SKILL.md"));
      const validDir = await writeSkillDir(parentDir, "valid");

      publishPluginSkills([parentDir], { pluginSkillsDir: managedDir });

      expect(fsSync.existsSync(path.join(managedDir, "leak"))).toBe(false);
      expect(fsSync.readlinkSync(path.join(managedDir, "valid"))).toBe(validDir);
    },
  );

  it("does not create managed skills dir when skill dirs list is empty", async () => {
    const parent = await tempDirs.make("parent-");
    const managedDir = path.join(parent, "does-not-exist");
    publishPluginSkills([], { pluginSkillsDir: managedDir });
    expect(fsSync.existsSync(managedDir)).toBe(false);
  });

  it("skips directories that do not contain a SKILL.md and have no skill children", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    // Create a dir without SKILL.md – should be skipped.
    const emptyDir = path.join(skillParent, "empty-dir");
    await fs.mkdir(emptyDir, { recursive: true });

    publishPluginSkills([emptyDir], {
      pluginSkillsDir: managedDir,
    });

    expect(fsSync.existsSync(path.join(managedDir, "empty-dir"))).toBe(false);
  });

  it("expands parent skill containers to child directories that contain SKILL.md", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    // Create a parent skills dir with child skill dirs (the layout used by
    // bundled plugins like browser and memory-wiki).
    const parentDir = path.join(skillParent, "skills");
    const childA = await writeSkillDir(parentDir, "browser");
    const childB = await writeSkillDir(parentDir, "memory");

    publishPluginSkills([parentDir], {
      pluginSkillsDir: managedDir,
    });

    // Child skill dirs should be published under their basenames.
    expect(fsSync.readlinkSync(path.join(managedDir, "browser"))).toBe(childA);
    expect(fsSync.readlinkSync(path.join(managedDir, "memory"))).toBe(childB);

    // The parent dir itself should NOT be published (no SKILL.md there).
    expect(fsSync.existsSync(path.join(managedDir, "skills"))).toBe(false);
  });

  it("handles empty skill dirs list without error", async () => {
    const managedDir = await tempDirs.make("managed-skills-");
    publishPluginSkills([], { pluginSkillsDir: managedDir });
    expect(fsSync.readdirSync(managedDir)).toStrictEqual([]);
  });

  it("handles collision: same basename from different plugins uses first one", async () => {
    const skillParent1 = await tempDirs.make("plugin-skills-1-");
    const skillParent2 = await tempDirs.make("plugin-skills-2-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir1 = await writeSkillDir(skillParent1, "shared-name", "first");
    const dir2 = await writeSkillDir(skillParent2, "shared-name", "second");

    publishPluginSkills([dir1, dir2], {
      pluginSkillsDir: managedDir,
    });

    // First one wins.
    expect(fsSync.readlinkSync(path.join(managedDir, "shared-name"))).toBe(dir1);
  });
});
