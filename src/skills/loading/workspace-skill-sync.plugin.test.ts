// Workspace skill sync plugin tests cover copying plugin-provided skills into sandbox workspaces.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";
import {
  createWorkspaceSkillSyncFixtures,
  pathExists,
  publishedSkillFilePath,
} from "./workspace-skill-sync.test-support.js";

const mockResolvePluginSkillDirs = vi.hoisted(() => vi.fn(() => [] as string[]));

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: mockResolvePluginSkillDirs,
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtures = createWorkspaceSkillSyncFixtures("openclaw-skills-sync-plugin", tempDirs);

describe("syncWorkspaceSkills for plugin skills", () => {
  it("syncs plugin skills from symlinked directories to sandbox workspace", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");

    const realPluginSkillDir = await fixtures.createCaseDir("real-plugin-skill");
    await writeSkill({
      dir: realPluginSkillDir,
      name: "wiki-maintainer",
      description: "Wiki maintenance skill for sandboxed agents",
    });

    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fs.mkdir(pluginSkillsDir, { recursive: true });
    const symlinkPath = path.join(pluginSkillsDir, "wiki-maintainer");

    await fs.symlink(
      realPluginSkillDir,
      symlinkPath,
      process.platform === "win32" ? "junction" : "dir",
    );

    mockResolvePluginSkillDirs.mockReturnValueOnce([realPluginSkillDir]);

    const { skillUsagePaths, skillsSnapshot } = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    const syncedSkillMd = skillUsagePaths[0]?.readPath;
    const syncedSkillDir = syncedSkillMd ? path.dirname(syncedSkillMd) : "";
    const syncedStat = await fs.lstat(syncedSkillDir);
    const prompt = skillsSnapshot.prompt.replaceAll("\\", "/");

    expect(await pathExists(syncedSkillMd ?? "")).toBe(true);
    expect(syncedStat.isSymbolicLink()).toBe(false);
    expect(prompt).toContain("Wiki maintenance skill for sandboxed agents");
    expect(prompt).toContain(`${path.basename(syncedSkillDir)}/SKILL.md`);
    expect(path.basename(syncedSkillDir).startsWith("wiki-maintainer-")).toBe(true);
    expect(prompt).not.toContain(realPluginSkillDir.replaceAll("\\", "/"));
    expect(prompt).not.toContain(pluginSkillsDir.replaceAll("\\", "/"));
    expect(prompt).not.toContain(symlinkPath.replaceAll("\\", "/"));
    expect(skillUsagePaths).toEqual([
      {
        readPath: syncedSkillMd,
        skillFile: path.join(realPluginSkillDir, "SKILL.md"),
        skillName: "wiki-maintainer",
        skillSource: "workspace",
      },
    ]);
  });

  it("syncs multiple plugin skills directories to sandbox workspace", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source-multi");
    const targetWorkspace = await fixtures.createCaseDir("target-multi");

    const realSkillA = await fixtures.createCaseDir("skill-a");
    await writeSkill({
      dir: realSkillA,
      name: "browser-automation",
      description: "Browser automation skill",
    });

    const realSkillB = await fixtures.createCaseDir("skill-b");
    await writeSkill({
      dir: realSkillB,
      name: "obsidian-vault",
      description: "Obsidian vault maintenance skill",
    });

    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fs.mkdir(pluginSkillsDir, { recursive: true });

    await fs.symlink(
      realSkillA,
      path.join(pluginSkillsDir, "browser-automation"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await fs.symlink(
      realSkillB,
      path.join(pluginSkillsDir, "obsidian-vault"),
      process.platform === "win32" ? "junction" : "dir",
    );

    mockResolvePluginSkillDirs.mockReturnValueOnce([realSkillA, realSkillB]);

    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(
      await pathExists(publishedSkillFilePath(targetWorkspace, "browser-automation") ?? ""),
    ).toBe(true);
    expect(await pathExists(publishedSkillFilePath(targetWorkspace, "obsidian-vault") ?? "")).toBe(
      true,
    );
  });

  it("does not sync plugin skills that escape allowed root", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source-escape");
    const targetWorkspace = await fixtures.createCaseDir("target-escape");

    const outsideRoot = await fixtures.createCaseDir("outside-root");
    const escapedSkillDir = path.join(outsideRoot, "escaped-skill");
    await writeSkill({
      dir: escapedSkillDir,
      name: "escaped-skill",
      description: "Should not be synced",
    });

    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fs.mkdir(pluginSkillsDir, { recursive: true });
    await fs.symlink(
      escapedSkillDir,
      path.join(pluginSkillsDir, "escaped-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );

    const allowedRoot = await fixtures.createCaseDir("allowed-root");
    mockResolvePluginSkillDirs.mockReturnValueOnce([allowedRoot]);

    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(publishedSkillFilePath(targetWorkspace, "escaped-skill")).toBeUndefined();
    expect(
      (await fs.readdir(path.join(targetWorkspace, "skills"))).some((child) =>
        child.startsWith("escaped-skill-"),
      ),
    ).toBe(false);
  });
});
