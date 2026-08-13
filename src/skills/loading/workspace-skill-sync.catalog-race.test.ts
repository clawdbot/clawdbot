// Workspace skill sync catalog-race tests cover published generation readability.
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readCodeModeSkill, resolveCodeModeSkills } from "../../agents/code-mode-skills.js";
import { resolveSandboxSkillRuntimeInputs } from "../../agents/embedded-agent-runner/sandbox-skills.js";
import {
  attachPublishedSandboxSkills,
  releasePublishedSandboxSkills,
} from "../../agents/sandbox/published-skills-handoff.js";
import { resolveEmbeddedRunSkillEntries } from "../runtime/embedded-run-entries.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { recordRemoteSkillNodeInfo, replaceRemoteNodeSkills } from "../runtime/remote-skills.js";
import { resetRemoteNodeSkillsForTests } from "../runtime/remote-skills.test-support.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import type { SkillSnapshot } from "../types.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "./workspace-skill-prompt.js";
import { leasePublishedSyncedSkillsGeneration } from "./workspace-skill-sync-cache.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";
import {
  createMaterializedSkillsBridge,
  createWorkspaceSkillSyncFixtures,
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
  attachPublishedSandboxSkills(sandbox, {
    skillsSnapshot: params.skillsSnapshot,
    releaseGeneration: () => {},
  });
  return resolveSandboxSkillRuntimeInputs({
    sandbox,
    effectiveWorkspace: params.targetWorkspace,
  });
}

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const fixtures = createWorkspaceSkillSyncFixtures("openclaw-skills-sync-catalog-race", tempDirs);

