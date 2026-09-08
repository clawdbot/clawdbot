// Workspace precedence tests cover precedence between workspace, plugin, and bundled skills.
import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { withEnv } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { OpenClawSkillMetadata, SkillEntry } from "../types.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { createSyntheticSourceInfo } from "./skill-contract.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const buildWorkspaceSkillsPrompt = (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): string => buildSkillSnapshot(workspaceDir, opts).prompt;

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

const fixtureSuite = createFixtureSuite("openclaw-skills-prompt-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

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

function captureJsonWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn", consoleStyle: "json" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

function createSkillEntry(params: {
  name: string;
  description?: string;
  metadata?: OpenClawSkillMetadata;
}): SkillEntry {
  const filePath = `/skills/${params.name}/SKILL.md`;
  return {
    skill: {
      name: params.name,
      description: params.description ?? params.name,
      filePath,
      source: "project",
      baseDir: path.dirname(filePath),
      sourceInfo: createSyntheticSourceInfo(filePath, { source: "project" }),
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: params.metadata,
  };
}

describe("buildWorkspaceSkillsPrompt", () => {
  it("prefers workspace skills over managed skills", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedSkillDir = path.join(managedDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    const workspaceSkillDir = path.join(workspaceDir, "skills", "demo-skill");

    await writeSkill({
      dir: bundledSkillDir,
      name: "demo-skill",
      description: "Bundled version",
      body: "# Bundled\n",
    });
    await writeSkill({
      dir: managedSkillDir,
      name: "demo-skill",
      description: "Managed version",
      body: "# Managed\n",
    });
    await writeSkill({
      dir: workspaceSkillDir,
      name: "demo-skill",
      description: "Workspace version",
      body: "# Workspace\n",
    });

    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: managedDir,
        bundledSkillsDir: bundledDir,
      }),
    );

    expect(prompt).toContain("Workspace version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
  });

  it("loads Workshop skills below managed and above bundled", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workshop-precedence");
    const managedDir = path.join(workspaceDir, ".managed");
    const config = {
      agents: { entries: { main: { agentDir: path.join(workspaceDir, ".agent") } } },
    };
    const workshopDir = resolveWorkshopSkillsDir(config, "main");
    const bundledDir = path.join(workspaceDir, ".bundled");
    for (const [root, name, description] of [
      [managedDir, "managed-wins", "Managed version"],
      [workshopDir, "managed-wins", "Workshop version below managed"],
      [workshopDir, "workshop-wins", "Workshop version"],
      [bundledDir, "workshop-wins", "Bundled version below Workshop"],
    ] as const) {
      await writeSkill({ dir: path.join(root, name), name, description });
    }

    const entries = loadWorkspaceSkills(workspaceDir, {
      config,
      agentId: "main",
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
      pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    });

    expect(entries.find((entry) => entry.skill.name === "managed-wins")?.skill).toMatchObject({
      source: "openclaw-managed",
      description: "Managed version",
    });
    expect(entries.find((entry) => entry.skill.name === "workshop-wins")?.skill).toMatchObject({
      source: "openclaw-workshop",
      description: "Workshop version",
    });
  });

  it("keeps extraDirs below bundled precedence and reports the collision", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("extra-bundled-collision");
    const extraDir = path.join(workspaceDir, ".extra");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraSkillDir = path.join(extraDir, "demo-skill");
    const bundledSkillDir = path.join(bundledDir, "demo-skill");
    await writeSkill({
      dir: extraSkillDir,
      name: "demo-skill",
      description: "Extra version",
    });
    await writeSkill({
      dir: bundledSkillDir,
      name: "demo-skill",
      description: "Bundled version",
    });
    const warn = captureWarningLogger();

    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: bundledDir,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { load: { extraDirs: [extraDir] } } },
      }),
    );
    const warningText = warn.mock.calls.flat().map(String).join("\n");

    expect(prompt).toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(warningText).toContain('skill="demo-skill"');
    expect(warningText).toContain("winner=openclaw-bundled:~/.bundled/demo-skill/SKILL.md");
    expect(warningText).toContain("loser=openclaw-extra:~/.extra/demo-skill/SKILL.md");
  });

  it("reports execution-directory collisions while keeping workspace precedence", async () => {
    const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-workspace-collision");
    const executionWorkspaceDir = await fixtureSuite.createCaseDir("execution-workspace-collision");
    const workspaceSkillFile = path.join(agentWorkspaceDir, "skills", "demo-skill", "SKILL.md");
    const executionSkillFile = path.join(executionWorkspaceDir, "skills", "demo-skill", "SKILL.md");
    await writeSkill({
      dir: path.dirname(workspaceSkillFile),
      name: "demo-skill",
      description: "Workspace version",
    });
    await writeSkill({
      dir: path.dirname(executionSkillFile),
      name: "demo-skill",
      description: "Execution version",
    });
    const warn = captureJsonWarningLogger();

    const loadOptions = {
      agentWorkspaceDir,
      executionWorkspaceDir,
      managedSkillsDir: path.join(agentWorkspaceDir, ".managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(agentWorkspaceDir, ".plugin-skills"),
    };
    const entries = loadWorkspaceSkills(agentWorkspaceDir, loadOptions);
    const warning = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;

    expect(entries.find((entry) => entry.skill.name === "demo-skill")?.skill.description).toBe(
      "Workspace version",
    );
    expect(warning).toMatchObject({
      message: "Skill precedence collision resolved.",
      skill: "demo-skill",
      winnerPath: workspaceSkillFile,
      loserPath: executionSkillFile,
    });

    loadWorkspaceSkills(agentWorkspaceDir, loadOptions);
    expect(warn).toHaveBeenCalledOnce();

    bumpSkillsSnapshotVersion({ workspaceDir: agentWorkspaceDir, reason: "watch" });
    loadWorkspaceSkills(agentWorkspaceDir, loadOptions);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not report execution-directory collisions for the same canonical skill file", async () => {
    const agentWorkspaceDir = await fixtureSuite.createCaseDir("agent-workspace-symlink");
    const executionWorkspaceDir = await fixtureSuite.createCaseDir("execution-workspace-symlink");
    const workspaceSkillsDir = path.join(agentWorkspaceDir, "skills");
    await writeSkill({
      dir: path.join(workspaceSkillsDir, "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
    });
    await fs.symlink(
      workspaceSkillsDir,
      path.join(executionWorkspaceDir, "skills"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const warn = captureWarningLogger();

    const entries = loadWorkspaceSkills(agentWorkspaceDir, {
      executionWorkspaceDir,
      managedSkillsDir: path.join(agentWorkspaceDir, ".managed"),
      bundledSkillsDir: "",
      pluginSkillsDir: path.join(agentWorkspaceDir, ".plugin-skills"),
    });

    expect(entries.filter((entry) => entry.skill.name === "demo-skill")).toHaveLength(1);
    expect(warn).not.toHaveBeenCalled();
  });
  it("gates by bins, config, and always", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const entries = [
      createSkillEntry({
        name: "bin-skill",
        description: "Needs a bin",
        metadata: { requires: { bins: ["fakebin"] } },
      }),
      createSkillEntry({
        name: "anybin-skill",
        description: "Needs any bin",
        metadata: { requires: { anyBins: ["missingbin", "fakebin"] } },
      }),
      createSkillEntry({
        name: "config-skill",
        description: "Needs config",
        metadata: { requires: { config: ["browser.enabled"] } },
      }),
      createSkillEntry({
        name: "always-skill",
        description: "Always on",
        metadata: { always: true, requires: { env: ["MISSING"] } },
      }),
      createSkillEntry({
        name: "env-skill",
        description: "Needs env",
        metadata: { requires: { env: ["ENV_KEY"] }, primaryEnv: "ENV_KEY" },
      }),
    ];

    const managedSkillsDir = path.join(workspaceDir, ".managed");
    const defaultPrompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        entries,
        managedSkillsDir,
        eligibility: {
          remote: {
            platforms: ["linux"],
            hasBin: () => false,
            hasAnyBin: () => false,
            note: "",
          },
        },
      }),
    );
    expect(defaultPrompt).toContain("always-skill");
    expect(defaultPrompt).toContain("config-skill");
    expect(defaultPrompt).not.toContain("bin-skill");
    expect(defaultPrompt).not.toContain("anybin-skill");
    expect(defaultPrompt).not.toContain("env-skill");

    const gatedPrompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        entries,
        managedSkillsDir,
        config: {
          browser: { enabled: false },
          skills: { entries: { "env-skill": { apiKey: "ok" } } }, // pragma: allowlist secret
        },
        eligibility: {
          remote: {
            platforms: ["linux"],
            hasBin: (bin: string) => bin === "fakebin",
            hasAnyBin: (bins: string[]) => bins.includes("fakebin"),
            note: "",
          },
        },
      }),
    );
    expect(gatedPrompt).toContain("bin-skill");
    expect(gatedPrompt).toContain("anybin-skill");
    expect(gatedPrompt).toContain("env-skill");
    expect(gatedPrompt).toContain("always-skill");
    expect(gatedPrompt).not.toContain("config-skill");
  });
  it("uses skillKey for config lookups", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        entries: [
          createSkillEntry({
            name: "alias-skill",
            description: "Uses skillKey",
            metadata: { skillKey: "alias" },
          }),
        ],
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { entries: { alias: { enabled: false } } } },
      }),
    );
    expect(prompt).not.toContain("alias-skill");
  });

  it("uses the canonical skillKey for session overrides while filtering agents by skill name", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        entries: [
          createSkillEntry({
            name: "alias-skill",
            metadata: { skillKey: "canonical-alias" },
          }),
        ],
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        skillFilter: ["alias-skill"],
        skillOverrides: { "canonical-alias": false },
      }),
    );

    expect(prompt).not.toContain("alias-skill");
  });
});
