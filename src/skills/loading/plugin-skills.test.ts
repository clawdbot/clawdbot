// Plugin skill loading tests cover skill discovery from plugin-provided skill bundles.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  testing as acpRuntimeTesting,
  registerAcpRuntimeBackend,
} from "../../acp/runtime/registry.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginManifestRegistry } from "../../plugins/manifest-registry.js";
import { createPluginCache, withPluginCache } from "../../plugins/plugin-cache.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import type { PluginOrigin } from "../../plugins/plugin-origin.types.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";

const hoisted = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  const loadPluginMetadataSnapshot = vi.fn((_params?: unknown) => {
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
  const resolvePluginMetadataSnapshot = vi.fn((params: unknown) =>
    loadPluginMetadataSnapshot(params),
  );
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
    loadPluginMetadataSnapshot,
    resolvePluginMetadataSnapshot,
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
  resolvePluginMetadataSnapshot: hoisted.resolvePluginMetadataSnapshot,
}));

let resolvePluginSkillRoots: typeof import("./plugin-skills.js").resolvePluginSkillRoots;
let resolvePluginSkillRootsFromMetadata: typeof import("./plugin-skills.js").resolvePluginSkillRootsFromMetadata;

const tempDirs = createTrackedTempDirs();
const directorySymlinkType = process.platform === "win32" ? "junction" : "dir";

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
  bundleFormat?: "agent" | "codex" | "claude" | "cursor";
  legacyPluginIds?: string[];
  origin?: PluginOrigin;
}): PluginManifestRegistry {
  return {
    diagnostics: [],
    plugins: [
      {
        id: "helper",
        name: "Helper",
        format: params.format,
        bundleFormat: params.bundleFormat,
        channels: [],
        providers: [],
        cliBackends: [],
        legacyPluginIds: params.legacyPluginIds,
        skills: params.skills,
        hooks: [],
        origin: params.origin ?? "workspace",
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

function useStableMetadataSnapshot(manifestRegistry: PluginManifestRegistry): void {
  const snapshot = {
    manifestRegistry,
    plugins: manifestRegistry.plugins,
    normalizePluginId: (pluginId: string) =>
      manifestRegistry.plugins.find((plugin) => plugin.legacyPluginIds?.includes(pluginId))?.id ??
      pluginId,
  };
  hoisted.loadPluginMetadataSnapshot
    .mockReturnValueOnce(snapshot)
    .mockReturnValueOnce(snapshot)
    .mockReturnValueOnce(snapshot);
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
  clearPluginMetadataLifecycleCaches();
  hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
  hoisted.loadPluginMetadataSnapshot.mockClear();
  hoisted.resolvePluginMetadataSnapshot.mockClear();
  hoisted.loadPluginRegistrySnapshot.mockReset();
  acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
  await tempDirs.cleanup();
});

describe("resolvePluginSkillRoots", () => {
  beforeAll(async () => {
    ({ resolvePluginSkillRoots, resolvePluginSkillRootsFromMetadata } =
      await import("./plugin-skills.js"));
  });

  it("uses supplied lifecycle metadata without a cold load", async () => {
    const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();
    registerHealthyAcpBackend();
    const manifestRegistry = buildRegistry({ acpxRoot, helperRoot });

    const roots = resolvePluginSkillRootsFromMetadata({
      workspaceDir,
      config: {
        acp: { enabled: true },
        plugins: { entries: { acpx: { enabled: true }, helper: { enabled: true } } },
      } as OpenClawConfig,
      metadataSnapshot: {
        manifestRegistry,
        normalizePluginId: (pluginId: string) => pluginId,
      } as never,
    });

    expect(roots).toEqual([
      { dir: path.resolve(acpxRoot, "skills"), rejectHardlinks: true },
      { dir: path.resolve(helperRoot, "skills"), rejectHardlinks: true },
    ]);
    expect(hoisted.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  beforeEach(() => {
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReset();
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });
    hoisted.loadPluginMetadataSnapshot.mockClear();
    hoisted.resolvePluginMetadataSnapshot.mockClear();
    hoisted.loadPluginRegistrySnapshot.mockReset();
    hoisted.loadPluginRegistrySnapshot.mockReturnValue({ plugins: [] });
  });

  it("keeps package skill targets stable across config changes while publishing live selection", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const pluginRoot = await tempDirs.make("openclaw-plugin-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const skillsRoot = path.join(pluginRoot, "skills");
    const original = path.join(skillsRoot, "original");
    const added = path.join(skillsRoot, "added");
    await fs.mkdir(original, { recursive: true });
    await fs.writeFile(path.join(original, "SKILL.md"), "# Original\n");
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({ pluginRoot, skills: ["./skills"] }),
    );
    const config: OpenClawConfig = { plugins: { entries: { helper: { enabled: true } } } };
    const resolve = (nextConfig = config) =>
      resolvePluginSkillRoots({ workspaceDir, config: nextConfig, pluginSkillsDir });
    resolve();
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "original"))).toBe(original);

    await fs.mkdir(added);
    await fs.writeFile(path.join(added, "SKILL.md"), "# Added\n");
    resolve({ ...config });
    await expectPathMissing(path.join(pluginSkillsDir, "added"));

    withPluginCache(createPluginCache(), () => resolve({ ...config }));
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "added"))).toBe(added);
    resolve({ ...config });
    await expectPathMissing(path.join(pluginSkillsDir, "added"));

    resolve({ plugins: { entries: { helper: { enabled: false } } } });
    await expectPathMissing(path.join(pluginSkillsDir, "original"));
  });

  it.each([
    { origin: "bundled" as const, rejectHardlinks: false },
    { origin: "global" as const, rejectHardlinks: true },
    { origin: "workspace" as const, rejectHardlinks: true },
    { origin: "config" as const, rejectHardlinks: true },
  ])(
    "preserves authoritative $origin plugin hardlink policy on skill roots",
    async ({ origin, rejectHardlinks }) => {
      const workspaceDir = await tempDirs.make("openclaw-");
      const pluginRoot = await tempDirs.make("openclaw-plugin-");
      const skillDir = path.join(pluginRoot, "skills");
      await fs.mkdir(skillDir, { recursive: true });
      hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
        createSinglePluginRegistry({ pluginRoot, skills: ["./skills"], origin }),
      );

      expect(
        resolvePluginSkillRoots({
          workspaceDir,
          config: {
            plugins: { entries: { helper: { enabled: true } } },
          } as OpenClawConfig,
        }),
      ).toEqual([{ dir: skillDir, rejectHardlinks }]);
    },
  );

  it.each([
    { channelEnabled: false, expectsSkills: false },
    { channelEnabled: true, expectsSkills: true },
  ])(
    "honors channels.<id>.enabled=$channelEnabled through the manifest channel id when it differs from the plugin id",
    async ({ channelEnabled, expectsSkills }) => {
      const workspaceDir = await tempDirs.make("openclaw-");
      const pluginRoot = await tempDirs.make("openclaw-demo-plugin-");
      await fs.mkdir(path.join(pluginRoot, "skills"), { recursive: true });
      // QQ Bot style: plugin `openclaw-demo` owns `channels.demo`; the plugin id alone
      // cannot resolve that channel key.
      hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
        diagnostics: [],
        plugins: [
          {
            id: "openclaw-demo",
            name: "Demo",
            channels: ["demo"],
            providers: [],
            cliBackends: [],
            skills: ["./skills"],
            hooks: [],
            origin: "bundled",
            rootDir: pluginRoot,
            source: pluginRoot,
            manifestPath: path.join(pluginRoot, "openclaw.plugin.json"),
          },
        ],
      });

      const roots = resolvePluginSkillRoots({
        workspaceDir,
        config: {
          channels: { demo: { enabled: channelEnabled } },
          plugins: { entries: { "openclaw-demo": { enabled: true } } },
        } as OpenClawConfig,
      });

      expect(roots.map((root) => root.dir)).toEqual(
        expectsSkills ? [path.resolve(pluginRoot, "skills")] : [],
      );
    },
  );

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

    const roots = resolvePluginSkillRoots({
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

    expect(roots.map((root) => root.dir)).toEqual(expectedDirs({ acpxRoot, helperRoot }));
  });

  it("reuses current lifecycle metadata before falling back to a cold load", async () => {
    const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();
    registerHealthyAcpBackend();
    const manifestRegistry = buildRegistry({ acpxRoot, helperRoot });
    hoisted.resolvePluginMetadataSnapshot.mockReturnValueOnce({
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      normalizePluginId: (pluginId: string) => pluginId,
    });

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        acp: { enabled: true },
        plugins: { entries: { acpx: { enabled: true }, helper: { enabled: true } } },
      } as OpenClawConfig,
    });

    expect(roots.map((root) => root.dir)).toEqual([
      path.resolve(acpxRoot, "skills"),
      path.resolve(helperRoot, "skills"),
    ]);
    expect(hoisted.resolvePluginMetadataSnapshot).toHaveBeenCalledOnce();
    expect(hoisted.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it("preserves absent config when resolving current lifecycle metadata", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const manifestRegistry: PluginManifestRegistry = { diagnostics: [], plugins: [] };
    const metadataSnapshot = {
      manifestRegistry,
      plugins: manifestRegistry.plugins,
      normalizePluginId: (pluginId: string) => pluginId,
    };
    hoisted.resolvePluginMetadataSnapshot.mockImplementationOnce((params: unknown) =>
      (params as { config?: OpenClawConfig }).config === undefined
        ? metadataSnapshot
        : hoisted.loadPluginMetadataSnapshot(params),
    );

    expect(resolvePluginSkillRoots({ workspaceDir })).toEqual([]);
    expect(hoisted.loadPluginMetadataSnapshot).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unavailable to available",
      initiallyAvailable: false,
      firstIncludesAcpx: false,
      secondIncludesAcpx: true,
    },
    {
      name: "available to unavailable",
      initiallyAvailable: true,
      firstIncludesAcpx: true,
      secondIncludesAcpx: false,
    },
  ])(
    "invalidates the memo when ACP changes from $name with stable inputs",
    async ({ initiallyAvailable, firstIncludesAcpx, secondIncludesAcpx }) => {
      const { workspaceDir, acpxRoot, helperRoot } = await setupAcpxAndHelperRegistry();
      const manifestRegistry = buildRegistry({ acpxRoot, helperRoot });
      useStableMetadataSnapshot(manifestRegistry);
      const config = {
        acp: { enabled: true },
        plugins: {
          entries: {
            acpx: { enabled: true },
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig;
      if (initiallyAvailable) {
        registerHealthyAcpBackend();
      }

      const first = resolvePluginSkillRoots({ workspaceDir, config });

      if (initiallyAvailable) {
        acpRuntimeTesting.resetAcpRuntimeBackendsForTests();
      } else {
        registerHealthyAcpBackend();
      }
      const second = resolvePluginSkillRoots({ workspaceDir, config });

      const dirsForState = (includeAcpx: boolean) => [
        ...(includeAcpx ? [path.resolve(acpxRoot, "skills")] : []),
        path.resolve(helperRoot, "skills"),
      ];
      expect(first.map((root) => root.dir)).toEqual(dirsForState(firstIncludesAcpx));
      expect(second.map((root) => root.dir)).toEqual(dirsForState(secondIncludesAcpx));
      expect(resolvePluginSkillRoots({ workspaceDir, config })).toEqual(second);
    },
  );

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

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(roots).toEqual([{ dir: path.resolve(pluginRoot, "skills"), rejectHardlinks: true }]);
  });

  it("rejects plugin skill symlinks that resolve outside plugin root", async () => {
    const { workspaceDir, pluginRoot, outsideSkills } = await setupPluginOutsideSkills();
    const linkPath = path.join(pluginRoot, "skills-link");
    await fs.mkdir(outsideSkills, { recursive: true });
    await fs.symlink(outsideSkills, linkPath, directorySymlinkType);

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        skills: ["./skills-link"],
      }),
    );

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(roots).toStrictEqual([]);
  });

  it("cleans up generated plugin skill links when the plugin registry is empty", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const staleRoot = await tempDirs.make("stale-plugin-skills-");
    const staleSkill = path.join(staleRoot, "stale-skill");
    await fs.mkdir(staleSkill, { recursive: true });
    fsSync.symlinkSync(staleSkill, path.join(pluginSkillsDir, "stale-skill"), directorySymlinkType);

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins: [],
    });

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {} as OpenClawConfig,
      pluginSkillsDir,
    });

    expect(roots).toStrictEqual([]);
    await expectPathMissing(path.join(pluginSkillsDir, "stale-skill"));
  });

  it("cleans up generated plugin skill links when no workspace is active", async () => {
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const staleRoot = await tempDirs.make("stale-plugin-skills-");
    const staleSkill = path.join(staleRoot, "stale-skill");
    await fs.mkdir(staleSkill, { recursive: true });
    fsSync.symlinkSync(staleSkill, path.join(pluginSkillsDir, "stale-skill"), directorySymlinkType);

    const roots = resolvePluginSkillRoots({
      workspaceDir: undefined,
      config: {} as OpenClawConfig,
      pluginSkillsDir,
    });

    expect(roots).toStrictEqual([]);
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

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            helper: { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(roots.map((root) => root.dir)).toEqual([
      path.resolve(pluginRoot, "skills"),
      path.resolve(pluginRoot, "commands"),
    ]);
  });

  it("limits Agent Plugins skills to valid immediate child directories", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const pluginRoot = await tempDirs.make("openclaw-agent-bundle-");
    const pluginSkillsDir = await tempDirs.make("managed-plugin-skills-");
    const skillsRoot = path.join(pluginRoot, "skills");
    const validSkill = path.join(skillsRoot, "valid");
    const nestedSkill = path.join(skillsRoot, "group", "deep");
    await fs.mkdir(validSkill, { recursive: true });
    await fs.mkdir(nestedSkill, { recursive: true });
    await fs.mkdir(path.join(skillsRoot, "missing"), { recursive: true });
    await fs.writeFile(path.join(skillsRoot, "SKILL.md"), "root skill must be ignored\n");
    await fs.writeFile(path.join(validSkill, "SKILL.md"), "valid immediate skill\n");
    await fs.writeFile(path.join(nestedSkill, "SKILL.md"), "nested skill must be ignored\n");

    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue(
      createSinglePluginRegistry({
        pluginRoot,
        format: "bundle",
        bundleFormat: "agent",
        skills: ["skills"],
      }),
    );

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      pluginSkillsDir,
      config: {
        plugins: { entries: { helper: { enabled: true } } },
      } as OpenClawConfig,
    });

    expect(roots).toEqual([{ dir: validSkill, rejectHardlinks: true }]);
    expect(fsSync.readlinkSync(path.join(pluginSkillsDir, "valid"))).toBe(validSkill);
    expect(fsSync.existsSync(path.join(pluginSkillsDir, "deep"))).toBe(false);
    expect(fsSync.existsSync(path.join(pluginSkillsDir, "skills"))).toBe(false);
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

    const roots = resolvePluginSkillRoots({
      workspaceDir,
      config: {
        plugins: {
          entries: {
            "helper-legacy": { enabled: true },
          },
        },
      } as OpenClawConfig,
    });

    expect(roots).toEqual([{ dir: path.resolve(pluginRoot, "skills"), rejectHardlinks: true }]);
  });
});

