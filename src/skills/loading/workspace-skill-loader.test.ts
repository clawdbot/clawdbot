// Workspace skill loader tests cover source merging, metadata, filtering, and precedence.
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { setCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import { clearCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-state.js";
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
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

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

function loadTestWorkspaceSkills(
  workspaceDir: string,
  opts?: Parameters<typeof loadWorkspaceSkills>[1],
) {
  setWorkspacePluginMetadataSnapshot(workspaceDir, opts?.config);
  return loadWorkspaceSkills(workspaceDir, {
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
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "open-prose");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "open-prose",
    skillId: "prose",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir };
}

describe("loadWorkspaceSkills", () => {
  it("filters plugin-shipped skills through plugin config", async () => {
    const { workspaceDir, managedDir } = await setupWorkspaceWithProsePlugin();

    const enabledEntries = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        plugins: {
          entries: { "open-prose": { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
    });

    expect(enabledEntries.map((entry) => entry.skill.name)).toContain("prose");

    const blockedEntries = loadTestWorkspaceSkills(workspaceDir, {
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

    const enabledEntries = loadTestWorkspaceSkills(workspaceDir, {
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

    const blockedEntries = loadTestWorkspaceSkills(workspaceDir, {
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

    const entries = loadTestWorkspaceSkills(workspaceDir);

    expect(entries.map((entry) => entry.skill.name)).toContain("fallback-name");
    expect(entries.map((entry) => entry.skill.name)).toContain("bom-skill");
    const hiddenEntry = entries.find((entry) => entry.skill.name === "hidden-skill");

    expect(hiddenEntry?.invocation?.disableModelInvocation).toBe(true);
    expect(hiddenEntry?.exposure?.includeInAvailableSkillsPrompt).toBe(false);
  });

  it("loads workspace metadata with JSON5-style trailing commas", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "json5-metadata");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: json5-metadata
description: JSON5-style metadata
metadata:
  {
    "openclaw":
      {
        "requires":
          {
            "env": ["EXAMPLE_VAR"],
          },
      },
  }
---
`,
      "utf8",
    );

    const entry = loadTestWorkspaceSkills(workspaceDir).find(
      (candidate) => candidate.skill.name === "json5-metadata",
    );

    expect(entry?.metadata?.requires?.env).toEqual(["EXAMPLE_VAR"]);
  });

  it("warns for malformed files and keeps loading sibling workspace skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const brokenDir = path.join(workspaceDir, "skills", "broken");
    const brokenFile = path.join(brokenDir, "SKILL.md");
    const unterminatedDir = path.join(workspaceDir, "skills", "unterminated");
    const unterminatedFile = path.join(unterminatedDir, "SKILL.md");
    await fs.mkdir(brokenDir, { recursive: true });
    await fs.mkdir(unterminatedDir, { recursive: true });
    await fs.writeFile(
      brokenFile,
      `---
name: [broken
description: Broken skill
---
`,
      "utf8",
    );
    await fs.writeFile(
      unterminatedFile,
      "---\nname: unterminated\ndescription: Missing closing delimiter\n",
      "utf8",
    );
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "valid"),
      name: "valid",
      description: "Valid sibling",
    });
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir);
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(entries.map((entry) => entry.skill.name)).toContain("valid");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("broken");
    expect(warningText).toContain(brokenFile);
    expect(warningText).toContain("invalid frontmatter: BAD_INDENT");
    expect(entries.map((entry) => entry.skill.name)).not.toContain("unterminated");
    expect(warningText).toContain(unterminatedFile);
    expect(warningText).toContain(
      "invalid frontmatter: UNTERMINATED_FRONTMATTER: missing closing --- delimiter",
    );
  });

  it("applies agent skill filters and replacement semantics", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeWorkspaceSkills(workspaceDir, [
      { name: "github", description: "GitHub" },
      { name: "weather", description: "Weather" },
      { name: "docs-search", description: "Docs" },
    ]);

    const defaultEntries = loadTestWorkspaceSkills(workspaceDir, {
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

    const replacementEntries = loadTestWorkspaceSkills(workspaceDir, {
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

    const entries = loadTestWorkspaceSkills(workspaceDir, {
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

  it("filters remote-ineligible skills when no agent skill filter is active", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "local-only"),
      name: "local-only",
      description: "Always available",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "remote-only"),
      name: "remote-only",
      description: "Needs a remote bin",
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
    });

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: "sandbox",
        },
      },
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["local-only"]);
  });
});
