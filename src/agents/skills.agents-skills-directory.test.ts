import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildWorkspaceSkillsPrompt } from "./skills.js";
import { writeSkill } from "./skills.test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "./skills/home-env.test-support.js";

const tempDirs: string[] = [];

async function createTempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function buildSkillsPrompt(workspaceDir: string, managedDir: string, bundledDir: string): string {
  return buildWorkspaceSkillsPrompt(workspaceDir, {
    managedSkillsDir: managedDir,
    bundledSkillsDir: bundledDir,
  });
}

async function createWorkspaceSkillDirs() {
  const workspaceDir = await createTempDir("openclaw-");
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
    fakeHome = await createTempDir("openclaw-home-");
    envSnapshot = setMockSkillsHomeEnv(fakeHome);
  });

  afterEach(async () => {
    await restoreMockSkillsHomeEnv(envSnapshot, async () => {
      await Promise.all(
        tempDirs
          .splice(0, tempDirs.length)
          .map((dir) =>
            fs.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }),
          ),
      );
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
