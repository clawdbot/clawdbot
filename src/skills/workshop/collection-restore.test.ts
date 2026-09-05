import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { bumpSkillsSnapshotVersion, getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import {
  reconcileSkillCollection as reconcileSkillCollectionImpl,
  restoreLatestSkillCollectionBackup as restoreLatestSkillCollectionBackupImpl,
} from "./collection-reconcile.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import { applySkillProposal, proposeCreateSkill } from "./service.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { listWritableWorkshopSkillSummaries } from "./workspace-skill-read.js";

type CopyDirectoryHook = (
  source: unknown,
  destination: unknown,
  options?: unknown,
) => Promise<void>;

const copyDirectoryBefore = vi.hoisted(() => vi.fn<CopyDirectoryHook>(async () => {}));
const copyDirectoryAfter = vi.hoisted(() => vi.fn<CopyDirectoryHook>(async () => {}));
const dispatchCommittedSkillChangeBestEffort = vi.hoisted(() =>
  vi.fn(async (_event: { action: string }) => {}),
);
const snapshotCommittedSkillArtifactBestEffort = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  const cp: typeof actual.cp = async (source, destination, options) => {
    await copyDirectoryBefore(source, destination, options);
    await actual.cp(source, destination, options);
    await copyDirectoryAfter(source, destination, options);
  };
  const patched = { ...actual, cp };
  return { ...patched, default: patched };
});
vi.mock("../lifecycle/skill-change-hook.js", () => ({
  hasCommittedSkillChangeHooks: () => true,
  snapshotCommittedSkillArtifactBestEffort,
  dispatchCommittedSkillChangeBestEffort,
}));

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;
let workspaceDir: string;
let skillsRoot: string;

const workshopParams = { config: {}, agentId: "main" };
type WorkshopOperationParams<T extends object> = Omit<T, keyof typeof workshopParams>;

const listWritableSkillCollection = (
  options?: WorkshopOperationParams<Parameters<typeof listWritableWorkshopSkillSummaries>[0]>,
) => listWritableWorkshopSkillSummaries({ ...workshopParams, ...options });
const reconcileSkillCollection = (
  params: WorkshopOperationParams<Parameters<typeof reconcileSkillCollectionImpl>[0]>,
) => reconcileSkillCollectionImpl({ ...workshopParams, ...params });
const restoreLatestSkillCollectionBackup = (
  params: WorkshopOperationParams<Parameters<typeof restoreLatestSkillCollectionBackupImpl>[0]>,
) => restoreLatestSkillCollectionBackupImpl({ ...workshopParams, ...params });

