// Workspace skill sync runtime tests cover sandbox synchronization and plugin-provided skills.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { resolveReusableWorkspaceSkillSnapshot } from "../runtime/session-snapshot.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { resolveWorkshopSkillsDir } from "../workshop/skills-root.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";
import { syncWorkspaceSkills } from "./workspace-skill-sync.runtime.js";

const mockResolvePluginSkillRoots = vi.hoisted(() =>
  vi.fn(() => [] as Array<{ dir: string; rejectHardlinks: boolean }>),
);

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: mockResolvePluginSkillRoots,
}));

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let fixtureRoot = "";
let fixtureCount = 0;
let syncSourceTemplateDir = "";

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

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
    await pathExists(
      path.join(params.targetWorkspace, "skills", params.safeSkillDirName, "SKILL.md"),
    ),
  ).toBe(true);
  expect(await pathExists(params.escapedDest)).toBe(false);
}

beforeAll(async () => {
  fixtureRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-sync-suite-")),
  );
  syncSourceTemplateDir = await createCaseDir("source-template");
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, ".extra", "demo-skill"),
    name: "demo-skill",
    description: "Extra version",
  });
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, ".bundled", "demo-skill"),
    name: "demo-skill",
    description: "Bundled version",
  });
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, ".managed", "demo-skill"),
    name: "demo-skill",
    description: "Managed version",
  });
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, "skills", "demo-skill"),
    name: "demo-skill",
    description: "Workspace version",
  });
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

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
    const sourceWorkspace = await createCaseDir("source");
    await fs.cp(syncSourceTemplateDir, sourceWorkspace, { recursive: true });
    return sourceWorkspace;
  };

  it("syncs merged skills into a target workspace", async () => {
    const sourceWorkspace = await cloneSourceTemplate();
    const targetWorkspace = await createCaseDir("target");
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

    const skillUsagePaths = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      config: { skills: { load: { extraDirs: [extraDir] } } },
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
    });

    expect(skillUsagePaths).toEqual([
      {
        readPath: path.join(targetWorkspace, "skills", "demo-skill", "SKILL.md"),
        skillFile: path.join(workspaceSkillDir, "SKILL.md"),
        skillName: "demo-skill",
        skillSource: "workspace",
      },
    ]);

    const prompt = buildPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(await pathExists(path.join(targetWorkspace, "skills", "demo-skill", ".git"))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(targetWorkspace, "skills", "demo-skill", "node_modules")),
    ).toBe(false);
  });

  it("skips discovery and copying when the synced snapshot still matches", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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
    const copy = vi.spyOn(fs, "cp");
    const second = await syncWorkspaceSkills(params);
    const copyCount = copy.mock.calls.length;
    copy.mockRestore();

    expect(second).toEqual(first);
    expect(copyCount).toBe(0);
    expect(await pathExists(path.join(targetWorkspace, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(targetWorkspace, "skills", "hidden", "SKILL.md"))).toBe(true);
  });

  it.each([
    { source: "execution", snapshot: true },
    { source: "workspace", snapshot: true },
    { source: "workspace", snapshot: false },
    { source: "workshop", snapshot: true },
    { source: "workshop", snapshot: false },
  ] as const)(
    "replaces same-name $source skills with snapshot=$snapshot",
    async ({ source, snapshot }) => {
      const agentWorkspace = await createCaseDir("agent-workspace");
      const firstWorkspace = await createCaseDir("source-a");
      const secondWorkspace = await createCaseDir("source-b");
      const targetWorkspace = await createCaseDir("target");
      const skillName = "shared-skill";
      const config = {
        plugins: { enabled: false },
        agents: {
          entries: {
            alpha: { agentDir: path.join(firstWorkspace, "agent"), workspace: agentWorkspace },
            beta: { agentDir: path.join(secondWorkspace, "agent"), workspace: agentWorkspace },
          },
        },
      } satisfies OpenClawConfig;
      const roots = [
        { agentId: "alpha", workspace: firstWorkspace },
        { agentId: "beta", workspace: secondWorkspace },
      ].map(({ agentId, workspace }) => ({
        agentId: source === "workshop" ? agentId : undefined,
        workspaceDir: source === "workspace" ? workspace : agentWorkspace,
        executionSkillsDir: source === "execution" ? path.join(workspace, "skills") : undefined,
        skillDir: path.join(
          source === "workshop"
            ? resolveWorkshopSkillsDir(config, agentId)
            : path.join(workspace, "skills"),
          skillName,
        ),
        description: `${agentId}'s procedure`,
      }));
      for (const root of roots) {
        await writeSkill({ dir: root.skillDir, name: skillName, description: root.description });
        await fs.writeFile(path.join(root.skillDir, "instructions.txt"), root.description);
      }
      const snapshotVersion = getSkillsSnapshotVersion(agentWorkspace);
      for (const root of [roots[0]!, roots[1]!, roots[0]!]) {
        const skillsSnapshot = snapshot
          ? resolveReusableWorkspaceSkillSnapshot({
              workspaceDir: root.workspaceDir,
              executionSkillsDir: root.executionSkillsDir,
              agentId: root.agentId,
              config,
              skillFilter: [skillName],
              snapshotVersion,
              watch: false,
            }).snapshot
          : undefined;
        const usage = await syncWorkspaceSkills({
          sourceWorkspaceDir: root.workspaceDir,
          targetWorkspaceDir: targetWorkspace,
          agentId: root.agentId,
          config,
          skillFilter: [skillName],
          bundledSkillsDir: path.join(agentWorkspace, ".bundled"),
          managedSkillsDir: path.join(agentWorkspace, ".managed"),
          skillsSnapshot,
        });
        const syncedSkillDir = path.join(targetWorkspace, "skills", skillName);
        expect(await fs.readFile(path.join(syncedSkillDir, "SKILL.md"), "utf8")).toContain(
          root.description,
        );
        expect(await fs.readFile(path.join(syncedSkillDir, "instructions.txt"), "utf8")).toBe(
          root.description,
        );
        expect(usage).toEqual([
          {
            readPath: path.join(syncedSkillDir, "SKILL.md"),
            skillFile: path.join(root.skillDir, "SKILL.md"),
            skillName,
            skillSource: "workspace",
          },
        ]);
      }
    },
  );

  it("rejects path-like tampering without deriving read paths from the manifest", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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

    const copy = vi.spyOn(fs, "cp");
    const usagePaths = await syncWorkspaceSkills(syncParams);
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

  it("incrementally adds and removes skills while preserving unchanged destinations", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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
    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "beta"],
      skillsSnapshot: firstSnapshot,
    });
    const preservedMarker = path.join(targetWorkspace, "skills", "alpha", "preserved.txt");
    await fs.writeFile(preservedMarker, "preserved");

    const secondSnapshot = buildSkillSnapshot(sourceWorkspace, {
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "gamma"],
      snapshotVersion,
    });
    const copy = vi.spyOn(fs, "cp");
    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      bundledSkillsDir,
      managedSkillsDir,
      skillFilter: ["alpha", "gamma"],
      skillsSnapshot: secondSnapshot,
    });
    const copyCount = copy.mock.calls.length;
    copy.mockRestore();

    expect(copyCount).toBe(1);
    expect(await fs.readFile(preservedMarker, "utf8")).toBe("preserved");
    expect(await pathExists(path.join(targetWorkspace, "skills", "beta"))).toBe(false);
    expect(await pathExists(path.join(targetWorkspace, "skills", "gamma", "SKILL.md"))).toBe(true);
  });

  it("refreshes same-key skill trees after the watcher version changes", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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
      await fs.readFile(path.join(targetWorkspace, "skills", "alpha", "asset.txt"), "utf8"),
    ).toBe("after");
    expect(await pathExists(path.join(targetWorkspace, "skills", "alpha", "removed.txt"))).toBe(
      false,
    );
  });

  it("does not publish a manifest when a refreshed copy fails", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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
    const copy = vi.spyOn(fs, "cp").mockRejectedValueOnce(new Error("injected copy failure"));
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    copy.mockRestore();

    const manifestPath = path.join(targetWorkspace, "skills", ".openclaw-sync.json");
    expect(await pathExists(manifestPath)).toBe(false);
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await pathExists(manifestPath)).toBe(true);
    expect(
      await fs.readFile(path.join(targetWorkspace, "skills", "alpha", "asset.txt"), "utf8"),
    ).toBe("after");

    const interruptedTemp = path.join(targetWorkspace, "skills", ".openclaw-sync.interrupted.tmp");
    await fs.rm(manifestPath);
    await fs.writeFile(interruptedTemp, "partial");
    await syncWorkspaceSkills({ ...syncParams, skillsSnapshot: secondSnapshot });
    expect(await pathExists(interruptedTemp)).toBe(false);
    expect(await pathExists(manifestPath)).toBe(true);
  });

  it.runIf(process.platform !== "win32")(
    "preserves the target skills directory while refreshing children",
    async () => {
      const sourceWorkspace = await cloneSourceTemplate();
      const targetWorkspace = await createCaseDir("target");
      const targetSkillsDir = path.join(targetWorkspace, "skills");
      await fs.mkdir(path.join(targetSkillsDir, "stale"), { recursive: true });
      await fs.writeFile(path.join(targetSkillsDir, "stale", "SKILL.md"), "# Stale\n", "utf8");
      const before = await fs.stat(targetSkillsDir);

      await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

      const after = await fs.stat(targetSkillsDir);
      expect(after.ino).toBe(before.ino);
      expect(await pathExists(path.join(targetSkillsDir, "stale", "SKILL.md"))).toBe(false);
      expect(await pathExists(path.join(targetSkillsDir, "demo-skill", "SKILL.md"))).toBe(true);
    },
  );

  it("syncs the explicit agent skill subset instead of inherited defaults", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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

    await syncWorkspaceSkills({
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

    const prompt = buildPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Underscore variant");
    expect(prompt).not.toContain("Dot variant");
    expect(await pathExists(path.join(targetWorkspace, "skills", "foo_bar", "SKILL.md"))).toBe(
      true,
    );
    expect(await pathExists(path.join(targetWorkspace, "skills", "foo.dot", "SKILL.md"))).toBe(
      false,
    );
  });
  it.runIf(process.platform !== "win32")(
    "does not sync workspace skills that resolve outside the source workspace root",
    async () => {
      const sourceWorkspace = await createCaseDir("source");
      const targetWorkspace = await createCaseDir("target");
      const outsideRoot = await createCaseDir("outside");
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
        await pathExists(path.join(targetWorkspace, "skills", "escaped-skill", "SKILL.md")),
      ).toBe(false);
    },
  );
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
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
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
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
    const workspaceDir = await createCaseDir("workspace");
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
    const workspaceDir = await createCaseDir("workspace");
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
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
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

    expect(await pathExists(path.join(targetWorkspace, "skills", "remote-only", "SKILL.md"))).toBe(
      true,
    );
  });

  it("syncs managed symlinked skills as real directories in the target workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const managedDir = path.join(sourceWorkspace, ".managed");
    const skillName = "managed-linked";
    const targetSkillDir = path.join(await createCaseDir("manager-cache"), ".hidden-target");
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

    await withEnvAsync({ HOME: sourceWorkspace }, () =>
      syncWorkspaceSkills({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        managedSkillsDir: managedDir,
        skillFilter: [skillName],
      }),
    );

    const syncedSkillDir = path.join(targetWorkspace, "skills", skillName);
    expect(await pathExists(path.join(syncedSkillDir, "SKILL.md"))).toBe(true);
    expect((await fs.lstat(syncedSkillDir)).isSymbolicLink()).toBe(false);
    expect(await pathExists(path.join(targetWorkspace, "skills", ".hidden-target"))).toBe(false);
    expect(
      buildWorkspaceSkillsPrompt(targetWorkspace, {
        bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
        managedSkillsDir: path.join(targetWorkspace, ".managed"),
        skillFilter: [skillName],
      }),
    ).toContain("Managed symlink target");
  });
});

