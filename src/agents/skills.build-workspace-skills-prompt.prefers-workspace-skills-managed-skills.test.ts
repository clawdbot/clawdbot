import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt } from "./skills/workspace.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-prompt-suite-");

beforeAll(async () => {
  await fixtureSuite.setup();
});

afterAll(async () => {
  await fixtureSuite.cleanup();
});

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
  it("gates by bins, config, and always", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const skillsDir = path.join(workspaceDir, "skills");

    await writeSkill({
      dir: path.join(skillsDir, "bin-skill"),
      name: "bin-skill",
      description: "Needs a bin",
      metadata: '{"openclaw":{"requires":{"bins":["fakebin"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "anybin-skill"),
      name: "anybin-skill",
      description: "Needs any bin",
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","fakebin"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "config-skill"),
      name: "config-skill",
      description: "Needs config",
      metadata: '{"openclaw":{"requires":{"config":["browser.enabled"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "always-skill"),
      name: "always-skill",
      description: "Always on",
      metadata: '{"openclaw":{"always":true,"requires":{"env":["MISSING"]}}}',
    });
    await writeSkill({
      dir: path.join(skillsDir, "env-skill"),
      name: "env-skill",
      description: "Needs env",
      metadata: '{"openclaw":{"requires":{"env":["ENV_KEY"]},"primaryEnv":"ENV_KEY"}}',
    });

    const managedSkillsDir = path.join(workspaceDir, ".managed");
    const defaultPrompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
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
    const skillDir = path.join(workspaceDir, "skills", "alias-skill");
    await writeSkill({
      dir: skillDir,
      name: "alias-skill",
      description: "Uses skillKey",
      metadata: '{"openclaw":{"skillKey":"alias"}}',
    });

    const prompt = withEnv({ HOME: workspaceDir, PATH: "" }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { entries: { alias: { enabled: false } } } },
      }),
    );
    expect(prompt).not.toContain("alias-skill");
  });
});
