import fs from "node:fs/promises";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
import { getSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { writeWorkspaceSkills } from "../test-support/e2e-test-helpers.js";
import { resolveSkillCollectionBackupRoot } from "./collection-paths.js";
import {
  listWritableSkillCollection,
  reconcileSkillCollection,
  restoreLatestSkillCollectionBackup,
} from "./collection-reconcile.js";
import { getArchivedSkillFiles } from "./curator.js";
import { readSkillProposalTargetTreeSha256 } from "./proposal-bundle.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
} from "./service.js";

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
});

afterEach(async () => {
  closeOpenClawStateDatabaseForTest();
  await testState.cleanup();
  await tempDirs.cleanup();
});

describe("skill collection backup and restore", () => {
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
          name: "procedure",
          description: "First rewrite",
          content: "# First rewrite\n",
        },
      ],
    });
    const beforeVersion = getSkillsSnapshotVersion();
    const backupRoot = path.join(testState.stateDir, "skill-workshop", "collection-backups");
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
              name: "procedure",
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
      fs.readFile(path.join(workspaceDir, "skills", "procedure", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Second rewrite");
  });

  it("preserves an external edit made after backup validation", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Procedure", body: "# Original\n" },
    ]);
    const skillDir = path.join(workspaceDir, "skills", "procedure");
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
            name: "procedure",
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
          name: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillFile = path.join(workspaceDir, "skills", "procedure", "SKILL.md");
    await fs.appendFile(skillFile, "\nManual improvement.\n");

    await expect(
      restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env }),
    ).rejects.toThrow("changed after cleanup");
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("Manual improvement.");
  });

  it("restores an owned skill without rewriting a kept external skill", async () => {
    await writeWorkshopOwnedSkills([
      { name: "owned", description: "Workshop procedure", body: "# Owned original\n" },
    ]);
    await writeWorkspaceSkills(workspaceDir, [
      { name: "external", description: "Operator procedure", body: "# External original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          name: "owned",
          description: "Updated Workshop procedure",
          content: "# Owned updated\n",
        },
        { action: "keep", name: "external" },
      ],
    });
    const externalFile = path.join(workspaceDir, "skills", "external", "SKILL.md");
    await fs.appendFile(externalFile, "\nOperator edit after cleanup.\n");

    await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });

    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "owned", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Owned original");
    await expect(fs.readFile(externalFile, "utf8")).resolves.toContain(
      "Operator edit after cleanup.",
    );
  });

  it("restores ownership for a dropped Workshop skill", async () => {
    await writeWorkshopOwnedSkills([
      { name: "foo", description: "Workshop procedure", body: "# Original\n" },
    ]);
    await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [{ action: "drop", name: "foo", reason: "Temporarily removed" }],
    });

    await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });

    expect(listWritableSkillCollection(workspaceDir, { env: testState.env })).toEqual([
      expect.objectContaining({ name: "foo", workshopOwned: true }),
    ]);
    await expect(
      reconcileSkillCollection({
        workspaceDir,
        env: testState.env,
        ...(await readCollectionReceipt()),
        plan: [
          {
            action: "write",
            name: "foo",
            description: "Restored procedure",
            content: "# Restored and mutable\n",
          },
        ],
      }),
    ).resolves.toMatchObject({ written: ["foo"] });
  });

  it("restores a legacy backup that predates ownership narrowing", async () => {
    await writeWorkshopOwnedSkills([
      { name: "owned", description: "Workshop procedure", body: "# Owned original\n" },
    ]);
    await writeWorkspaceSkills(workspaceDir, [
      { name: "external", description: "Operator procedure", body: "# External original\n" },
    ]);
    const result = await reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...(await readCollectionReceipt()),
      plan: [
        {
          action: "write",
          name: "owned",
          description: "Updated Workshop procedure",
          content: "# Owned updated\n",
        },
        { action: "keep", name: "external" },
      ],
    });
    const backupDir = path.join(
      resolveSkillCollectionBackupRoot(workspaceDir, testState.env),
      result.backupId,
    );
    const manifestFile = path.join(backupDir, "manifest.json");
    const manifest = asNullableRecord(JSON.parse(await fs.readFile(manifestFile, "utf8")));
    const resultSkillHashes = asNullableRecord(manifest?.resultSkillHashes);
    if (!manifest || !resultSkillHashes) {
      throw new Error("Expected a valid collection backup manifest.");
    }
    const externalDir = "skills/external";
    await fs.cp(
      path.join(workspaceDir, externalDir),
      path.join(backupDir, "workspace", externalDir),
      { recursive: true },
    );
    manifest.skillDirs = ["skills/owned", externalDir];
    manifest.resultSkillDirs = ["skills/owned", externalDir];
    manifest.resultSkillHashes = {
      ...resultSkillHashes,
      [externalDir]: await readSkillProposalTargetTreeSha256(path.join(workspaceDir, externalDir)),
    };
    await fs.writeFile(manifestFile, JSON.stringify(manifest, null, 2));

    await restoreLatestSkillCollectionBackup({ workspaceDir, env: testState.env });

    await expect(
      fs.readFile(path.join(workspaceDir, "skills", "owned", "SKILL.md"), "utf8"),
    ).resolves.toContain("# Owned original");
    await expect(
      fs.readFile(path.join(workspaceDir, externalDir, "SKILL.md"), "utf8"),
    ).resolves.toContain("# External original");
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
          name: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillFile = path.join(workspaceDir, "skills", "procedure", "SKILL.md");
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
          name: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillDir = path.join(workspaceDir, "skills", "procedure");
    const skillFile = path.join(skillDir, "SKILL.md");
    const backupRoot = path.join(
      await fs.realpath(testState.stateDir),
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
          name: "procedure",
          description: "Clean procedure",
          content: "# Clean\n",
        },
      ],
    });
    const skillDir = path.join(workspaceDir, "skills", "procedure");
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

  it("preserves archived lifecycle state when backup commit fails", async () => {
    await writeWorkshopOwnedSkills([
      { name: "archived", description: "Archived procedure", body: "# Original\n" },
    ]);
    const skillFile = path.join(workspaceDir, "skills", "archived", "SKILL.md");
    openOpenClawStateDatabase({ env: testState.env })
      .db.prepare(
        `INSERT INTO skill_lifecycle (
          skill_file, skill_key, skill_name, state, pinned,
          state_changed_at_ms, created_at_ms, archived_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(skillFile, "archived", "Archived", "archived", 0, 10, 1, "unused");
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
            name: "archived",
            description: "Rewritten archived procedure",
            content: "# Rewritten\n",
          },
        ],
      }),
    ).rejects.toThrow("forced backup commit failure");
    renameSpy.mockRestore();

    expect(getArchivedSkillFiles({ env: testState.env })).toEqual(new Set([skillFile]));
    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
  });

  it("keeps proposal reads behind a failed collection create rollback", async () => {
    const proposal = await proposeCreateSkill({
      workspaceDir,
      env: testState.env,
      name: "Collection Candidate",
      description: "Remain pending if collection creation rolls back.",
      content: "# Collection Candidate\n\nCreated by collection reconciliation.\n",
    });
    const receipt = await readCollectionReceipt();
    const originalRename = fs.rename.bind(fs);
    let releaseCommit: (() => void) | undefined;
    let markCommitAttempted: (() => void) | undefined;
    const commitAttempted = new Promise<void>((resolve) => {
      markCommitAttempted = resolve;
    });
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
      if (String(oldPath).includes(`${path.sep}.pending-`)) {
        markCommitAttempted?.();
        await new Promise<void>((resolve) => {
          releaseCommit = resolve;
        });
        throw new Error("forced backup commit failure");
      }
      await originalRename(oldPath, newPath);
    });

    const reconciliation = reconcileSkillCollection({
      workspaceDir,
      env: testState.env,
      ...receipt,
      plan: [
        {
          action: "write",
          name: proposal.record.target.skillKey,
          description: "Created during a collection mutation.",
          content: "# Collection Candidate\n\nTransient collection content.\n",
        },
      ],
    });
    try {
      await commitAttempted;
      let listSettled = false;
      let inspectSettled = false;
      const listing = listSkillProposals({ workspaceDir, env: testState.env }).finally(() => {
        listSettled = true;
      });
      const inspection = inspectSkillProposal(proposal.record.id, {
        workspaceDir,
        env: testState.env,
      }).finally(() => {
        inspectSettled = true;
      });

      await new Promise((resolve) => {
        setTimeout(resolve, 50);
      });
      expect(listSettled).toBe(false);
      expect(inspectSettled).toBe(false);

      releaseCommit?.();
      await expect(reconciliation).rejects.toThrow("forced backup commit failure");
      const listed = await listing;
      expect(listed).toMatchObject({
        proposals: expect.arrayContaining([
          expect.objectContaining({ id: proposal.record.id, status: "pending" }),
        ]),
      });
      expect(listed.proposals).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "create",
            skillKey: proposal.record.target.skillKey,
            status: "applied",
          }),
        ]),
      );
      // The collection-staged create must be retired, not linger pending
      // against a missing skill and consume the maxPending budget.
      expect(listed.proposals).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "create",
            skillKey: proposal.record.target.skillKey,
            status: "rejected",
          }),
        ]),
      );
      await expect(inspection).resolves.toMatchObject({
        record: { id: proposal.record.id, status: "pending" },
      });
    } finally {
      releaseCommit?.();
      renameSpy.mockRestore();
    }

    await expect(fs.access(proposal.record.target.skillFile)).rejects.toThrow();
  });

  it("restores a staged drop when backup commit fails", async () => {
    await writeWorkshopOwnedSkills([
      { name: "obsolete", description: "Obsolete procedure", body: "# Original\n" },
    ]);
    const skillFile = path.join(workspaceDir, "skills", "obsolete", "SKILL.md");
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
          plan: [{ action: "drop", name: "obsolete", reason: "obsolete" }],
        }),
      ).rejects.toThrow("forced backup commit failure");
    } finally {
      renameSpy.mockRestore();
    }

    await expect(fs.readFile(skillFile, "utf8")).resolves.toContain("# Original");
    expect(listWritableSkillCollection(workspaceDir, { env: testState.env })).toEqual([
      expect.objectContaining({ name: "obsolete", workshopOwned: true }),
    ]);
  });

  it("preserves a concurrent edit when backup commit and rollback fail", async () => {
    await writeWorkshopOwnedSkills([
      { name: "procedure", description: "Original procedure", body: "# Original\n" },
    ]);
    const skillFile = path.join(workspaceDir, "skills", "procedure", "SKILL.md");
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
            name: "procedure",
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

async function readCollectionReceipt(config?: OpenClawConfig) {
  const skills = listWritableSkillCollection(workspaceDir, { config, env: testState.env });
  return {
    readSkillHashes: new Map(
      await Promise.all(
        skills.map(
          async (skill) =>
            [skill.name, sha256Hex(await fs.readFile(skill.filePath, "utf8"))] as const,
        ),
      ),
    ),
    readSkillTreeHashes: new Map(
      await Promise.all(
        skills.map(
          async (skill) =>
            [skill.name, await readSkillProposalTargetTreeSha256(skill.baseDir)] as const,
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
      env: testState.env,
      name: skill.name,
      description: skill.description,
      content: skill.body ?? `# ${skill.name}\n`,
    });
    await applySkillProposal({
      workspaceDir,
      env: testState.env,
      proposalId: proposal.record.id,
      expectedRevisionHash: proposal.revisionHash,
    });
  }
  dispatchCommittedSkillChangeBestEffort.mockClear();
  snapshotCommittedSkillArtifactBestEffort.mockClear();
}