describe("syncWorkspaceSkills catalog generations", () => {
  it("keeps concurrent prompt readers on a complete catalog during changed refresh", async () => {
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
        const destinationPath = String(destination);
        // Pause after the first new-generation copy so concurrent readers can
        // observe the previous complete catalog while its files still exist.
        if (
          !pausedAfterCopy &&
          destinationPath.includes(`${path.sep}.openclaw-generations${path.sep}`)
        ) {
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

      // Live directory scan skips generation directories (dot-prefixed).
      const liveNameSet = new Set(
        loadWorkspaceSkills(targetWorkspace, { workspaceOnly: true }).map(
          (entry) => entry.skill.name,
        ),
      );
      expect(oldCatalog.some((name) => !liveNameSet.has(name))).toBe(true);
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
      expect(prompt).toContain("/workspace/.openclaw/sandbox-skills/skills/.openclaw-generations/");
      expect(prompt).toContain("/skill-01/SKILL.md");

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

      // Runtime trace for the refresh window: advertised old locations stay
      // readable through the sandbox bridge while the next generation copies.
      console.info(
        [
          `liveScanIncomplete=${oldCatalog.some((name) => !liveNameSet.has(name))}`,
          `readerASeesCompleteOld=${promptNames.join("\0") === oldCatalog.join("\0")}`,
          `oldLocationsRead=${oldCodeModeSkills.length}/${oldCatalog.length}`,
          "RESULT=PASS old catalog readable during generation copy",
        ].join("\n"),
      );

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
      for (const skill of first.skillsSnapshot.resolvedSkills ?? []) {
        expect(await pathExists(skill.filePath)).toBe(true);
      }
      console.info(
        [
          `readerBSeesCompleteNew=${sortedSkillNames(second.skillsSnapshot.skills.map((skill) => skill.name)).join("\0") === newCatalog.join("\0")}`,
          `newLocationsRead=${newCodeModeSkills.length}/${newCatalog.length}`,
          `oldGenerationStillOnDisk=true`,
          "RESULT=PASS complete-old-or-complete-new with sandbox-readable advertised locations",
        ].join("\n"),
      );
    } finally {
      releasePause();
      cpSpy.mockRestore();
    }
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
        "/workspace/.openclaw/sandbox-skills/skills/.openclaw-generations/",
      );
      expect(resolved.skillsSnapshot?.prompt).toContain("/demo/SKILL.md");
      expect(
        resolved.skillsSnapshot?.resolvedSkills?.some((skill) => skill.filePath === nodeLocation),
      ).toBe(true);
    } finally {
      resetRemoteNodeSkillsForTests();
    }
  });

  it("keeps a leased generation readable after later catalogs replace it", async () => {
    const sourceWorkspace = await fixtures.createCaseDir("source");
    const targetWorkspace = await fixtures.createCaseDir("target");
    const bundledSkillsDir = path.join(sourceWorkspace, ".bundled");
    const managedSkillsDir = path.join(sourceWorkspace, ".managed");
    const publish = async (description: string) => {
      await writeSkill({
        dir: path.join(sourceWorkspace, "skills", "alpha"),
        name: "alpha",
        description,
        body: `# ${description}\n`,
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

    const first = await publish("generation-one");
    const firstFilePath = first.skillsSnapshot.resolvedSkills?.[0]?.filePath;
    expect(firstFilePath).toBeTruthy();
    const owner = {};
    attachPublishedSandboxSkills(owner, {
      skillsSnapshot: first.skillsSnapshot,
      releaseGeneration: leasePublishedSyncedSkillsGeneration(targetWorkspace),
    });
    const published = resolveSandboxSkillRuntimeInputs({
      sandbox: {
        enabled: true,
        containerWorkdir: "/workspace",
        skillsWorkspaceDir: targetWorkspace,
        workspaceAccess: "rw",
      },
      effectiveWorkspace: targetWorkspace,
      publishedSkillsOwner: owner,
    });
    const bridge = createMaterializedSkillsBridge(targetWorkspace);
    const codeModeSkills = resolveCodeModeSkills({
      skillsPrompt: resolveSkillsPrompt({
        skillsSnapshot: published.skillsSnapshot,
        workspaceDir: published.skillsPromptWorkspaceDir,
      }),
      candidates: published.skillsSnapshot?.resolvedSkills ?? [],
      reader: async ({ location, signal }) =>
        (
          await bridge.readFile({
            filePath: location,
            cwd: "/workspace",
            signal,
          })
        ).toString("utf8"),
    });
    expect(codeModeSkills).toHaveLength(1);
    const capturedSkill = codeModeSkills[0];
    if (!capturedSkill) {
      throw new Error("expected a captured sandbox skill from the first generation");
    }
    const releasePublishedGeneration = () => {
      releasePublishedSandboxSkills(owner);
    };

    try {
      bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
      await publish("generation-two");
      bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
      await publish("generation-three");

      expect(await pathExists(firstFilePath ?? "")).toBe(true);
      await expect(readCodeModeSkill(capturedSkill)).resolves.toContain("# generation-one");
    } finally {
      releasePublishedGeneration();
    }

    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    await publish("generation-four");
    expect(await pathExists(firstFilePath ?? "")).toBe(false);
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
    attachPublishedSandboxSkills(ownerA, {
      skillsSnapshot: first.skillsSnapshot,
      releaseGeneration: leasePublishedSyncedSkillsGeneration(targetWorkspace),
    });

    bumpSkillsSnapshotVersion({ workspaceDir: sourceWorkspace });
    const second = await publish("beta");
    const ownerB = {};
    attachPublishedSandboxSkills(ownerB, {
      skillsSnapshot: second.skillsSnapshot,
      releaseGeneration: leasePublishedSyncedSkillsGeneration(targetWorkspace),
    });

    try {
      const catalogA = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: targetWorkspace,
          workspaceAccess: "rw",
        },
        effectiveWorkspace: targetWorkspace,
        publishedSkillsOwner: ownerA,
      });
      const catalogB = resolveSandboxSkillRuntimeInputs({
        sandbox: {
          enabled: true,
          containerWorkdir: "/workspace",
          skillsWorkspaceDir: targetWorkspace,
          workspaceAccess: "rw",
        },
        effectiveWorkspace: targetWorkspace,
        publishedSkillsOwner: ownerB,
      });
      expect(
        sortedSkillNames(catalogA.skillsSnapshot?.skills.map((skill) => skill.name) ?? []),
      ).toEqual(["alpha"]);
      expect(
        sortedSkillNames(catalogB.skillsSnapshot?.skills.map((skill) => skill.name) ?? []),
      ).toEqual(["beta"]);
    } finally {
      releasePublishedSandboxSkills(ownerA);
      releasePublishedSandboxSkills(ownerB);
    }
  });
});