beforeEach(async () => {
  copyDirectoryBefore.mockReset();
  copyDirectoryBefore.mockResolvedValue(undefined);
  copyDirectoryAfter.mockReset();
  copyDirectoryAfter.mockResolvedValue(undefined);
  dispatchCommittedSkillChangeBestEffort.mockClear();
  snapshotCommittedSkillArtifactBestEffort.mockReset();
  snapshotCommittedSkillArtifactBestEffort.mockResolvedValue(undefined);
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-skill-collection-state-",
  });
  workspaceDir = await fs.realpath(await tempDirs.make("openclaw-skill-collection-workspace-"));
  skillsRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill collection backup and restore", () => {
  it("restores grouped Workshop skills under their declared keys and rejects escaping backup paths", async () => {
    const nestedDir = path.join(skillsRoot, "group", "folder-name");
    await fs.mkdir(nestedDir, { recursive: true });
    await fs.writeFile(
      path.join(nestedDir, "SKILL.md"),
      "---\nname: declared-name\ndescription: Nested procedure\n---\n\n# Nested\n",
      "utf8",
    );

    const result = await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [{ action: "drop", skillKey: "declared-name", reason: "Test restore" }],
    });
    await expect(fs.access(nestedDir)).rejects.toThrow();

    await expect(
      restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
    ).resolves.toMatchObject({ restored: ["declared-name"] });
    await expect(fs.readFile(path.join(nestedDir, "SKILL.md"), "utf8")).resolves.toContain(
      "# Nested",
    );
    expect(snapshotCommittedSkillArtifactBestEffort).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ skillKey: "declared-name" }),
    );
    expect(snapshotCommittedSkillArtifactBestEffort).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ skillKey: "declared-name" }),
    );
    expect(snapshotCommittedSkillArtifactBestEffort).toHaveBeenLastCalledWith(
      expect.objectContaining({ skillKey: "declared-name" }),
    );

    const manifestPath = path.join(
      testState.stateDir,
      "agents",
      "main",
      "agent",
      "skill-workshop",
      "collection-backups",
      result.backupId,
      "manifest.json",
    );
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    for (const invalidPath of [".", "../outside", path.resolve(skillsRoot, "outside")]) {
      const manifest = JSON.parse(originalManifest) as {
        skillDirs: string[];
        resultSkillDirs: string[];
        resultSkillHashes: Record<string, string>;
      };
      manifest.skillDirs = [invalidPath];
      manifest.resultSkillDirs = [];
      manifest.resultSkillHashes = {};
      await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
      await expect(
        restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
      ).rejects.toThrow("Skill collection backup path is outside the Skill Workshop directory");
    }
    await fs.writeFile(manifestPath, originalManifest, "utf8");
  });

  it("invalidates skill snapshots before backup pruning fails", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "procedure",
          description: "First rewrite",
          content: "# First rewrite\n",
        },
      ],
    });
    const beforeVersion = getSkillsSnapshotVersion();
    const backupRoot = resolveSkillCollectionBackupRoot(
      workshopParams.config,
      workshopParams.agentId,
      testState.env,
    );
    const originalReaddir = fs.readdir.bind(fs);
    const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation((async (...args: unknown[]) => {
      if (path.resolve(String(args[0])) === path.resolve(backupRoot)) {
        throw new Error("forced backup prune failure");
      }
      return await (originalReaddir as (...readdirArgs: unknown[]) => Promise<unknown>)(...args);
    }) as typeof fs.readdir);
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      await expect(
        reconcileSkillCollection({
          workspaceDir,
          env: testState.env,
          ...(await readCollectionReceipt()),
          plan: [
            {
              action: "write",
              skillKey: "procedure",
              description: "Second rewrite",
              content: "# Second rewrite\n",
            },
          ],
        }),
      ).resolves.toMatchObject({ written: ["procedure"] });
    } finally {
      readdirSpy.mockRestore();
      consoleSpy.mockRestore();
    }

    expect(getSkillsSnapshotVersion()).toBeGreaterThan(beforeVersion);
    await expect(
      fs.readFile(path.join(skillsRoot, "procedure", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Second rewrite");
  });

  it("preserves an external edit made after backup validation", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Procedure", body: "# Original\n" },
    ]);
    const skillDir = path.join(skillsRoot, "procedure");
    const supportFile = path.join(skillDir, "references", "live.md");
    await fs.mkdir(path.dirname(supportFile), { recursive: true });
    await fs.writeFile(supportFile, "Before\n", "utf8");
    const receipt = await readCollectionReceipt();
    snapshotCommittedSkillArtifactBestEffort.mockImplementationOnce(async () => {
      await fs.appendFile(supportFile, "External edit\n", "utf8");
      return undefined;
    });

    await expect(
      reconcileSkillCollection({
        workspaceDir,
        env: testState.env,
        ...receipt,
        plan: [
          {
            action: "write",
            skillKey: "procedure",
            description: "Rewritten procedure",
            content: "# Rewritten\n",
          },
        ],
      }),
    ).rejects.toThrow("Skill tree changed before collection mutation: procedure");

    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toContain(
      "# Original",
    );
    await expect(fs.readFile(supportFile, "utf8")).resolves.toContain("External edit");
  });

  it("refuses to restore over a skill changed after cleanup", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
    await fs.appendFile(skillFile, "\nManual improvement.\n");

    await expect(
      restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
    ).rejects.toThrow("changed after cleanup");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Manual improvement.");
  });

  it.each(["unchanged", "edited", "file-deleted", "subtree-deleted"])(
    "preserves a legacy backup and %s deep content when restore cannot verify the tree",
    async (deepContent) => {
      await writeWorkshopOwnedSkills([
        { name: "procedure", description: "Original procedure", body: "# Original\n" },
      ]);
      const result = await reconcileSkillCollection({
        workspaceDir,
        env: testState.env,
        ...(await readCollectionReceipt()),
        plan: [
          {
            action: "write",
            skillKey: "procedure",
            description: "Clean procedure",
            content: "# Clean\n",
          },
        ],
      });
      const skillDir = path.join(skillsRoot, "procedure");
      const backupDir = path.join(
        resolveSkillCollectionBackupRoot(
          workshopParams.config,
          workshopParams.agentId,
          testState.env,
        ),
        result.backupId,
      );
      const backupSkillDir = path.join(backupDir, "skills", "procedure");
      const deepPath = path.join(
        "references",
        ...Array.from({ length: 16 }, (_, index) => `d${index}`),
        "proof.txt",
      );
      const currentDeepFile = path.join(skillDir, deepPath);
      const backupDeepFile = path.join(backupSkillDir, deepPath);
      // The old sixteen-level digest omitted these files, just as if they were absent.
      // Keep the real shallow result digest to recreate that legacy backup without a mock.
      await fs.mkdir(path.dirname(backupDeepFile), { recursive: true });
      await fs.writeFile(backupDeepFile, "Original support\n");
      await fs.mkdir(path.dirname(currentDeepFile), { recursive: true });
      await fs.writeFile(
        currentDeepFile,
        deepContent === "edited" ? "Later operator edit\n" : "Original support\n",
      );
      if (deepContent === "file-deleted") {
        await fs.rm(currentDeepFile);
      } else if (deepContent === "subtree-deleted") {
        await fs.rm(path.dirname(currentDeepFile), { recursive: true });
      }
      const preservedFiles = [
        path.join(skillDir, "SKILL.md"),
        ...(["file-deleted", "subtree-deleted"].includes(deepContent) ? [] : [currentDeepFile]),
        path.join(backupSkillDir, "SKILL.md"),
        backupDeepFile,
        path.join(backupDir, "manifest.json"),
      ];
      const snapshot = async () => ({
        bytes: await Promise.all(preservedFiles.map((file) => fs.readFile(file))),
        entries: await Promise.all(
          [skillsRoot, backupDir].map(async (dir) =>
            (await fs.readdir(dir, { recursive: true })).toSorted(),
          ),
        ),
      });
      const before = await snapshot();
      dispatchCommittedSkillChangeBestEffort.mockClear();
      snapshotCommittedSkillArtifactBestEffort.mockClear();

      await expect(
        restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
      ).rejects.toThrow("Skill evaluation bundle exceeds traversal limits.");

      expect(await snapshot()).toEqual(before);
      expect(dispatchCommittedSkillChangeBestEffort).not.toHaveBeenCalled();
      expect(snapshotCommittedSkillArtifactBestEffort).not.toHaveBeenCalled();
    },
  );

  it("restores an owned skill without rewriting a kept external skill", async () => {
    await writeWorkshopOwnedSkills([
      { name: "owned", description: "Workshop procedure", body: "# Owned original\n" },
    ]);
    await writeWorkspaceSkills(workspaceDir, [
      { name: "external", description: "Operator procedure", body: "# External original\n" },
    ]);
    bumpSkillsSnapshotVersion({ workspaceDir, reason: "watch" });
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "owned",
          description: "Updated Workshop procedure",
          content: "# Owned updated\n",
        },
      ],
    });
    const externalFile = path.join(workspaceDir, "skills", "external", "SKILL.md");
    await fs.appendFile(externalFile, "\nOperator edit after cleanup.\n");

    await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });

    await expect(
      fs.readFile(path.join(skillsRoot, "owned", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Owned original");
    await expect(fs.readFile(externalFile, "utf8")).resolves.toContain(
      "Operator edit after cleanup.",
    );
  });

  it("restores the original collection and keeps directory containment as ownership", async () => {
    await writeWorkshopOwnedSkills([
      { name: "updated", description: "Updated procedure", body: "# Updated original\n" },
      { name: "dropped", description: "Dropped procedure", body: "# Dropped original\n" },
    ]);
    const result = await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "updated",
          description: "Updated procedure",
          content: "# Updated result\n",
        },
        { action: "drop", skillKey: "dropped", reason: "Temporarily removed" },
        {
          action: "write",
          skillKey: "created",
          description: "Created procedure",
          content: "# Created result\n",
        },
      ],
    });
    const deepPath = path.join(
      "dropped",
      "references",
      ...Array.from({ length: 16 }, (_, index) => `d${index}`),
      "proof.txt",
    );
    const savedDeepFile = path.join(
      resolveSkillCollectionBackupRoot(
        workshopParams.config,
        workshopParams.agentId,
        testState.env,
      ),
      result.backupId,
      "skills",
      deepPath,
    );
    // A dropped legacy skill has no current result whose digest can hide an edit.
    await fs.mkdir(path.dirname(savedDeepFile), { recursive: true });
    await fs.writeFile(savedDeepFile, "Original deep support\n");

    await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });
    await expect(fs.readFile(path.join(skillsRoot, deepPath), "utf8")).resolves.toBe(
      "Original deep support\n",
    );

    expect(listWritableSkillCollection({ env: testState.env })).toEqual([
      expect.objectContaining({ name: "dropped" }),
      expect.objectContaining({ name: "updated" }),
    ]);
    await fs.mkdir(path.join(skillsRoot, "created"), { recursive: true });
    await fs.writeFile(
      path.join(skillsRoot, "created", "SKILL.md"),
      "---\nname: created\ndescription: Recreated procedure\n---\n\n# Recreated\n",
      "utf8",
    );
    expect(listWritableSkillCollection({ env: testState.env })).toEqual([
      expect.objectContaining({ name: "created" }),
      expect.objectContaining({ name: "dropped" }),
      expect.objectContaining({ name: "updated" }),
    ]);
    await expect(
      reconcileSkillCollection({
        workspaceDir,
        env: testState.env,
        ...(await readCollectionReceipt(["updated"])),
        plan: [
          {
            action: "write",
            skillKey: "updated",
            description: "Restored procedure",
            content: "# Restored and mutable\n",
          },
        ],
      }),
    ).resolves.toMatchObject({ written: ["updated"] });
  });

  it("preserves an edit made while restore artifacts are captured", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
    snapshotCommittedSkillArtifactBestEffort.mockImplementationOnce(async () => {
      await fs.appendFile(skillFile, "\nManual improvement.\n");
      return undefined;
    });

    await expect(
      restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
    ).rejects.toThrow("changed after cleanup");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Manual improvement.");
  });

  it("rolls back a failed restore so the backup remains retryable", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillDir = path.join(skillsRoot, "procedure");
    const skillFile = path.join(skillDir, "SKILL.md");
    const backupRoot = path.join(
      await fs.realpath(testState.stateDir),
      "agents",
      "main",
      "agent",
      "skill-workshop",
      "collection-backups",
    );
    let failed = false;
    copyDirectoryBefore.mockImplementation(async (source, destination) => {
      if (
        !failed &&
        String(source).startsWith(backupRoot) &&
        !String(source).includes(`${path.sep}.restore-`) &&
        path.resolve(String(destination)) === path.resolve(skillDir)
      ) {
        failed = true;
        throw new Error("forced restore copy failure");
      }
    });

    try {
      await expect(
        restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
      ).rejects.toThrow("forced restore copy failure");
    } finally {
      copyDirectoryBefore.mockReset();
    }
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Clean");

    await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
  });

  it("invalidates skill snapshots when restore and rollback both fail", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          skillKey: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillDir = path.join(skillsRoot, "procedure");
    const beforeVersion = getSkillsSnapshotVersion();
    copyDirectoryBefore.mockImplementation(async (source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(skillDir)) {
        throw new Error(`forced restore copy failure: ${String(source)}`);
      }
    });

    try {
      await expect(
        restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
      ).rejects.toThrow("current collection was not restored");
    } finally {
      copyDirectoryBefore.mockReset();
    }

    expect(getSkillsSnapshotVersion()).toBeGreaterThan(beforeVersion);
    await expect(fs.access(skillDir)).rejects.toThrow();
  });

  it("preserves skill usage when a collection rewrite cannot commit", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Recorded procedure", body: "# Original\n" },
    ]);
    const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
    const database = openOpenClawStateDatabase({ env: testState.env }).db;
    database
      .prepare(
        `INSERT INTO skill_usage (
          skill_file, skill_key, skill_name, skill_source,
          first_used_at_ms, last_used_at_ms, use_count, last_agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(skillFile, "procedure", "Procedure", "openclaw-workspace", 1, 10, 3, "main");
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes(`${path.sep}.pending-`)) {
        throw new Error("forced backup commit failure");
      }
      await rename(oldPath, newPath);
    });

    await expect(
      reconcileSkillCollection({
        workspaceDir,
        env: testState.env,
        ...(await readCollectionReceipt()),
        plan: [
          {
            action: "write",
            skillKey: "procedure",
            description: "Rewritten recorded procedure",
            content: "# Rewritten\n",
          },
        ],
      }),
    ).rejects.toThrow("forced backup commit failure");
    renameSpy.mockRestore();

    expect(
      database.prepare("SELECT use_count FROM skill_usage WHERE skill_file = ?").get(skillFile),
    ).toEqual({ use_count: 3 });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
  });

  it("restores a staged drop when backup commit fails", async () => {
    await writeWorkshopOwnedSkills([
      { name: "obsolete", description: "Obsolete procedure", body: "# Original\n" },
    ]);
    const skillFile = path.join(skillsRoot, "obsolete", "SKILL.md");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes(`${path.sep}.pending-`)) {
        throw new Error("forced backup commit failure");
      }
      await originalRename(oldPath, newPath);
    });

    try {
      await expect(
        reconcileSkillCollection({
          workspaceDir,
          env: testState.env,
          ...(await readCollectionReceipt()),
          plan: [{ action: "drop", skillKey: "obsolete", reason: "obsolete" }],
        }),
      ).rejects.toThrow("forced backup commit failure");
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
    expect(listWritableSkillCollection({ env: testState.env })).toEqual([
      expect.objectContaining({ name: "obsolete" }),
    ]);
  });

  it("preserves a concurrent edit when backup commit and rollback fail", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    const skillFile = path.join(skillsRoot, "procedure", "SKILL.md");
    const rename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes(`${path.sep}.pending-`)) {
        await fs.appendFile(skillFile, "\nManual improvement.\n");
        throw new Error("forced backup commit failure");
      }
      await rename(oldPath, newPath);
    });

    await expect(
      reconcileSkillCollection({
        workspaceDir,
        env: testState.env,
        ...(await readCollectionReceipt()),
        plan: [
          {
            action: "write",
            skillKey: "procedure",
            description: "Rewritten procedure",
            content: "# Rewritten\n",
          },
        ],
      }),
    ).rejects.toThrow("could not be restored");
    renameSpy.mockRestore();

    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Manual improvement.");
  });
});

async function readCollectionReceipt(skillKeys?: readonly string[]) {
  const skills = listWritableSkillCollection({ env: testState.env }).filter(
    (skill) => !skillKeys || skillKeys.includes(skill.skillKey),
  );
  return {
    readSkillHashes: new Map(
      await Promise.all(
        skills.map(
          async (skill) =>
            [skill.skillKey, sha256Hex(await fs.readFile(skill.filePath, "utf8"))] as const,
        ),
      ),
    ),
    readSkillTreeHashes: new Map(
      await Promise.all(
        skills.map(
          async (skill) =>
            [skill.skillKey, await readSkillProposalTargetTreeSha256(skill.baseDir)] as const,
        ),
      ),
    ),
  };
}

async function writeWorkshopOwnedSkills(
  skills: ReadonlyArray<{ name: string; description: string; body?: string }>,
): Promise<void> {
  for (const skill of skills) {
    const proposal = await proposeCreateSkill({
      workspaceDir,
      config: {},
      agentId: "main",
      env: testState.env,
      name: skill.name,
      description: skill.description,
      content: skill.body ?? `# ${skill.name}\n`,
    });
    await applySkillProposal({
      workspaceDir,
      config: {},
      agentId: "main",
      env: testState.env,
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
  }
  dispatchCommittedSkillChangeBestEffort.mockClear();
  snapshotCommittedSkillArtifactBestEffort.mockClear();
}
