// Workspace skill sync runtime tests cover sandbox synchronization.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";
import {
  createWorkspaceSkillSyncFixtures,
  dropSyncedSkillsUsageCacheForTests,
  pathExists,
  peekPublishedSyncedSkillsSnapshot,
  publishedSkillFilePath,
  sortedSkillNames,
} from "./workspace-skill-sync.test-support.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtures = createWorkspaceSkillSyncFixtures("openclaw-skills-sync-suite", tempDirs);

async function syncSourceSkillsToTarget(sourceWorkspace: string, targetWorkspace: string) {
  await syncWorkspaceSkills({
    sourceWorkspaceDir: sourceWorkspace,
    targetWorkspaceDir: targetWorkspace,
    bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
    managedSkillsDir: path.join(sourceWorkspace, ".managed"),
  });
}

function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): string {
  return buildSkillSnapshot(workspaceDir, opts).prompt;
}

async function expectSyncedSkillConfinement(params: {
  sourceWorkspace: string;
  targetWorkspace: string;
  safeSkillDirName: string;
  escapedDest: string;
}) {
  expect(await pathExists(params.escapedDest)).toBe(false);
  await syncSourceSkillsToTarget(params.sourceWorkspace, params.targetWorkspace);
  expect(
    peekPublishedSyncedSkillsSnapshot(params.targetWorkspace)?.resolvedSkills?.some((skill) =>
      // Published directories carry an identity suffix, so match the safe prefix.
      path.basename(path.dirname(skill.filePath)).startsWith(`${params.safeSkillDirName}-`),
    ),
  ).toBe(true);
  expect(await pathExists(params.escapedDest)).toBe(false);
}

