// Workspace skill sync catalog-race tests cover incremental publish readability.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { resolveSandboxSkillRuntimeInputs } from "../../agents/embedded-agent-runner/sandbox-skills.js";
import { attachPublishedSandboxSkills } from "../../agents/sandbox/published-skills-handoff.js";
import { resolveEmbeddedRunSkillEntries } from "../runtime/embedded-run-entries.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { recordRemoteSkillNodeInfo, replaceRemoteNodeSkills } from "../runtime/remote-skills.js";
import { resetRemoteNodeSkillsForTests } from "../runtime/remote-skills.test-support.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "./workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";
import {
  createMaterializedSkillsBridge,
  createWorkspaceSkillSyncFixtures,
  dropSyncedSkillsUsageCacheForTests,
  pathExists,
  sortedSkillNames,
} from "./workspace-skill-sync.test-support.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

function resolveBoundSandboxCatalog(params: {
  skillsSnapshot: SkillSnapshot;
  targetWorkspace: string;
}) {
  const sandbox = {
    enabled: true as const,
    containerWorkdir: "/workspace",
    skillsWorkspaceDir: params.targetWorkspace,
    workspaceAccess: "rw" as const,
  };
  attachPublishedSandboxSkills(sandbox, params.skillsSnapshot);
  return resolveSandboxSkillRuntimeInputs({
    sandbox,
    effectiveWorkspace: params.targetWorkspace,
  });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtures = createWorkspaceSkillSyncFixtures("openclaw-skills-sync-catalog-race", tempDirs);

describe("syncWorkspaceSkills incremental catalog publish", () => {
  it("keeps concurrent prompt readers on a complete readable catalog during changed refresh", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const oldNames = Array.from(
      { length: 8 },
      (_, index) => `skill-${String(index + 1).padStart(2, "0")}`,
    );
    for (const name of oldNames) {
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", name),
        name,
        description: `${name} skill`,
      });
    }
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
    });
    const oldCatalog = sortedSkillNames(oldNames);
    expect(sortedSkillNames(first.skillsSnapshot.skills.map((skill) => skill.name))).toEqual(
      oldCatalog,
    );

    await fs.rm(path.join(sourceWorkspace, "skills", "skill-08"), { recursive: true, force: true });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "skill-09"),
      name: "skill-09",
      description: "skill-09 skill",
    });
    const nextVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      snapshotVersion: nextVersion,
    });
    const newCatalog = sortedSkillNames(secondSnapshot.skills.map((skill) => skill.name));

    let releasePause!: () => void;
    const pause = new Promise<void>((resolve) => {
      releasePause = resolve;
    });
    let pausedAfterCopy = false;
    const originalCopyFile = nodeFs.promises.copyFile.bind(nodeFs.promises);
    const cpSpy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockImplementation(async (source, destination, mode) => {
        const result = await originalCopyFile(source, destination, mode);
        // Pause mid-refresh so a concurrent reader observes the tree while only
        // part of the new catalog has landed.
        if (!pausedAfterCopy) {
          pausedAfterCopy = true;
          await pause;
        }
        return result;
      });

    try {
      const syncPromise = syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        skillsSnapshot: secondSnapshot,
      });
      await vi.waitFor(() => {
        expect(pausedAfterCopy).toBe(true);
      });

      // A live directory scan mid-refresh is not yet the new catalog.
      const liveNameSet = new Set(
        loadWorkspaceSkills(targetWorkspace, { workspaceOnly: true }).map(
          (entry) => entry.skill.name,
        ),
      );
      expect(newCatalog.every((name) => liveNameSet.has(name))).toBe(false);

      // Sandbox prompt readers use the catalog bound to this run, not a live scan.
      const {
        skillsSnapshot: skillsSnapshotForRun,
        skillsPromptWorkspaceDir,
        skillsWorkspaceDir,
        workspaceOnly,
      } = resolveBoundSandboxCatalog({
        skillsSnapshot: first.skillsSnapshot,
        targetWorkspace,
      });
      const { shouldLoadSkillEntries } = resolveEmbeddedRunSkillEntries({
        workspaceDir: skillsWorkspaceDir,
        skillsSnapshot: skillsSnapshotForRun,
        workspaceOnly,
      });
      expect(shouldLoadSkillEntries).toBe(false);
      const prompt = resolveSkillsPrompt({
        skillsSnapshot: skillsSnapshotForRun,
        workspaceDir: skillsPromptWorkspaceDir,
      });
      const promptNames = sortedSkillNames(
        [...prompt.matchAll(/<name>([^<]*)<\/name>/g)].flatMap((match) =>
          match[1] ? [match[1]] : [],
        ),
      );
      expect(promptNames).toEqual(oldCatalog);
      expect(
        sortedSkillNames(skillsSnapshotForRun?.skills.map((skill) => skill.name) ?? []),
      ).toEqual(oldCatalog);
      const firstAdvertised = skillsSnapshotForRun?.resolvedSkills?.find(
        (skill) => skill.name === "skill-01",
      )?.filePath;
      expect(firstAdvertised).toContain("/workspace/.openclaw/sandbox-skills/skills/skill-01-");
      expect(prompt).toContain(`<location>${firstAdvertised}</location>`);

      // Incremental publish never wipes a live child, so every advertised
      // <location> stays readable through the sandbox bridge mid-refresh.
      const bridge = createMaterializedSkillsBridge(targetWorkspace);
      const oldCodeModeSkills = resolveCodeModeSkills({
        skillsPrompt: prompt,
        candidates: skillsSnapshotForRun?.resolvedSkills ?? [],
        reader: async ({ location, signal }) =>
          (
            await bridge.readFile({
              filePath: location,
              cwd: "/workspace",
              signal,
            })
          ).toString("utf8"),
      });
      expect(sortedSkillNames(oldCodeModeSkills.map((skill) => skill.name))).toEqual(oldCatalog);
      for (const skill of oldCodeModeSkills) {
        await expect(readCodeModeSkill(skill)).resolves.toContain(`# ${skill.name}`);
      }

      releasePause();
      const second = await syncPromise;
      expect(sortedSkillNames(second.skillsSnapshot.skills.map((skill) => skill.name))).toEqual(
        newCatalog,
      );

      const publishedAfter = resolveBoundSandboxCatalog({
        skillsSnapshot: second.skillsSnapshot,
        targetWorkspace,
      });
      const newPrompt = resolveSkillsPrompt({
        skillsSnapshot: publishedAfter.skillsSnapshot,
        workspaceDir: publishedAfter.skillsPromptWorkspaceDir,
      });
      const newCodeModeSkills = resolveCodeModeSkills({
        skillsPrompt: newPrompt,
        candidates: publishedAfter.skillsSnapshot?.resolvedSkills ?? [],
        reader: async ({ location, signal }) =>
          (
            await bridge.readFile({
              filePath: location,
              cwd: "/workspace",
              signal,
            })
          ).toString("utf8"),
      });
      expect(sortedSkillNames(newCodeModeSkills.map((skill) => skill.name))).toEqual(newCatalog);
      for (const skill of newCodeModeSkills) {
        await expect(readCodeModeSkill(skill)).resolves.toContain(`# ${skill.name}`);
      }
      // skill-08 left the catalog but survives this refresh: reader A built its
      // prompt from the previous catalog and still advertises that location.
      const departedSkillPath =
        first.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "skill-08")?.filePath ??
        "";
      expect(departedSkillPath).toBeTruthy();
      expect(await pathExists(departedSkillPath)).toBe(true);
      expect(second.skillsSnapshot.prompt).not.toContain("skill-08");

      // Retention is one generation, not unbounded: the next change drops it.
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", "skill-10"),
        name: "skill-10",
        description: "skill-10 skill",
      });
      const thirdVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
      await syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        skillsSnapshot: buildSkillSnapshot(sourceWorkspace, {
          bundledSkillsDir,
          managedSkillsDir,
          snapshotVersion: thirdVersion,
        }),
      });
      expect(await pathExists(departedSkillPath)).toBe(false);
    } finally {
      releasePause();
      cpSpy.mockRestore();
    }
  });

  it("stages a replacement instead of overwriting the advertised location", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const skillDir = path.join(sourceWorkspace, "skills", "bulky");
    const writeBulkySkill = async (marker: string) => {
      await writeSkill({
        dir: skillDir,
        name: "bulky",
        description: "Bulky skill",
        body: `# ${marker}\n${marker.repeat(100_000)}\n`,
      });
    };
    const publish = async () => {
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

    await writeBulkySkill("A");
    const first = await publish();
    const advertised = first.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "bulky",
    )?.filePath;
    if (!advertised) {
      throw new Error("expected the bulky skill to be published");
    }
    expect(await fs.readFile(advertised, "utf8")).toContain("# A");

    await writeBulkySkill("B");
    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });

    // Sample the advertised path at the moment the new bytes are on disk but the
    // swap has not happened. Replacing the live file in place would expose a
    // truncated or missing read here; staging plus rename cannot.
    const originalCopyFile = nodeFs.promises.copyFile.bind(nodeFs.promises);
    let readDuringReplace: string | undefined;
    const copySpy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockImplementation(async (source, destination, mode) => {
        const result = await originalCopyFile(source, destination, mode);
        readDuringReplace ??= await fs.readFile(advertised, "utf8");
        return result;
      });
    try {
      await publish();
    } finally {
      copySpy.mockRestore();
    }

    expect(readDuringReplace).toContain("# A");
    expect(await fs.readFile(advertised, "utf8")).toContain("# B");
  });

  it("recovers when a published child's entry changes type in the source", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "demo");
    const publish = async () => {
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

    await writeSkill({ dir: sourceSkillDir, name: "demo", description: "Demo skill" });
    await fs.writeFile(path.join(sourceSkillDir, "AGENTS.md"), "guide v1\n");
    await fs.writeFile(path.join(sourceSkillDir, "notes"), "note v1\n");
    await publish();

    // Skills ship AGENTS.md with a sibling CLAUDE.md symlink, and a plain file can
    // become a directory. `fs.cp` only replaces regular files, so both changes
    // must be reconciled before the copy or the child stalls half-updated.
    await fs.symlink("AGENTS.md", path.join(sourceSkillDir, "CLAUDE.md"));
    await fs.rm(path.join(sourceSkillDir, "notes"));
    await fs.mkdir(path.join(sourceSkillDir, "notes"), { recursive: true });
    await fs.writeFile(path.join(sourceSkillDir, "notes", "detail.md"), "detail\n");
    await fs.writeFile(path.join(sourceSkillDir, "AGENTS.md"), "guide v2\n");
    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const second = await publish();

    const publishedDir = path.dirname(
      second.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "demo")?.filePath ?? "",
    );
    expect(await fs.readFile(path.join(publishedDir, "AGENTS.md"), "utf8")).toBe("guide v2\n");
    expect((await fs.lstat(path.join(publishedDir, "CLAUDE.md"))).isSymbolicLink()).toBe(true);
    expect((await fs.lstat(path.join(publishedDir, "notes"))).isDirectory()).toBe(true);
    expect(await fs.readFile(path.join(publishedDir, "notes", "detail.md"), "utf8")).toBe(
      "detail\n",
    );
  });

  it("never repurposes a departed skill's directory for a basename-colliding sibling", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    // Two skills whose directories share a basename. Suffixing by iteration order
    // would let the survivor inherit the departed sibling's directory, so a run
    // still advertising that location would read the wrong skill's content.
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha", "tools"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "beta", "tools"),
      name: "beta",
      description: "Beta skill",
    });
    const publish = async (skillFilter?: string[]) => {
      const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
        bundledSkillsDir,
        managedSkillsDir,
        ...(skillFilter ? { skillFilter } : {}),
        snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
      });
      return await syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        ...(skillFilter ? { skillFilter } : {}),
        skillsSnapshot,
      });
    };

    const both = await publish();
    const alphaPath = both.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "alpha",
    )?.filePath;
    const betaPath = both.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "beta",
    )?.filePath;
    expect(alphaPath).toBeTruthy();
    expect(betaPath).toBeTruthy();
    expect(alphaPath).not.toBe(betaPath);

    // Eligibility narrows to beta only. Alpha's location must never start
    // serving beta: a missing or stale file is a failure the model can report,
    // silently reading a different skill is not.
    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const betaOnly = await publish(["beta"]);
    expect(await fs.readFile(alphaPath ?? "", "utf8")).toContain("name: alpha");
    expect(
      await fs.readFile(
        betaOnly.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "beta")?.filePath ??
          "",
        "utf8",
      ),
    ).toContain("name: beta");
  });

  it("never lets a newly eligible skill claim a departed sibling's directory", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha", "tools"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "beta", "tools"),
      name: "beta",
      description: "Beta skill",
    });
    const publish = async (skillFilter: string[]) => {
      const skillsSnapshot = buildSkillSnapshot(sourceWorkspace, {
        bundledSkillsDir,
        managedSkillsDir,
        skillFilter,
        snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
      });
      return await syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        skillFilter,
        skillsSnapshot,
      });
    };

    // Beta alone takes the plain basename. Alpha then becomes eligible while beta
    // does not: alpha must not inherit the location beta's run advertised.
    const betaOnly = await publish(["beta"]);
    const betaPath = betaOnly.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "beta",
    )?.filePath;
    expect(betaPath).toBeTruthy();

    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const alphaOnly = await publish(["alpha"]);
    const alphaPath = alphaOnly.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "alpha",
    )?.filePath;
    expect(alphaPath).not.toBe(betaPath);
    expect(await fs.readFile(betaPath ?? "", "utf8")).toContain("name: beta");
    expect(await fs.readFile(alphaPath ?? "", "utf8")).toContain("name: alpha");
  });

  it("keeps node-hosted skills in the published sandbox catalog", async () => {
    resetRemoteNodeSkillsForTests();
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "demo"),
      name: "demo",
      description: "Demo skill",
    });
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      displayName: "Build Mac",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      displayName: "Build Mac",
      skills: [
        {
          name: "release-helper",
          description: "Prepare a release",
          content: [
            "---",
            "name: release-helper",
            "description: Prepare a release",
            "---",
            "",
            "# Instructions",
            "",
          ].join("\n"),
        },
      ],
    });
    try {
      const synced = await syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        eligibility: { nodeSkills: { canExec: true } },
      });
      const nodeLocation = "node://node-1/skills/release-helper/SKILL.md";
      expect(sortedSkillNames(synced.skillsSnapshot.skills.map((skill) => skill.name))).toEqual([
        "demo",
        "release-helper",
      ]);
      expect(synced.skillsSnapshot.prompt).toContain(nodeLocation);
      expect(
        synced.skillsSnapshot.resolvedSkills?.some((skill) => skill.filePath === nodeLocation),
      ).toBe(true);

      const resolved = resolveBoundSandboxCatalog({
        skillsSnapshot: synced.skillsSnapshot,
        targetWorkspace,
      });
      expect(resolved.skillsSnapshot?.prompt).toContain(nodeLocation);
      const publishedDemo = synced.skillsSnapshot.resolvedSkills?.find(
        (skill) => skill.name === "demo",
      )?.filePath;
      expect(resolved.skillsSnapshot?.prompt).toContain(
        `/workspace/.openclaw/sandbox-skills/skills/${path.basename(path.dirname(publishedDemo ?? ""))}/SKILL.md`,
      );
      expect(
        resolved.skillsSnapshot?.resolvedSkills?.some((skill) => skill.filePath === nodeLocation),
      ).toBe(true);
    } finally {
      resetRemoteNodeSkillsForTests();
    }
  });

  it("keeps a mixed local/node catalog whole when a cold-cache copy fails", async () => {
    resetRemoteNodeSkillsForTests();
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "demo"),
      name: "demo",
      description: "Demo skill",
    });
    recordRemoteSkillNodeInfo({
      nodeId: "node-1",
      connId: "conn-1",
      displayName: "Build Mac",
      commands: ["system.run"],
    });
    replaceRemoteNodeSkills({
      nodeId: "node-1",
      displayName: "Build Mac",
      skills: [
        {
          name: "release-helper",
          description: "Prepare a release",
          content: [
            "---",
            "name: release-helper",
            "description: Prepare a release",
            "---",
            "",
            "# Instructions",
            "",
          ].join("\n"),
        },
      ],
    });
    try {
      const firstSnapshot = buildSkillSnapshot(sourceWorkspace, {
        bundledSkillsDir,
        managedSkillsDir,
        snapshotVersion: getSkillsSnapshotVersion(sourceWorkspace),
        eligibility: { nodeSkills: { canExec: true } },
      });
      const syncParams = {
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir,
        managedSkillsDir,
        eligibility: { nodeSkills: { canExec: true } } as const,
      };
      const first = await syncWorkspaceSkills({
        ...syncParams,
        skillsSnapshot: firstSnapshot,
      });
      expect(sortedSkillNames(first.skillsSnapshot.skills.map((skill) => skill.name))).toEqual([
        "demo",
        "release-helper",
      ]);

      dropSyncedSkillsUsageCacheForTests(targetWorkspace);
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", "demo"),
        name: "demo",
        description: "Demo skill updated",
      });
      const nextVersion = bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
      const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
        bundledSkillsDir,
        managedSkillsDir,
        snapshotVersion: nextVersion,
        eligibility: { nodeSkills: { canExec: true } },
      });
      const copy = vi
        .spyOn(nodeFs.promises, "copyFile")
        .mockRejectedValueOnce(new Error("injected copy failure"));
      const recovered = await syncWorkspaceSkills({
        ...syncParams,
        skillsSnapshot: secondSnapshot,
      });
      copy.mockRestore();

      // The already-published child survives an unreadable source, so a failed
      // refresh never shrinks the advertised catalog.
      expect(sortedSkillNames(recovered.skillsSnapshot.skills.map((skill) => skill.name))).toEqual([
        "demo",
        "release-helper",
      ]);
      expect(
        await pathExists(
          recovered.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "demo")
            ?.filePath ?? "",
        ),
      ).toBe(true);
    } finally {
      resetRemoteNodeSkillsForTests();
    }
  });

  it("keeps a published child when its source disappears mid-refresh", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    for (const name of ["aaa", "bbb"]) {
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", name),
        name,
        description: `${name} skill`,
      });
    }
    const publish = async () => {
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

    await publish();
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "aaa"),
      name: "aaa",
      description: "aaa skill updated",
    });
    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });

    // A skill install, plugin regeneration, or git operation can remove a source
    // tree after discovery and before its copy. That must not empty the child a
    // concurrent run already advertises.
    const originalCopyFile = nodeFs.promises.copyFile.bind(nodeFs.promises);
    let removedSource = false;
    const cpSpy = vi
      .spyOn(nodeFs.promises, "copyFile")
      .mockImplementation(async (source, destination, mode) => {
        const result = await originalCopyFile(source, destination, mode);
        if (!removedSource) {
          removedSource = true;
          await fs.rm(path.join(sourceWorkspace, "skills", "bbb"), {
            recursive: true,
            force: true,
          });
        }
        return result;
      });
    try {
      const second = await publish();
      expect(sortedSkillNames(second.skillsSnapshot.skills.map((skill) => skill.name))).toEqual([
        "aaa",
        "bbb",
      ]);
      expect(
        await pathExists(
          second.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "bbb")?.filePath ??
            "",
        ),
      ).toBe(true);
    } finally {
      cpSpy.mockRestore();
    }
  });

  it("keeps concurrent sandbox owners on their own published catalogs", async () => {
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

    const first = await publish("alpha");
    const ownerA = {};
    attachPublishedSandboxSkills(ownerA, first.skillsSnapshot);

    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const second = await publish("beta");
    const ownerB = {};
    attachPublishedSandboxSkills(ownerB, second.skillsSnapshot);

    const sandboxInputs = {
      enabled: true as const,
      containerWorkdir: "/workspace",
      skillsWorkspaceDir: targetWorkspace,
      workspaceAccess: "rw" as const,
    };
    const catalogA = resolveSandboxSkillRuntimeInputs({
      sandbox: sandboxInputs,
      effectiveWorkspace: targetWorkspace,
      publishedSkillsOwner: ownerA,
    });
    const catalogB = resolveSandboxSkillRuntimeInputs({
      sandbox: sandboxInputs,
      effectiveWorkspace: targetWorkspace,
      publishedSkillsOwner: ownerB,
    });
    expect(
      sortedSkillNames(catalogA.skillsSnapshot?.skills.map((skill) => skill.name) ?? []),
    ).toEqual(["alpha"]);
    expect(
      sortedSkillNames(catalogB.skillsSnapshot?.skills.map((skill) => skill.name) ?? []),
    ).toEqual(["beta"]);
  });

  it("does not reuse a published catalog prompt across node-eligibility changes", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha"),
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
    const remoteNote =
      "Remote macOS node available (Build Mac). Run macOS-only skills via exec host=node on that node.";

    const first = await syncWorkspaceSkills({
      ...syncParams,
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
    const second = await syncWorkspaceSkills({
      ...syncParams,
      eligibility: { nodeSkills: { canExec: false } },
    });

    expect(first.skillsSnapshot.prompt).toContain(remoteNote);
    expect(first.skillsSnapshot.nodeSkillsEligibility).toEqual({ canExec: true });
    expect(second.skillsSnapshot.nodeSkillsEligibility).toEqual({ canExec: false });
    expect(second.skillsSnapshot.prompt).not.toContain(remoteNote);

    const otherNote = "Remote macOS node available (Other Mac).";
    const third = await syncWorkspaceSkills({
      ...syncParams,
      eligibility: {
        nodeSkills: { canExec: true },
        remote: {
          platforms: ["darwin"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: otherNote,
        },
      },
    });
    expect(third.skillsSnapshot.nodeSkillsEligibility).toEqual({ canExec: true });
    expect(third.skillsSnapshot.prompt).toContain(otherNote);
    expect(third.skillsSnapshot.prompt).not.toContain(remoteNote);
  });
});
