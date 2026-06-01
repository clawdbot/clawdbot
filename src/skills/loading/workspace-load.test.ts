import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import {
  clearCurrentPluginMetadataSnapshot,
  setCurrentPluginMetadataSnapshot,
} from "../../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../../plugins/installed-plugin-index-policy.js";
import type {
  PluginManifestRecord,
  PluginManifestRegistry,
} from "../../plugins/manifest-registry.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import { writeSkill, writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { readSkillFrontmatterSafe } from "./local-loader.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

vi.mock("../../plugins/manifest-registry.js", async () => {
  const fsLocal = await import("node:fs");
  const pathLocal = await import("node:path");
  return {
    loadPluginManifestRegistry: (params: { workspaceDir?: string }) => {
      const extensionsRoot = pathLocal.join(params.workspaceDir ?? "", ".openclaw", "extensions");
      const plugins = [];
      for (const id of ["open-prose", "browser"]) {
        const rootDir = pathLocal.join(extensionsRoot, id);
        const manifestPath = pathLocal.join(rootDir, "openclaw.plugin.json");
        if (!fsLocal.existsSync(manifestPath)) {
          continue;
        }
        const manifest = JSON.parse(fsLocal.readFileSync(manifestPath, "utf8")) as {
          enabledByDefault?: boolean;
          skills?: string[];
        };
        plugins.push({
          id,
          origin: id === "browser" ? "bundled" : "workspace",
          enabledByDefault: manifest.enabledByDefault,
          providers: [],
          legacyPluginIds: [],
          kind: [],
          skills: manifest.skills ?? ["./skills"],
          rootDir,
        });
      }
      return { plugins, diagnostics: [] };
    },
  };
});

let fakeHome = "";
let envSnapshot: SkillsHomeEnvSnapshot;
let tempRoot = "";
let workspaceCaseIndex = 0;

function createWorkspacePluginRegistry(workspaceDir: string): PluginManifestRegistry {
  const extensionsRoot = path.join(workspaceDir, ".openclaw", "extensions");
  const plugins: PluginManifestRecord[] = [];
  for (const id of ["open-prose", "browser"]) {
    const rootDir = path.join(extensionsRoot, id);
    const manifestPath = path.join(rootDir, "openclaw.plugin.json");
    if (!fsSync.existsSync(manifestPath)) {
      continue;
    }
    const manifest = JSON.parse(fsSync.readFileSync(manifestPath, "utf8")) as {
      id?: string;
      enabledByDefault?: boolean;
      skills?: string[];
      configSchema?: Record<string, unknown>;
    };
    plugins.push({
      id: manifest.id ?? id,
      origin: id === "browser" ? "bundled" : "workspace",
      enabledByDefault: manifest.enabledByDefault,
      channels: [],
      providers: [],
      cliBackends: [],
      legacyPluginIds: [],
      kind: [],
      skills: manifest.skills ?? ["./skills"],
      hooks: [],
      rootDir,
      source: rootDir,
      manifestPath,
      configSchema: manifest.configSchema,
    });
  }
  return { plugins, diagnostics: [] };
}

function createWorkspacePluginMetadataSnapshot(params: {
  workspaceDir: string;
  config?: OpenClawConfig;
  manifestRegistry: PluginManifestRegistry;
}): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(params.config);
  const ownerMaps = {
    channels: new Map(),
    channelConfigs: new Map(),
    providers: new Map(),
    modelCatalogProviders: new Map(),
    cliBackends: new Map(),
    setupProviders: new Map(),
    commandAliases: new Map(),
    contracts: new Map(),
  };
  return {
    policyHash,
    workspaceDir: params.workspaceDir,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 1,
      installRecords: {},
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: params.manifestRegistry,
    plugins: params.manifestRegistry.plugins,
    diagnostics: params.manifestRegistry.diagnostics,
    byPluginId: new Map(params.manifestRegistry.plugins.map((plugin) => [plugin.id, plugin])),
    normalizePluginId: (pluginId) => pluginId,
    owners: ownerMaps,
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: params.manifestRegistry.plugins.length,
    },
  };
}