describe("syncWorkspaceSkills", () => {
  const buildPrompt = (
    workspaceDir: string,
    opts?: Parameters<typeof buildWorkspaceSkillsPrompt>[1],
  ) =>
    withEnv({ HOME: workspaceDir }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        ...opts,
      }),
    );

  const cloneSourceTemplate = async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    await writeSkill({
      dir: path.join(sourceWorkspace, ".extra", "demo-skill"),
      name: "demo-skill",
      description: "Extra version",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, ".bundled", "demo-skill"),
      name: "demo-skill",
      description: "Bundled version",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, ".managed", "demo-skill"),
      name: "demo-skill",
      description: "Managed version",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "demo-skill"),
      name: "demo-skill",
      description: "Workspace version",
    });
    return sourceWorkspace;
  };

  it("syncs merged skills into a target workspace", async () => {
    const sourceWorkspace = await cloneSourceTemplate();
    const targetWorkspace = await fixtures.createCaseDir("target");
    const extraDir = path.join(sourceWorkspace, ".extra");
    const bundledDir = path.join(sourceWorkspace, ".bundled");
    const managedDir = path.join(sourceWorkspace, ".managed");
    const workspaceSkillDir = path.join(sourceWorkspace, "skills", "demo-skill");

    await fs.mkdir(path.join(workspaceSkillDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceSkillDir, ".git", "config"), "gitdir");
    await fs.mkdir(path.join(workspaceSkillDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceSkillDir, "node_modules", "pkg", "index.js"),
      "export {}",
    );

    const { skillUsagePaths, skillsSnapshot } = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      config: { skills: { load: { extraDirs: [extraDir] } } },
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
    });

    const publishedFilePath = skillsSnapshot.resolvedSkills?.[0]?.filePath;
    expect(path.basename(path.dirname(publishedFilePath ?? ""))).toMatch(/^demo-skill-[0-9a-f]+$/);
    expect(skillUsagePaths).toEqual([
      {
        readPath: publishedFilePath,
        skillFile: path.join(workspaceSkillDir, "SKILL.md"),
        skillName: "demo-skill",
        skillSource: "workspace",
      },
    ]);
    expect(skillsSnapshot.skills.map((skill) => skill.name)).toEqual(["demo-skill"]);
    expect(skillsSnapshot.resolvedSkills?.map((skill) => skill.filePath)).toEqual([
      publishedFilePath,
    ]);

    expect(skillsSnapshot.prompt).toContain("Workspace version");
    expect(skillsSnapshot.prompt).not.toContain("Managed version");
    expect(skillsSnapshot.prompt).not.toContain("Bundled version");
    expect(skillsSnapshot.prompt).not.toContain("Extra version");
    const publishedDir = path.dirname(publishedFilePath ?? "");
    expect(skillsSnapshot.prompt.replaceAll("\\", "/")).toContain(
      `${path.basename(publishedDir)}/SKILL.md`,
    );
    expect(await pathExists(path.join(publishedDir, ".git"))).toBe(false);
    expect(await pathExists(path.join(publishedDir, "node_modules"))).toBe(false);
  });

  it("skips discovery and copying when the synced snapshot still matches", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "hidden"),
      name: "hidden",
      description: "Prompt-hidden skill",
      frontmatterExtra: "disable-model-invocation: true",
    });
    const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    expect(skillsSnapshot.skills.map((skill) => skill.name)).toEqual(["alpha", "hidden"]);
    expect(skillsSnapshot.resolvedSkills?.map((skill) => skill.name)).toEqual(["alpha"]);
    const params = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot,
    };

    const first = await syncWorkspaceSkills(params);
    await fs.rm(path.join(sourceWorkspace, "skills"), { recursive: true, force: true });
    const copy = vi.spyOn(fs, "copyFile");
    const second = await syncWorkspaceSkills(params);
    const copyCount = copy.mock.calls.length;
    copy.mockRestore();

    expect(second.skillUsagePaths).toEqual(first.skillUsagePaths);
    expect(second.skillsSnapshot.prompt).toBe(first.skillsSnapshot.prompt);
    expect(second.skillsSnapshot.skills).toEqual(first.skillsSnapshot.skills);
    expect(copyCount).toBe(0);
    expect(
      await pathExists(
        first.skillUsagePaths.find((entry) => entry.skillName === "alpha")?.readPath ?? "",
      ),
    ).toBe(true);
    expect(
      await pathExists(
        first.skillUsagePaths.find((entry) => entry.skillName === "hidden")?.readPath ?? "",
      ),
    ).toBe(true);
  });

  it("rejects path-like tampering without deriving read paths from the manifest", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    for (const name of ["alpha", "beta"]) {
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", name),
        name,
        description: `${name} skill`,
      });
    }
    const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const syncParams = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot,
    };
    await syncWorkspaceSkills(syncParams);

    const targetSkillsDir = path.join(targetWorkspace, "skills");
    const manifestPath = path.join(targetSkillsDir, ".openclaw-sync.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      skillsVersion: number;
      entryKeys: string[];
    };
    await fs.writeFile(
      manifestPath,
      JSON.stringify({
        ...manifest,
        entryKeys: ["../escape", "..\\escape"],
      }),
    );

    const copy = vi.spyOn(fs, "copyFile");
    const { skillUsagePaths: usagePaths } = await syncWorkspaceSkills(syncParams);
    const copyCount = copy.mock.calls.length;
    copy.mockRestore();

    expect(copyCount).toBe(2);
    expect(
      usagePaths.every((entry) => {
        const relative = path.relative(targetSkillsDir, entry.readPath);
        return relative !== ".." && !relative.startsWith(`..${path.sep}`);
      }),
    ).toBe(true);
    expect(await pathExists(path.resolve(targetSkillsDir, "../escape"))).toBe(false);
  });

  it("keeps retained children in place and prunes removed ones on a changed catalog", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    for (const name of ["alpha", "beta", "gamma"]) {
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", name),
        name,
        description: `${name} skill`,
      });
    }
    const snapshotVersion = getSkillsSnapshotVersion(sourceWorkspace);
    const firstSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "beta"],
      snapshotVersion,
    });
    const first = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "beta"],
      skillsSnapshot: firstSnapshot,
    });
    const firstAlphaPath = first.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "alpha",
    )?.filePath;
    const firstBetaPath = first.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "beta",
    )?.filePath;
    expect(firstAlphaPath).toBeTruthy();
    await fs.writeFile(path.join(path.dirname(firstAlphaPath ?? ""), "preserved.txt"), "preserved");

    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "gamma"],
      snapshotVersion,
    });
    const second = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "gamma"],
      skillsSnapshot: secondSnapshot,
    });
    const secondAlphaPath = second.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "alpha",
    )?.filePath;
    const secondGammaPath = second.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "gamma",
    )?.filePath;

    expect(sortedSkillNames(second.skillsSnapshot.skills.map((skill) => skill.name))).toEqual([
      "alpha",
      "gamma",
    ]);
    // A retained skill keeps its published path so readers holding the previous
    // catalog never lose the location they advertised.
    expect(secondAlphaPath).toBe(firstAlphaPath);
    expect(await pathExists(firstAlphaPath ?? "")).toBe(true);
    expect(await pathExists(secondGammaPath ?? "")).toBe(true);
    // A file the source dropped is deleted immediately; a child that left the
    // catalog survives one refresh for readers still holding the old prompt.
    expect(await pathExists(path.join(path.dirname(firstAlphaPath ?? ""), "preserved.txt"))).toBe(
      false,
    );
    expect(await pathExists(firstBetaPath ?? "")).toBe(true);
  });

  it("refreshes same-key skill trees after the watcher version changes", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({ dir: sourceSkillDir, name: "alpha", description: "Alpha skill" });
    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "before");
    await fs.writeFile(path.join(sourceSkillDir, "removed.txt"), "stale");
    const firstSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot: firstSnapshot,
    });

    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "after");
    await fs.rm(path.join(sourceSkillDir, "removed.txt"));
    const nextVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: nextVersion,
    });
    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot: secondSnapshot,
    });

    expect(
      await fs.readFile(
        path.join(
          path.dirname(publishedSkillFilePath(targetWorkspace, "alpha") ?? ""),
          "asset.txt",
        ),
        "utf8",
      ),
    ).toBe("after");
    expect(
      await pathExists(
        path.join(
          path.dirname(publishedSkillFilePath(targetWorkspace, "alpha") ?? ""),
          "removed.txt",
        ),
      ),
    ).toBe(false);
  });

  it("keeps the previous catalog when a refreshed copy fails", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({ dir: sourceSkillDir, name: "alpha", description: "Alpha skill" });
    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "before");
    const firstSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const syncParams = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot: firstSnapshot,
    };
    await syncWorkspaceSkills(syncParams);

    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "after");
    const nextVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: nextVersion,
    });
    const copy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockRejectedValueOnce(new Error("injected copy failure"));
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    copy.mockRestore();

    const manifestPath = path.join(targetWorkspace, "skills", ".openclaw-sync.json");
    expect(await pathExists(manifestPath)).toBe(true);
    expect(
      peekPublishedSyncedSkillsSnapshot(targetWorkspace)?.skills.map((skill) => skill.name),
    ).toEqual(["alpha"]);
    expect(
      await fs.readFile(
        path.join(
          path.dirname(publishedSkillFilePath(targetWorkspace, "alpha") ?? ""),
          "asset.txt",
        ),
        "utf8",
      ),
    ).toBe("before");
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await pathExists(manifestPath)).toBe(true);
    expect(
      await fs.readFile(
        path.join(
          path.dirname(publishedSkillFilePath(targetWorkspace, "alpha") ?? ""),
          "asset.txt",
        ),
        "utf8",
      ),
    ).toBe("after");

    const interruptedTemp = path.join(targetWorkspace, "skills", ".openclaw-sync.interrupted.tmp");
    await fs.rm(manifestPath);
    await fs.writeFile(interruptedTemp, "partial");
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await pathExists(interruptedTemp)).toBe(false);
    expect(await pathExists(manifestPath)).toBe(true);
  });

  it("recovers the last committed catalog after a cold-cache copy failure", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({ dir: sourceSkillDir, name: "alpha", description: "Alpha skill" });
    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "before");
    const firstSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const syncParams = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot: firstSnapshot,
    };
    const first = await syncWorkspaceSkills(syncParams);
    const firstFilePath = first.skillsSnapshot.resolvedSkills?.[0]?.filePath;
    expect(firstFilePath).toBeTruthy();

    dropSyncedSkillsUsageCacheForTests(targetWorkspace);
    expect(peekPublishedSyncedSkillsSnapshot(targetWorkspace)).toBeUndefined();

    await fs.writeFile(path.join(sourceSkillDir, "asset.txt"), "after");
    const nextVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: nextVersion,
    });
    const copy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockRejectedValueOnce(new Error("injected copy failure"));
    const recovered = await syncWorkspaceSkills({
      ...syncParams,
      skillsSnapshot: secondSnapshot,
    });
    copy.mockRestore();

    expect(recovered.skillsSnapshot.skills.map((skill) => skill.name)).toEqual(["alpha"]);
    expect(
      peekPublishedSyncedSkillsSnapshot(targetWorkspace)?.skills.map((skill) => skill.name),
    ).toEqual(["alpha"]);
    expect(
      await fs.readFile(path.join(path.dirname(firstFilePath ?? ""), "asset.txt"), "utf8"),
    ).toBe("before");
    expect(await pathExists(firstFilePath ?? "")).toBe(true);
  });

  it("keeps canonical skill identity after restarting from the published catalog", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillFile = path.join(sourceWorkspace, "skills", "alpha", "SKILL.md");
    await writeSkill({
      dir: path.dirname(sourceSkillFile),
      name: "alpha",
      description: "Alpha skill",
    });
    const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const syncParams = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot,
    };
    const first = await syncWorkspaceSkills(syncParams);
    const firstUsage = first.skillUsagePaths[0];
    expect(firstUsage?.skillFile).toBe(sourceSkillFile);

    dropSyncedSkillsUsageCacheForTests(targetWorkspace);
    const recovered = await syncWorkspaceSkills(syncParams);
    const recoveredUsage = recovered.skillUsagePaths[0];
    expect(recoveredUsage?.readPath).toBe(firstUsage?.readPath);
    // Hydration must not confuse the sandbox destination with the host source.
    expect(recoveredUsage?.skillFile).toBe(sourceSkillFile);
  });

  it("keeps canonical skill metadata when projecting a reused catalog", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
      metadata: '{"openclaw":{"skillKey":"canonical-alpha","primaryEnv":"ALPHA_KEY"}}',
    });
    const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const syncParams = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot,
    };
    const first = await syncWorkspaceSkills(syncParams);
    expect(first.skillsSnapshot.skills).toEqual([
      {
        name: "alpha",
        skillKey: "canonical-alpha",
        primaryEnv: "ALPHA_KEY",
      },
    ]);

    const second = await syncWorkspaceSkills(syncParams);
    expect(second.skillsSnapshot.skills).toEqual(first.skillsSnapshot.skills);
  });

  it("keeps source-origin skill keys when projecting a reused catalog", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({
      dir: sourceSkillDir,
      name: "alpha",
      description: "Alpha skill",
    });
    await fs.mkdir(path.join(sourceSkillDir, ".openclaw"), { recursive: true });
    await fs.writeFile(
      path.join(sourceSkillDir, ".openclaw", "source-origin.json"),
      JSON.stringify({ slug: "custom-key" }),
      "utf8",
    );
    const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const syncParams = {
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot,
    };
    const first = await syncWorkspaceSkills(syncParams);
    expect(first.skillsSnapshot.skills[0]?.skillKey).toBe("custom-key");
    const second = await syncWorkspaceSkills(syncParams);
    expect(second.skillsSnapshot.skills[0]?.skillKey).toBe("custom-key");
  });

  it("projects the current eligibility onto a retained catalog after copy failure", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({ dir: sourceSkillDir, name: "alpha", description: "Alpha skill" });
    const remoteNote =
      "Remote macOS node available (Build Mac). Run macOS-only skills via exec host=node on that node.";
    const firstSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const first = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot: firstSnapshot,
      eligibility: {
        nodeSkills: { canExec: true },
        remote: {
          platforms: ["darwin"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: remoteNote,
        },
      },
    });
    expect(first.skillsSnapshot.prompt).toContain(remoteNote);

    await writeSkill({
      dir: sourceSkillDir,
      name: "alpha",
      description: "Alpha skill updated",
    });
    const nextVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: nextVersion,
    });
    const copy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockRejectedValueOnce(new Error("injected copy failure"));
    const recovered = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot: secondSnapshot,
      eligibility: { nodeSkills: { canExec: false } },
    });
    copy.mockRestore();

    expect(recovered.skillsSnapshot.nodeSkillsEligibility).toEqual({ canExec: false });
    expect(recovered.skillsSnapshot.prompt).not.toContain(remoteNote);
    expect(recovered.skillsSnapshot.skills.map((skill) => skill.name)).toEqual(["alpha"]);
  });

  it("keeps a committed catalog when pruning a removed child fails", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const publish = async (name: string) => {
      await fs.rm(path.join(sourceWorkspace, "skills"), { recursive: true, force: true });
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", name),
        name,
        description: `${name} skill`,
      });
      const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
        bundledSkillsDir,
        managedSkillsDir,
        snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
      });
      return await syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        skillsSnapshot,
      });
    };

    await publish("alpha");
    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });

    const originalRm = nodeFs.promises.rm.bind(nodeFs.promises);
    const rm = vi.spyOn(nodeFs.promises, "rm").mockImplementation(async (target, opts) => {
      if (String(target).endsWith(`${path.sep}skills${path.sep}alpha`)) {
        throw new Error("injected prune failure");
      }
      return await originalRm(target, opts);
    });
    const second = await publish("beta");
    rm.mockRestore();

    // Prune is cleanup after the manifest commit; failing it must not hide the
    // catalog this run published.
    expect(second.skillsSnapshot.skills.map((skill) => skill.name)).toEqual(["beta"]);
    expect(second.skillUsagePaths).toHaveLength(1);
    expect(await pathExists(second.skillUsagePaths[0]?.readPath ?? "")).toBe(true);
  });

  it("returns no snapshot paths when the first copy fails", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({ dir: sourceSkillDir, name: "alpha", description: "Alpha skill" });
    const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
    });
    const copy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockRejectedValueOnce(new Error("injected copy failure"));
    const synced = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillsSnapshot,
    });
    copy.mockRestore();

    expect(synced.skillUsagePaths).toEqual([]);
    expect(synced.skillsSnapshot.skills).toEqual([]);
    expect(synced.skillsSnapshot.resolvedSkills ?? []).toEqual([]);
    expect(synced.skillsSnapshot.prompt).toBe("");
    expect(peekPublishedSyncedSkillsSnapshot(targetWorkspace)).toBeUndefined();
    // Nothing was ever published, so no child is advertised.
    // The directory is created before the copy fails, but nothing is published in it.
    expect(publishedSkillFilePath(targetWorkspace, "alpha")).toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "preserves the target skills directory while refreshing children",
    async () => {
      const sourceWorkspace = await cloneSourceTemplate();
      const targetWorkspace = await fixtures.createCaseDir("target");
      const targetSkillsDir = path.join(targetWorkspace, "skills");
      await fs.mkdir(path.join(targetSkillsDir, "stale"), { recursive: true });
      await fs.writeFile(path.join(targetSkillsDir, "stale", "SKILL.md"), "# Stale\n", "utf8");
      const before = await fs.stat(targetSkillsDir);

      await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

      const after = await fs.stat(targetSkillsDir);
      expect(after.ino).toBe(before.ino);
      expect(await pathExists(path.join(targetSkillsDir, "stale", "SKILL.md"))).toBe(false);
      expect(await pathExists(publishedSkillFilePath(targetWorkspace, "demo-skill") ?? "")).toBe(
        true,
      );
    },
  );

  it("syncs the explicit agent skill subset instead of inherited defaults", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "foo_bar"),
      name: "foo_bar",
      description: "Underscore variant",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "foo.dot"),
      name: "foo.dot",
      description: "Dot variant",
    });

    const synced = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      agentId: "alpha",
      config: {
        agents: {
          defaults: {
            skills: ["foo_bar", "foo.dot"],
          },
          list: [{ id: "alpha", skills: ["foo_bar"] }],
        },
      },
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(synced.skillsSnapshot.prompt).toContain("Underscore variant");
    expect(synced.skillsSnapshot.prompt).not.toContain("Dot variant");
    expect(await pathExists(publishedSkillFilePath(targetWorkspace, "foo_bar") ?? "")).toBe(true);
    expect(publishedSkillFilePath(targetWorkspace, "foo.dot")).toBeUndefined();
  });
  it.runIf(process.platform !== "win32")(
    "does not sync workspace skills that resolve outside the source workspace root",
    async () => {
      const sourceWorkspace = await fixtures.createCaseDir("source");
      const targetWorkspace = await fixtures.createCaseDir("target");
      const outsideRoot = await fixtures.createCaseDir("outside");
      const outsideSkillDir = path.join(outsideRoot, "escaped-skill");

      await writeSkill({
        dir: outsideSkillDir,
        name: "escaped-skill",
        description: "Outside source workspace",
      });
      await fs.mkdir(path.join(sourceWorkspace, "skills"), { recursive: true });
      await fs.symlink(
        outsideSkillDir,
        path.join(sourceWorkspace, "skills", "escaped-skill"),
        "dir",
      );

      await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

      const prompt = buildPrompt(targetWorkspace, {
        bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
        managedSkillsDir: path.join(targetWorkspace, ".managed"),
      });

      expect(prompt).not.toContain("escaped-skill");
      expect(
        (await fs.readdir(path.join(targetWorkspace, "skills"))).some((child) =>
          child.startsWith("escaped-skill-"),
        ),
      ).toBe(false);
    },
  );
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const escapeId = path.basename(sourceWorkspace);
    const traversalName = `../../../skill-sync-escape-${escapeId}`;
    const escapedDest = path.resolve(targetWorkspace, "skills", traversalName);

    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "safe-traversal-skill"),
      name: traversalName,
      description: "Traversal skill",
    });

    expect(path.relative(path.join(targetWorkspace, "skills"), escapedDest).startsWith("..")).toBe(
      true,
    );
    await expectSyncedSkillConfinement({
      sourceWorkspace,
      targetWorkspace,
      safeSkillDirName: "safe-traversal-skill",
      escapedDest,
    });
  });
  it("keeps synced skills confined under target workspace when frontmatter name is absolute", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const escapeId = path.basename(sourceWorkspace);
    const absoluteDest = path.join(os.tmpdir(), `skill-sync-abs-escape-${escapeId}`);

    await fs.rm(absoluteDest, { recursive: true, force: true });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "safe-absolute-skill"),
      name: absoluteDest,
      description: "Absolute skill",
    });

    await expectSyncedSkillConfinement({
      sourceWorkspace,
      targetWorkspace,
      safeSkillDirName: "safe-absolute-skill",
      escapedDest: absoluteDest,
    });
  });
  it("filters skills based on env/config gates", async () => {
    const workspaceDir = await fixtures.createCaseDir("workspace");
    const skillDir = path.join(workspaceDir, "skills", "image-lab");
    await writeSkill({
      dir: skillDir,
      name: "image-lab",
      description: "Generates images",
      metadata:
        '{"openclaw":{"requires":{"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY"}}',
      body: "# Image Lab\n",
    });

    withEnv({ GEMINI_API_KEY: undefined }, () => {
      const missingPrompt = buildPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { entries: { "image-lab": { apiKey: "" } } } },
      });
      expect(missingPrompt).not.toContain("image-lab");

      const enabledPrompt = buildPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: {
          skills: { entries: { "image-lab": { apiKey: "test-key" } } }, // pragma: allowlist secret
        },
      });
      expect(enabledPrompt).toContain("image-lab");
    });
  });
  it("applies skill filters, including empty lists", async () => {
    const workspaceDir = await fixtures.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "beta"),
      name: "beta",
      description: "Beta skill",
    });

    const filteredPrompt = buildPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["alpha"],
    });
    expect(filteredPrompt).toContain("alpha");
    expect(filteredPrompt).not.toContain("beta");

    const emptyPrompt = buildPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: [],
    });
    expect(emptyPrompt).toBe("");
  });

  it("syncs remote-eligible filtered skills into the target workspace", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "remote-only"),
      name: "remote-only",
      description: "Sandbox-only bin",
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
    });

    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      agentId: "alpha",
      config: {
        agents: {
          defaults: {
            skills: ["remote-only"],
          },
          list: [{ id: "alpha" }],
        },
      },
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      },
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(await pathExists(publishedSkillFilePath(targetWorkspace, "remote-only") ?? "")).toBe(
      true,
    );
  });

  it("syncs managed symlinked skills as real directories in the target workspace", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const managedDir = path.join(sourceWorkspace, ".managed");
    const skillName = "managed-linked";
    const targetSkillDir = path.join(
      await fixtures.createCaseDir("manager-cache"),
      ".hidden-target",
    );
    await writeSkill({
      dir: targetSkillDir,
      name: skillName,
      description: "Managed symlink target",
    });
    await fs.mkdir(managedDir, { recursive: true });
    await fs.symlink(
      targetSkillDir,
      path.join(managedDir, skillName),
      process.platform === "win32" ? "junction" : "dir",
    );

    const synced = await withEnvAsync({ HOME: sourceWorkspace }, () =>
      syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        managedSkillsDir: managedDir,
        skillFilter: [skillName],
      }),
    );

    const syncedSkillMd = publishedSkillFilePath(targetWorkspace, skillName);
    const syncedSkillDir = syncedSkillMd ? path.dirname(syncedSkillMd) : "";
    expect(await pathExists(syncedSkillMd ?? "")).toBe(true);
    expect((await fs.lstat(syncedSkillDir)).isSymbolicLink()).toBe(false);
    expect(await pathExists(path.join(targetWorkspace, "skills", ".hidden-target"))).toBe(false);
    expect(synced.skillsSnapshot.prompt).toContain("Managed symlink target");
  });
});
