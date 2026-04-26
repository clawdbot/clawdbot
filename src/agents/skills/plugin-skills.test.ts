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

const hoisted = vi.hoisted(() => {
  const loadManifestRegistry = vi.fn();
  return {
    loadPluginManifestRegistryForInstalledIndex: loadManifestRegistry,
    loadPluginManifestRegistryForPluginRegistry: loadManifestRegistry,
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

let resolvePluginSkillDirs: typeof import("./plugin-skills.js").resolvePluginSkillDirs;

const tempDirs = createTrackedTempDirs();

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

    expect(dirs).toEqual([]);
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
