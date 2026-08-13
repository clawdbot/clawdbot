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
    const originalCp = nodeFs.promises.cp.bind(nodeFs.promises);
    const cpSpy = vi
      .spyOn(nodeFs.promises, "cp")
      .mockImplementation(async (source, destination, opts) => {
        const result = await originalCp(source, destination, opts);
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
      expect(prompt).toContain("/workspace/.openclaw/sandbox-skills/skills/skill-01/SKILL.md");

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
      // skill-08 left the catalog, so its child is pruned once the refresh lands.
      expect(await pathExists(path.join(targetWorkspace, "skills", "skill-08", "SKILL.md"))).toBe(
        false,
      );
    } finally {
      releasePause();
      cpSpy.mockRestore();
    }
  });

  it("leaves unchanged skill files untouched across a changed-catalog refresh", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "stable"),
      name: "stable",
      description: "Stable skill",
    });
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

    const first = await publish();
    const stablePath = first.skillsSnapshot.resolvedSkills?.find(
      (skill) => skill.name === "stable",
    )?.filePath;
    if (!stablePath) {
      throw new Error("expected the stable skill to be published");
    }
    const before = await fs.stat(stablePath);

    // A new sibling changes the catalog identities and forces a full refresh.
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "added"),
      name: "added",
      description: "Added skill",
    });
    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const second = await publish();
    expect(sortedSkillNames(second.skillsSnapshot.skills.map((skill) => skill.name))).toEqual([
      "added",
      "stable",
    ]);

    // The unchanged child keeps its inode: no wipe, so no window where a
    // concurrent reader could miss the advertised location.
    const after = await fs.stat(stablePath);
    expect(after.ino).toBe(before.ino);
    expect(
      second.skillsSnapshot.resolvedSkills?.find((skill) => skill.name === "stable")?.filePath,
    ).toBe(stablePath);
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
      expect(resolved.skillsSnapshot?.prompt).toContain(
        "/workspace/.openclaw/sandbox-skills/skills/demo/SKILL.md",
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
        .spyOn(nodeFs.promises, "cp")
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
      expect(await pathExists(path.join(targetWorkspace, "skills", "demo", "SKILL.md"))).toBe(true);
    } finally {
      resetRemoteNodeSkillsForTests();
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