function setWorkspacePluginMetadataSnapshot(workspaceDir: string, config?: OpenClawConfig): void {
  const manifestRegistry = createWorkspacePluginRegistry(workspaceDir);
  setCurrentPluginMetadataSnapshot(
    createWorkspacePluginMetadataSnapshot({
      workspaceDir,
      manifestRegistry,
      ...(config === undefined ? {} : { config }),
    }),
    {
      workspaceDir,
      ...(config === undefined ? {} : { config }),
    },
  );
}

function collectMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T[] {
  const matches: T[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(item);
    }
  }
  return matches;
}

async function expectMissingPath(pathToCheck: string) {
  let thrown: unknown;
  try {
    await fs.lstat(pathToCheck);
  } catch (error) {
    thrown = error;
  }
  expect((thrown as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
}

async function createTempWorkspaceDir() {
  const workspaceDir = path.join(tempRoot, `workspace-${++workspaceCaseIndex}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

function firstWarningLine(warn: ReturnType<typeof vi.fn>): string {
  const [line] = warn.mock.calls[0] ?? [];
  return String(line);
}

function loadTestWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: Parameters<typeof loadWorkspaceSkillEntries>[1],
) {
  setWorkspacePluginMetadataSnapshot(workspaceDir, opts?.config);
  return loadWorkspaceSkillEntries(workspaceDir, {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    ...opts,
  });
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-workspace-"));
  fakeHome = path.join(tempRoot, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  envSnapshot = setMockSkillsHomeEnv(fakeHome);
});

afterEach(async () => {
  clearCurrentPluginMetadataSnapshot();
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

afterAll(async () => {
  await restoreMockSkillsHomeEnv(envSnapshot, async () => {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  });
});

async function setupWorkspaceWithProsePlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "open-prose");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "open-prose",
    skillId: "prose",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir, bundledDir };
}

async function createEscapedBundledSkillFixture(params?: {
  workspaceDir?: string;
  outsideDir?: string;
}) {
  const workspaceDir = params?.workspaceDir ?? (await createTempWorkspaceDir());
  const outsideDir = params?.outsideDir ?? (await createTempWorkspaceDir());
  const bundledDir = path.join(workspaceDir, ".bundled");
  const escapedSkillDir = path.join(outsideDir, "outside-bundled-skill");
  await writeSkill({
    dir: escapedSkillDir,
    name: "outside-bundled-skill",
    description: "Outside bundled",
  });
  await fs.mkdir(bundledDir, { recursive: true });
  const requestedPath = path.join(bundledDir, "escaped-bundled-skill");
  await fs.symlink(escapedSkillDir, requestedPath, "dir");
  return { workspaceDir, outsideDir, bundledDir, escapedSkillDir, requestedPath };
}

describe("loadWorkspaceSkillEntries", () => {
  it("filters plugin-shipped skills through plugin config", async () => {
    const { workspaceDir, managedDir } = await setupWorkspaceWithProsePlugin();

    const enabledEntries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { "open-prose": { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(enabledEntries.map((entry) => entry.skill.name)).toContain("prose");

    const blockedEntries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          allow: ["something-else"],
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(blockedEntries.map((entry) => entry.skill.name)).not.toContain("prose");
  });

  it("loads the browser plugin automation skill when the bundled plugin is enabled", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "browser");

    await writePluginWithSkill({
      pluginRoot,
      pluginId: "browser",
      skillId: "browser-automation",
      skillDescription: "Browser automation",
    });
    await fs.writeFile(
      path.join(pluginRoot, "openclaw.plugin.json"),
      JSON.stringify(
        {
          id: "browser",
          enabledByDefault: true,
          skills: ["./skills"],
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        },
        null,
        2,
      ),
      "utf8",
    );

    const enabledEntries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {},
      managedSkillsDir: managedDir,
    });

    const browserEntry = enabledEntries.find((entry) => entry.skill.name === "browser-automation");
    const browserSkillDir = path.join(pluginRoot, "skills", "browser-automation");
    expect(browserEntry?.skill.baseDir).toBe(
      path.join(workspaceDir, ".plugin-skills", "browser-automation"),
    );
    expect(browserEntry?.skill.filePath).toBe(
      path.join(workspaceDir, ".plugin-skills", "browser-automation", "SKILL.md"),
    );
    await expect(
      fs.readlink(path.join(workspaceDir, ".plugin-skills", "browser-automation")),
    ).resolves.toBe(browserSkillDir);

    const blockedEntries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { browser: { enabled: false } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(blockedEntries.map((entry) => entry.skill.name)).not.toContain("browser-automation");
    await expectMissingPath(path.join(workspaceDir, ".plugin-skills", "browser-automation"));
  });

  it("loads frontmatter edge cases in one workspace", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "fallback-name");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "description: Skill without explicit name", "---", "", "# Fallback"].join("\n"),
      "utf8",
    );
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      name: "hidden-skill",
      description: "Hidden prompt entry",
      frontmatterExtra: "disable-model-invocation: true",
    });
    const bomSkillDir = path.join(workspaceDir, "skills", "bom-skill");
    await fs.mkdir(bomSkillDir, { recursive: true });
    await fs.writeFile(
      path.join(bomSkillDir, "SKILL.md"),
      "\uFEFF---\nname: bom-skill\ndescription: BOM-prefixed skill\n---\n\n# BOM skill\n",
      "utf8",
    );

    const entries = loadTestWorkspaceSkillEntries(workspaceDir);

    expect(entries.map((entry) => entry.skill.name)).toContain("fallback-name");
    expect(entries.map((entry) => entry.skill.name)).toContain("bom-skill");
    const hiddenEntry = entries.find((entry) => entry.skill.name === "hidden-skill");

    expect(hiddenEntry?.invocation?.disableModelInvocation).toBe(true);
    expect(hiddenEntry?.exposure?.includeInAvailableSkillsPrompt).toBe(false);
  });

  it("applies agent skill filters and replacement semantics", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "github", description: "GitHub" },
      { name: "weather", description: "Weather" },
      { name: "docs-search", description: "Docs" },
    ]);

    const defaultEntries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      agentId: "writer",
    });

    expect(defaultEntries.map((entry) => entry.skill.name)).toEqual(["github"]);

    const replacementEntries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      agentId: "writer",
    });

    expect(replacementEntries.map((entry) => entry.skill.name)).toEqual(["docs-search"]);
  });

  it("keeps remote-eligible skills when agent filtering is active", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "remote-only"),
      name: "remote-only",
      description: "Needs a remote bin",
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
    });

    const entries = loadTestWorkspaceSkillEntries(workspaceDir, {
      config: {
        agents: {
          defaults: {
            skills: ["remote-only"],
          },
          list: [{ id: "writer" }],
        },
      },
      agentId: "writer",
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      },
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["remote-only"]);
  });

  it.runIf(process.platform !== "win32")(
    "skips workspace skill paths that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      const escapedSkillDir = path.join(outsideDir, "outside-skill");
      await writeSkill({
        dir: escapedSkillDir,
        name: "outside-skill",
        description: "Outside",
      });
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const requestedPath = path.join(workspaceDir, "skills", "escaped-skill");
      await fs.symlink(escapedSkillDir, requestedPath, "dir");
      const fileLinkSkillDir = path.join(workspaceDir, "skills", "escaped-file");
      await fs.mkdir(fileLinkSkillDir, { recursive: true });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(fileLinkSkillDir, "SKILL.md"));
      const targetDir = path.join(workspaceDir, "safe-target");
      await writeSkill({
        dir: targetDir,
        name: "symlink-target",
        description: "Target skill",
      });
      const symlinkedSkillDir = path.join(workspaceDir, "skills", "symlinked");
      await fs.mkdir(symlinkedSkillDir, { recursive: true });
      await fs.symlink(path.join(targetDir, "SKILL.md"), path.join(symlinkedSkillDir, "SKILL.md"));
      const warn = captureWarningLogger();

      const entries = loadTestWorkspaceSkillEntries(workspaceDir);

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
      expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
      const warningLine = firstWarningLine(warn);
      expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
      expect(warningLine).toContain("reason=symlink-escape");
      expect(warningLine).toContain("source=openclaw-workspace");
      expect(warningLine).toContain(`root=${path.join(workspaceDir, "skills")}`);
      expect(warningLine).toContain(`requested=${requestedPath}`);
      expect(warningLine).toContain("resolved=");
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows configured skill symlink targets outside their source root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillName = `manager-${++workspaceCaseIndex}`;
      const targetRoot = path.join(tempRoot, `${skillName}-skills`);
      const targetSkillDir = path.join(targetRoot, skillName);
      await writeSkill({
        dir: targetSkillDir,
        name: skillName,
        description: "Manager skill",
      });
      const workspaceSkillsDir = path.join(workspaceDir, "skills");
      await fs.mkdir(workspaceSkillsDir, { recursive: true });
      const symlinkPath = path.join(workspaceSkillsDir, skillName);
      await fs.symlink(targetSkillDir, symlinkPath, "dir");
      const warn = captureWarningLogger();

      try {
        const entries = loadTestWorkspaceSkillEntries(workspaceDir, {
          config: {
            skills: {
              load: {
                allowSymlinkTargets: [targetRoot],
              },
            },
          },
        });

        expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await fs.unlink(symlinkPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "loads managed skill directory symlinks outside the managed root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const managedDir = path.join(workspaceDir, ".managed");
      const skillName = `managed-${++workspaceCaseIndex}`;
      const targetSkillDir = path.join(tempRoot, `${skillName}-target`, skillName);
      await writeSkill({
        dir: targetSkillDir,
        name: skillName,
        description: "Managed symlink target",
      });
      await fs.mkdir(managedDir, { recursive: true });
      const symlinkPath = path.join(managedDir, skillName);
      await fs.symlink(targetSkillDir, symlinkPath, "dir");
      const warn = captureWarningLogger();

      try {
        const entries = loadTestWorkspaceSkillEntries(workspaceDir, {
          managedSkillsDir: managedDir,
        });

        expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await fs.unlink(symlinkPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps SKILL.md containment for managed symlinked skill directories",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const managedDir = path.join(workspaceDir, ".managed");
      const skillName = `managed-file-link-${++workspaceCaseIndex}`;
      const targetSkillDir = path.join(tempRoot, `${skillName}-target`, skillName);
      const outsideDir = path.join(tempRoot, `${skillName}-outside`);
      await fs.mkdir(targetSkillDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await writeSkill({
        dir: outsideDir,
        name: skillName,
        description: "Escaped metadata",
      });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(targetSkillDir, "SKILL.md"));
      await fs.mkdir(managedDir, { recursive: true });
      const symlinkPath = path.join(managedDir, skillName);
      await fs.symlink(targetSkillDir, symlinkPath, "dir");
      const warn = captureWarningLogger();

      try {
        const entries = loadTestWorkspaceSkillEntries(workspaceDir, {
          managedSkillsDir: managedDir,
        });

        expect(entries.map((entry) => entry.skill.name)).not.toContain(skillName);
        const warningLine = firstWarningLine(warn);
        expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
        expect(warningLine).toContain("source=openclaw-managed");
        expect(warningLine).toContain("reason=symlink-escape");
      } finally {
        await fs.unlink(symlinkPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "calls out bundled symlink escapes with compact home-relative paths",
    async () => {
      const { workspaceDir, bundledDir, requestedPath } = await createEscapedBundledSkillFixture();
      const warn = captureWarningLogger();

      const entries = loadTestWorkspaceSkillEntries(workspaceDir, {
        bundledSkillsDir: bundledDir,
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-bundled-skill");
      const warningLine = firstWarningLine(warn);
      expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
      expect(warningLine).toContain("source=openclaw-bundled");
      expect(warningLine).toContain("reason=bundled-symlink-escape");
      expect(warningLine).toContain("hint=likely-stray-local-symlink-or-checkout-mutation");
      expect(warningLine).toContain(`requested=${requestedPath}`);
      expect(warningLine).toContain("resolved=");
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses compact home-relative paths in escaped skill console warnings",
    async () => {
      const { workspaceDir, bundledDir } = await createEscapedBundledSkillFixture({
        workspaceDir: path.join(fakeHome, "workspace"),
        outsideDir: path.join(fakeHome, "outside"),
      });
      const warn = captureWarningLogger();

      loadTestWorkspaceSkillEntries(workspaceDir, {
        bundledSkillsDir: bundledDir,
      });

      const warningLine = firstWarningLine(warn);
      expect(warningLine).toContain("root=~/workspace/.bundled");
      expect(warningLine).toContain("requested=~/workspace/.bundled/escaped-bundled-skill");
      expect(warningLine).toContain("resolved=~/outside/outside-bundled-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads skill frontmatter when the allowed root is the filesystem root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillDir = path.join(workspaceDir, "skills", "root-allowed");
      await writeSkill({
        dir: skillDir,
        name: "root-allowed",
        description: "Readable from filesystem root",
      });

      const frontmatter = readSkillFrontmatterSafe({
        rootDir: path.parse(skillDir).root,
        filePath: path.join(skillDir, "SKILL.md"),
      });

      expect(frontmatter?.name).toBe("root-allowed");
      expect(frontmatter?.description).toBe("Readable from filesystem root");
    },
  );

  describe("nested skill subdirectories", () => {
    it("discovers SKILL.md two levels deep under a grouping subfolder", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      // Grouped layout: skills/group/skill/SKILL.md (no SKILL.md at skills/group/).
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "group", "nested-skill"),
        name: "nested-skill",
        description: "Nested under a group folder",
      });

      const entries = loadTestWorkspaceSkillEntries(workspaceDir);
      const names = entries.map((entry) => entry.skill.name);
      expect(names).toContain("nested-skill");
    });

    it("keeps loading direct skills (skills/skill/SKILL.md) unchanged", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "direct-skill"),
        name: "direct-skill",
        description: "Direct skill at first level",
      });
      // Sibling group with a deeper skill.
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "group", "grouped-skill"),
        name: "grouped-skill",
        description: "Skill nested under a group",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir).map((entry) => entry.skill.name);
      expect(names).toContain("direct-skill");
      expect(names).toContain("grouped-skill");
    });

    it("does not count invalid grouped candidates against the loaded skill cap", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      for (const nestedName of ["a", "b"]) {
        const invalidDir = path.join(workspaceDir, "skills", "00-group", nestedName);
        await fs.mkdir(invalidDir, { recursive: true });
        await fs.writeFile(
          path.join(invalidDir, "SKILL.md"),
          `---\nname: ${nestedName}\n---\n\n# Invalid\n`,
          "utf-8",
        );
      }
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "01-valid"),
        name: "valid-skill",
        description: "Valid sibling after invalid grouped candidates",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxCandidatesPerRoot: 10,
              maxSkillsLoadedPerSource: 1,
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toEqual(["valid-skill"]);
    });

    it("loads earlier grouped skills before later direct siblings hit the source cap", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "00-group", "grouped"),
        name: "grouped-skill",
        description: "Grouped skill before direct siblings",
      });
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "01-direct"),
        name: "direct-skill",
        description: "Direct sibling after grouped skill",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxCandidatesPerRoot: 10,
              maxSkillsLoadedPerSource: 1,
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toEqual(["grouped-skill"]);
    });

    it("keeps later grouped siblings discoverable when an earlier group is noisy", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      async function createNoisyTree(dir: string, depth: number): Promise<void> {
        if (depth === 0) {
          return;
        }
        for (const name of ["00-a", "01-b"]) {
          const childDir = path.join(dir, name);
          await fs.mkdir(childDir, { recursive: true });
          await createNoisyTree(childDir, depth - 1);
        }
      }
      await createNoisyTree(path.join(workspaceDir, "skills", "00-noisy"), 6);
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "01-later", "later-skill"),
        name: "later-skill",
        description: "Grouped sibling after a noisy tree",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxCandidatesPerRoot: 2,
              maxSkillsLoadedPerSource: 10,
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("later-skill");
    });

    it("discovers deeply nested SKILL.md files within the Codex-compatible depth", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "a", "b", "c"),
        name: "deep-skill",
        description: "Discovered through grouped folders",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir).map((entry) => entry.skill.name);
      expect(names).toContain("deep-skill");
    });

    it("discovers deeply nested skills in configured roots named skills", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const parentDir = await createTempWorkspaceDir();
      const skillsDir = path.join(parentDir, "skills");
      await writeSkill({
        dir: path.join(skillsDir, "d0", "d1", "d2", "d3", "d4", "d5"),
        name: "configured-deep-skill",
        description: "Depth 6 from configured skills root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillsDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("configured-deep-skill");
    });

    it("uses the nested skills folder as the depth root for repo-style extra dirs", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(repoDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
        name: "repo-depth-skill",
        description: "Depth 6 from nested skills root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [repoDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("repo-depth-skill");
    });

    it("ignores invalid outside candidates when resolving repo-style extra dirs", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      await fs.mkdir(path.join(repoDir, "examples", "bad"), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, "examples", "bad", "SKILL.md"),
        "---\nname: bad\n---\n",
      );
      await writeSkill({
        dir: path.join(repoDir, "skills", "group", "valid"),
        name: "repo-nested-skill",
        description: "Valid nested repo skill",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [repoDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("repo-nested-skill");
      expect(names).not.toContain("bad");
    });

    it("ignores invalid root SKILL.md files when resolving repo-style extra dirs", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      await fs.writeFile(path.join(repoDir, "SKILL.md"), "---\nname: bad\n---\n");
      await writeSkill({
        dir: path.join(repoDir, "examples", "valid"),
        name: "outside-valid-skill",
        description: "Valid outside repo skill",
      });
      await writeSkill({
        dir: path.join(repoDir, "skills", "group", "valid"),
        name: "repo-nested-skill",
        description: "Valid nested repo skill",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [repoDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("repo-nested-skill");
      expect(names).not.toContain("outside-valid-skill");
      expect(names).not.toContain("bad");
    });

    it("treats invalid outside SKILL.md files as terminal during repo-root detection", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      await fs.mkdir(path.join(repoDir, "examples", "bad", "child"), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, "examples", "bad", "SKILL.md"),
        "---\nname: bad\n---\n",
      );
      await writeSkill({
        dir: path.join(repoDir, "examples", "bad", "child"),
        name: "outside-child",
        description: "Valid child hidden behind invalid terminal parent",
      });
      await writeSkill({
        dir: path.join(repoDir, "skills", "group", "valid"),
        name: "repo-nested-skill",
        description: "Valid nested repo skill",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [repoDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("repo-nested-skill");
      expect(names).not.toContain("outside-child");
    });

    it.runIf(process.platform !== "win32")(
      "does not follow outside symlink dirs during repo-root detection",
      async () => {
        const workspaceDir = await createTempWorkspaceDir();
        const repoDir = await createTempWorkspaceDir();
        const outsideDir = await createTempWorkspaceDir();
        await writeSkill({
          dir: path.join(outsideDir, "linked"),
          name: "outside-linked-skill",
          description: "Outside linked skill",
        });
        await fs.mkdir(path.join(repoDir, "examples"), { recursive: true });
        await fs.symlink(outsideDir, path.join(repoDir, "examples", "linked"), "dir");
        await writeSkill({
          dir: path.join(repoDir, "skills", "group", "valid"),
          name: "repo-nested-skill",
          description: "Valid nested repo skill",
        });

        const names = loadTestWorkspaceSkillEntries(workspaceDir, {
          config: {
            skills: {
              load: { extraDirs: [repoDir] },
            },
          },
        }).map((entry) => entry.skill.name);

        expect(names).toContain("repo-nested-skill");
        expect(names).not.toContain("outside-linked-skill");
      },
    );

    it.runIf(process.platform !== "win32")(
      "keeps configured roots with possible symlink skills outside nested skills",
      async () => {
        const workspaceDir = await createTempWorkspaceDir();
        const repoDir = await createTempWorkspaceDir();
        const targetRoot = path.join(tempRoot, `linked-root-${workspaceCaseIndex++}`);
        const targetSkillDir = path.join(targetRoot, "linked-skill");
        await writeSkill({
          dir: targetSkillDir,
          name: "linked-skill",
          description: "Allowed linked skill",
        });
        await fs.mkdir(path.join(repoDir, "group"), { recursive: true });
        await fs.symlink(targetSkillDir, path.join(repoDir, "group", "linked-skill"), "dir");
        await writeSkill({
          dir: path.join(repoDir, "skills", "group", "valid"),
          name: "repo-nested-skill",
          description: "Valid nested repo skill",
        });

        const names = loadTestWorkspaceSkillEntries(workspaceDir, {
          config: {
            skills: {
              load: {
                allowSymlinkTargets: [targetRoot],
                extraDirs: [repoDir],
              },
            },
          },
        }).map((entry) => entry.skill.name);

        expect(names).toContain("linked-skill");
        expect(names).toContain("repo-nested-skill");
      },
    );

    it("keeps a configured direct skill root even when it has nested skill fixtures", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: skillDir,
        name: "direct-root",
        description: "Configured direct skill root",
      });
      await writeSkill({
        dir: path.join(skillDir, "skills", "examples", "fixture"),
        name: "fixture-skill",
        description: "Nested fixture skill should not replace the root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("direct-root");
      expect(names).not.toContain("fixture-skill");
    });

    it("does not re-root extra dirs from ignored nested skill files", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(repoDir, "valid"),
        name: "valid-root-skill",
        description: "Direct child skill under configured root",
      });
      await writeSkill({
        dir: path.join(repoDir, "skills", "node_modules", "pkg"),
        name: "ignored-package-skill",
        description: "Ignored nested dependency fixture",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [repoDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("valid-root-skill");
      expect(names).not.toContain("ignored-package-skill");
    });

    it("keeps direct child skills when a configured root also has a skills child", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillRootDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(skillRootDir, "valid"),
        name: "valid-root-skill",
        description: "Direct child skill under configured root",
      });
      await writeSkill({
        dir: path.join(skillRootDir, "skills", "examples", "fixture"),
        name: "fixture-skill",
        description: "Nested fixture should not replace the configured root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillRootDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("valid-root-skill");
      expect(names).toContain("fixture-skill");
    });

    it("keeps nested skills when top-level candidate cap is filled by direct skills", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillRootDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(skillRootDir, "00-valid"),
        name: "valid-root-skill",
        description: "Direct child skill under configured root",
      });
      await writeSkill({
        dir: path.join(skillRootDir, "skills", "examples", "fixture"),
        name: "fixture-skill",
        description: "Nested fixture should still be scanned",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillRootDir] },
            limits: {
              maxCandidatesPerRoot: 1,
              maxSkillsLoadedPerSource: 10,
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("valid-root-skill");
      expect(names).toContain("fixture-skill");
    });

    it("keeps nested skills depth when a configured root also has direct skills", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillRootDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(skillRootDir, "valid"),
        name: "valid-root-skill",
        description: "Direct child skill under configured root",
      });
      await writeSkill({
        dir: path.join(skillRootDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
        name: "deep-nested-skill",
        description: "Depth 6 from nested skills root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillRootDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("valid-root-skill");
      expect(names).toContain("deep-nested-skill");
    });

    it("keeps configured root grouping outside skills within watcher depth", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillRootDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(skillRootDir, "group", "within-depth"),
        name: "within-depth",
        description: "Depth 2 from configured root",
      });
      await writeSkill({
        dir: path.join(skillRootDir, "group", "d1", "too-deep"),
        name: "too-deep",
        description: "Depth 3 from configured root",
      });
      await writeSkill({
        dir: path.join(skillRootDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
        name: "deep-nested-skill",
        description: "Depth 6 from nested skills root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillRootDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("within-depth");
      expect(names).toContain("deep-nested-skill");
      expect(names).not.toContain("too-deep");
    });

    it("keeps grouped child skills when a configured root also has a skills child", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillRootDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(skillRootDir, "group", "valid"),
        name: "valid-grouped-skill",
        description: "Grouped child skill under configured root",
      });
      await writeSkill({
        dir: path.join(skillRootDir, "skills", "examples", "fixture"),
        name: "fixture-skill",
        description: "Nested fixture should not replace the configured root",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            load: { extraDirs: [skillRootDir] },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("valid-grouped-skill");
      expect(names).toContain("fixture-skill");
    });

    it("does not descend beyond the bounded grouped skill depth", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
        name: "within-depth",
        description: "Depth 6 loads",
      });
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "e0", "e1", "e2", "e3", "e4", "e5", "e6"),
        name: "too-deep",
        description: "Depth 7 does not load",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir).map((entry) => entry.skill.name);
      expect(names).toContain("within-depth");
      expect(names).not.toContain("too-deep");
    });

    it("does not fall through to child skills when an immediate SKILL.md is invalid", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const parentDir = path.join(workspaceDir, "skills", "group", "parent");
      await fs.mkdir(parentDir, { recursive: true });
      await fs.writeFile(path.join(parentDir, "SKILL.md"), "---\nname: parent\n---\n", "utf-8");
      await writeSkill({
        dir: path.join(parentDir, "child"),
        name: "too-deep",
        description: "Should not be discovered through invalid parent fallback",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir).map((entry) => entry.skill.name);
      expect(names).not.toContain("too-deep");
    });

    it("treats an immediate SKILL.md as terminal and does not descend", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "group"),
        name: "group",
        description: "Direct skill at the group level",
      });
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "group", "inner"),
        name: "inner",
        description: "Should be ignored when parent is itself a skill",
      });

      const names = loadTestWorkspaceSkillEntries(workspaceDir).map((entry) => entry.skill.name);
      expect(names).toContain("group");
      expect(names).not.toContain("inner");
    });

    it("warns and caps discovery in large grouping subfolders", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      for (let i = 0; i < 3; i += 1) {
        const name = `nested-skill-${i}`;
        await writeSkill({
          dir: path.join(workspaceDir, "skills", "group", name),
          name,
          description: `Nested skill ${i}`,
        });
      }
      const warn = captureWarningLogger();

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxCandidatesPerRoot: 2,
              maxSkillsLoadedPerSource: 10,
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(
        names.reduce((count, name) => count + (name.startsWith("nested-skill-") ? 1 : 0), 0),
      ).toBe(2);
      expect(
        warn.mock.calls
          .map(([line]) => String(line))
          .some((line) =>
            line.includes("Nested skills directory has many entries, truncating discovery."),
          ),
      ).toBe(true);
    });

    it("does not spend nested candidate budget on ignored raw entries", async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const groupDir = path.join(workspaceDir, "skills", "group");
      await fs.mkdir(groupDir, { recursive: true });
      for (let i = 0; i < 50; i += 1) {
        await fs.writeFile(path.join(groupDir, `ignored-${String(i).padStart(2, "0")}.txt`), "");
      }
      for (const name of ["valid-a", "valid-b", "valid-c"]) {
        await writeSkill({
          dir: path.join(groupDir, name),
          name,
          description: `${name} nested under a group`,
        });
      }

      const names = loadTestWorkspaceSkillEntries(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxCandidatesPerRoot: 2,
              maxSkillsLoadedPerSource: 10,
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(collectMatching(names, (name) => name.startsWith("valid-"))).toEqual([
        "valid-a",
        "valid-b",
      ]);
    });
  });
});
