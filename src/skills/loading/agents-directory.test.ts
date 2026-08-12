// Agents directory tests cover agent-scoped skill directory discovery.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { setTestEnvValue } from "../../test-utils/env.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

const tempDirs = createTempDirTracker();

function buildSkillsPrompt(workspaceDir: string, managedDir: string, bundledDir: string): string {
  return buildSkillSnapshot(workspaceDir, {
    managedSkillsDir: managedDir,
    bundledSkillsDir: bundledDir,
  }).prompt;
}

async function createWorkspaceSkillDirs() {
  const workspaceDir = tempDirs.make("openclaw-");
  return {
    workspaceDir,
    managedDir: path.join(workspaceDir, ".managed"),
    bundledDir: path.join(workspaceDir, ".bundled"),
  };
}

describe("buildWorkspaceSkillsPrompt — .agents/skills/ directories", () => {
  let fakeHome: string;
  let envSnapshot: SkillsHomeEnvSnapshot;

  beforeEach(async () => {
    fakeHome = tempDirs.make("openclaw-home-");
    envSnapshot = setMockSkillsHomeEnv(fakeHome);
  });

  afterEach(async () => {
    await restoreMockSkillsHomeEnv(envSnapshot, async () => {
      tempDirs.cleanup();
    });
  });

  it("loads project .agents/skills/ above managed and below workspace", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Project agents version",
    });

    // project .agents/skills/ wins over managed
    const prompt1 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt1).toContain("Project agents version");
    expect(prompt1).not.toContain("Managed version");

    // workspace wins over project .agents/skills/
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "shared-skill"),
      name: "shared-skill",
      description: "Workspace version",
    });

    const prompt2 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt2).toContain("Workspace version");
    expect(prompt2).not.toContain("Project agents version");
  });

  it("loads personal ~/.agents/skills/ above managed and below project .agents/skills/", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      dir: path.join(managedDir, "shared-skill"),
      name: "shared-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Personal agents version",
    });

    // personal wins over managed
    const prompt1 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt1).toContain("Personal agents version");
    expect(prompt1).not.toContain("Managed version");

    // project .agents/skills/ wins over personal
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "shared-skill"),
      name: "shared-skill",
      description: "Project agents version",
    });

    const prompt2 = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt2).toContain("Project agents version");
    expect(prompt2).not.toContain("Personal agents version");
  });

  it("loads personal agent skills only for the default state directory", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "personal-only"),
      name: "personal-only",
      description: "Personal only skill",
    });

    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(fakeHome, ".openclaw"));
    expect(buildSkillsPrompt(workspaceDir, managedDir, bundledDir)).toContain("personal-only");

    setTestEnvValue("OPENCLAW_STATE_DIR", path.join(fakeHome, "scratch-state"));
    expect(buildSkillsPrompt(workspaceDir, managedDir, bundledDir)).not.toContain("personal-only");
  });

  it("loads unique skills from all .agents/skills/ sources alongside others", async () => {
    const { workspaceDir, managedDir, bundledDir } = await createWorkspaceSkillDirs();

    await writeSkill({
      dir: path.join(managedDir, "managed-only"),
      name: "managed-only",
      description: "Managed only skill",
    });
    await writeSkill({
      dir: path.join(fakeHome, ".agents", "skills", "personal-only"),
      name: "personal-only",
      description: "Personal only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, ".agents", "skills", "project-only"),
      name: "project-only",
      description: "Project only skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "workspace-only"),
      name: "workspace-only",
      description: "Workspace only skill",
    });

    const prompt = buildSkillsPrompt(workspaceDir, managedDir, bundledDir);
    expect(prompt).toContain("managed-only");
    expect(prompt).toContain("personal-only");
    expect(prompt).toContain("project-only");
    expect(prompt).toContain("workspace-only");
  });
});