describe("publishPluginSkills", () => {
  beforeAll(async () => {
    ({ resolvePluginSkillRoots } = await import("./plugin-skills.js"));
  });

  function publishPluginSkills(skillDirs: string[], opts: { pluginSkillsDir: string }): void {
    const plugins = skillDirs.map((rootDir, index) => ({
      id: `publish-test-${index}`,
      name: `Publish Test ${index}`,
      channels: [],
      providers: [],
      cliBackends: [],
      skills: ["."],
      hooks: [],
      origin: "workspace" as const,
      rootDir,
      source: rootDir,
      manifestPath: path.join(rootDir, "openclaw.plugin.json"),
    }));
    hoisted.loadPluginManifestRegistryForInstalledIndex.mockReturnValue({
      diagnostics: [],
      plugins,
    });
    resolvePluginSkillRoots({
      workspaceDir: opts.pluginSkillsDir,
      pluginSkillsDir: opts.pluginSkillsDir,
      config: {
        plugins: {
          entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { enabled: true }])),
        },
      },
    });
  }

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

    fsSync.symlinkSync(dir1, path.join(managedDir, "my-skill"), directorySymlinkType);

    publishPluginSkills([dir2], { pluginSkillsDir: managedDir });

    expect(fsSync.readlinkSync(path.join(managedDir, "my-skill"))).toBe(dir2);
  });

  it("replaces owned generated symlinks when the previous target disappeared", async () => {
    const staleParent = await tempDirs.make("plugin-skills-stale-");
    const currentParent = await tempDirs.make("plugin-skills-current-");
    const managedDir = await tempDirs.make("managed-skills-");

    const staleDir = await writeSkillDir(staleParent, "my-skill", "old");
    const currentDir = await writeSkillDir(currentParent, "my-skill", "new");
    const linkPath = path.join(managedDir, "my-skill");

    fsSync.symlinkSync(staleDir, linkPath, directorySymlinkType);
    await fs.rm(staleParent, { recursive: true, force: true });

    publishPluginSkills([currentDir], { pluginSkillsDir: managedDir });

    expect(fsSync.readlinkSync(linkPath)).toBe(currentDir);
  });

  it("replaces generated Windows directory entries before publishing a current skill", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "my-skill");
    const existingDir = path.join(managedDir, "my-skill");
    await fs.mkdir(existingDir, { recursive: true });
    await fs.writeFile(path.join(existingDir, "stale.txt"), "stale");

    withPlatform("win32", () => {
      publishPluginSkills([dir], { pluginSkillsDir: managedDir });
    });

    expect(fsSync.readlinkSync(existingDir)).toBe(dir);
  });

  it("cleans up stale symlinks whose targets still exist", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "current-skill");
    const staleDir = await writeSkillDir(skillParent, "stale-skill");

    fsSync.symlinkSync(staleDir, path.join(managedDir, "stale-skill"), directorySymlinkType);

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

  it("cleans up broken symlinks (dangling)", async () => {
    const skillParent = await tempDirs.make("plugin-skills-");
    const managedDir = await tempDirs.make("managed-skills-");

    const dir = await writeSkillDir(skillParent, "current-skill");
    const nonexistentDir = path.join(skillParent, "nonexistent");

    // Create a symlink to a nonexistent directory.
    fsSync.symlinkSync(nonexistentDir, path.join(managedDir, "broken-skill"), directorySymlinkType);

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