describe("syncWorkspaceSkills for plugin skills", () => {
  it("syncs plugin skills from symlinked directories to sandbox workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");

    const realPluginSkillDir = await createCaseDir("real-plugin-skill");
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

    mockResolvePluginSkillRoots.mockReturnValueOnce([
      { dir: realPluginSkillDir, rejectHardlinks: true },
    ]);

    const skillUsagePaths = await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    const syncedSkillDir = path.join(targetWorkspace, "skills", "wiki-maintainer");
    const syncedSkillMd = path.join(syncedSkillDir, "SKILL.md");
    const syncedStat = await fs.lstat(syncedSkillDir);
    const prompt = buildWorkspaceSkillsPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    }).replaceAll("\\", "/");

    expect(await pathExists(syncedSkillMd)).toBe(true);
    expect(syncedStat.isSymbolicLink()).toBe(false);
    expect(prompt).toContain("Wiki maintenance skill for sandboxed agents");
    expect(prompt).toContain("skills/wiki-maintainer/SKILL.md");
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
    const sourceWorkspace = await createCaseDir("source-multi");
    const targetWorkspace = await createCaseDir("target-multi");

    // Create multiple real plugin skill directories
    const realSkillA = await createCaseDir("skill-a");
    await writeSkill({
      dir: realSkillA,
      name: "browser-automation",
      description: "Browser automation skill",
    });

    const realSkillB = await createCaseDir("skill-b");
    await writeSkill({
      dir: realSkillB,
      name: "obsidian-vault",
      description: "Obsidian vault maintenance skill",
    });

    // Create plugin-skills directory with symlinks
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

    mockResolvePluginSkillRoots.mockReturnValueOnce([
      { dir: realSkillA, rejectHardlinks: true },
      { dir: realSkillB, rejectHardlinks: true },
    ]);

    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    // Both skills should be synced
    expect(
      await pathExists(path.join(targetWorkspace, "skills", "browser-automation", "SKILL.md")),
    ).toBe(true);
    expect(
      await pathExists(path.join(targetWorkspace, "skills", "obsidian-vault", "SKILL.md")),
    ).toBe(true);
  });

  it("does not sync plugin skills that escape allowed root", async () => {
    const sourceWorkspace = await createCaseDir("source-escape");
    const targetWorkspace = await createCaseDir("target-escape");

    // Create a skill outside any allowed root
    const outsideRoot = await createCaseDir("outside-root");
    const escapedSkillDir = path.join(outsideRoot, "escaped-skill");
    await writeSkill({
      dir: escapedSkillDir,
      name: "escaped-skill",
      description: "Should not be synced",
    });

    // Create plugin-skills with symlink to escaped skill
    const pluginSkillsDir = path.join(sourceWorkspace, ".openclaw", "plugin-skills");
    await fs.mkdir(pluginSkillsDir, { recursive: true });
    await fs.symlink(
      escapedSkillDir,
      path.join(pluginSkillsDir, "escaped-skill"),
      process.platform === "win32" ? "junction" : "dir",
    );

    // Mock returns an allowed root that doesn't include the escaped skill
    const allowedRoot = await createCaseDir("allowed-root");
    mockResolvePluginSkillRoots.mockReturnValueOnce([{ dir: allowedRoot, rejectHardlinks: true }]);

    await syncWorkspaceSkills({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      pluginSkillsDir,
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    // Escaped skill should NOT be synced
    expect(
      await pathExists(path.join(targetWorkspace, "skills", "escaped-skill", "SKILL.md")),
    ).toBe(false);
  });
});
