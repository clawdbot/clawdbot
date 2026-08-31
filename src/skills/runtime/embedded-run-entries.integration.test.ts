// Embedded run entry integration tests cover persisted runtime skill entries.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/config.js";
import { resolveSkillsPrompt } from "../loading/workspace-skill-prompt.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { writePluginWithSkill } from "../test-support/skill-plugin-fixtures.test-support.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";
import { resolveReusableWorkspaceSkillSnapshot } from "./session-snapshot.js";

const tempDirs = createTempDirTracker();
const originalBundledDir = process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;

function restoreBundledPluginsDir() {
  if (originalBundledDir === undefined) {
    delete process.env.OPENCLAW_BUNDLED_PLUGINS_DIR;
    return;
  }
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = originalBundledDir;
}

async function setupBundledDiffsPlugin() {
  const bundledPluginsDir = tempDirs.make("openclaw-bundled-");
  const workspaceDir = tempDirs.make("openclaw-workspace-");
  const pluginRoot = path.join(bundledPluginsDir, "diffs");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "diffs",
    skillId: "diffs",
    skillDescription: "runtime integration test",
  });

  return { bundledPluginsDir, workspaceDir };
}

async function resolveBundledDiffsSkillEntries(config?: OpenClawConfig) {
  const { bundledPluginsDir, workspaceDir } = await setupBundledDiffsPlugin();
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = bundledPluginsDir;

  return resolveEmbeddedRunSkillEntries({ workspaceDir, ...(config ? { config } : {}) });
}

afterEach(() => {
  restoreBundledPluginsDir();
  tempDirs.cleanup();
});

describe("resolveEmbeddedRunSkillEntries (integration)", () => {
  it("matches snapshot skill roots when a snapshot-less run uses a different execution directory", async () => {
    const agentWorkspaceDir = tempDirs.make("openclaw-agent-workspace-");
    const executionWorkspaceDir = tempDirs.make("openclaw-execution-workspace-");
    const executionSkillsDir = path.join(executionWorkspaceDir, "skills");
    for (const [workspaceDir, name, description] of [
      [agentWorkspaceDir, "fallback-agent", "Agent only"],
      [agentWorkspaceDir, "fallback-shared", "Agent wins"],
      [executionWorkspaceDir, "fallback-execution", "Execution only"],
      [executionWorkspaceDir, "fallback-shared", "Execution loses"],
    ] as const) {
      await writeSkill({
        dir: path.join(workspaceDir, "skills", name),
        name,
        description,
      });
    }
    const skillNames = ["fallback-agent", "fallback-shared", "fallback-execution"];
    const snapshot = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: agentWorkspaceDir,
      executionSkillsDir,
      config: {},
      skillFilter: skillNames,
      watch: false,
      snapshotVersion: 1,
    }).snapshot;

    const fallback = resolveEmbeddedRunSkillEntries({
      workspaceDir: agentWorkspaceDir,
      executionSkillsDir,
      config: {},
    });
    const fallbackSkills = fallback.skillEntries.filter((entry) =>
      skillNames.includes(entry.skill.name),
    );

    expect(fallbackSkills.map((entry) => entry.skill.name)).toEqual(
      snapshot.skills.map((skill) => skill.name),
    );
    expect(
      fallbackSkills.find((entry) => entry.skill.name === "fallback-shared")?.skill,
    ).toMatchObject({
      description: "Agent wins",
      filePath: path.join(agentWorkspaceDir, "skills", "fallback-shared", "SKILL.md"),
    });
  });

  it("keeps agent skills ahead of execution skills in a constrained fallback prompt", async () => {
    const agentWorkspaceDir = tempDirs.make("openclaw-agent-workspace-");
    const executionWorkspaceDir = tempDirs.make("openclaw-execution-workspace-");
    const executionSkillsDir = path.join(executionWorkspaceDir, "skills");
    const agentSkillName = "z-agent-priority";
    const executionSkillName = "a-execution-priority";
    await writeSkill({
      dir: path.join(agentWorkspaceDir, "skills", agentSkillName),
      name: agentSkillName,
      description: "Agent priority",
    });
    await writeSkill({
      dir: path.join(executionSkillsDir, executionSkillName),
      name: executionSkillName,
      description: "Execution priority",
    });
    const config: OpenClawConfig = { skills: { limits: { maxSkillsInPrompt: 1 } } };
    const snapshotPrompt = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: agentWorkspaceDir,
      executionSkillsDir,
      config,
      skillFilter: [agentSkillName, executionSkillName],
      watch: false,
      snapshotVersion: 1,
    }).snapshot.prompt;
    const fallback = resolveEmbeddedRunSkillEntries({
      workspaceDir: agentWorkspaceDir,
      executionSkillsDir,
      config,
      workspaceOnly: true,
    });
    const fallbackPrompt = resolveSkillsPrompt({
      entries: fallback.skillEntries,
      workspaceDir: agentWorkspaceDir,
      config,
      preserveEntryOrder: fallback.preserveEntryOrder,
    });

    expect(fallbackPrompt).toBe(snapshotPrompt);
    expect(fallbackPrompt).toContain(agentSkillName);
    expect(fallbackPrompt).not.toContain(executionSkillName);
  });

  it("loads bundled diffs skill when explicitly enabled in config", async () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = await resolveBundledDiffsSkillEntries(config);

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(result.skillEntries.map((entry) => entry.skill.name)).toContain("diffs");
  });

  it("skips bundled diffs skill when config is missing", async () => {
    const result = await resolveBundledDiffsSkillEntries();

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(result.skillEntries.map((entry) => entry.skill.name)).not.toContain("diffs");
  });
});
