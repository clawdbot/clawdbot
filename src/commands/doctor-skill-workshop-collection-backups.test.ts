import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LEGACY_WORKSPACE_ATTESTATION_HEADER,
  resolveLegacyWorkspaceSourcePaths,
} from "../agents/workspace-legacy-state.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  detectLegacyWorkspaceState,
  migrateLegacyWorkspaceState,
} from "../infra/state-migrations.workspace-setup.js";
import type { CollectionBackupManifest } from "../skills/workshop/collection-backup.js";
import { resolveSkillCollectionBackupRoot } from "../skills/workshop/collection-paths.js";
import { restoreLatestSkillCollectionBackup } from "../skills/workshop/collection-restore.js";
import {
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "../skills/workshop/frontmatter.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import { applySkillProposal, proposeCreateSkill } from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import * as workshopStore from "../skills/workshop/store.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import * as collectionBackups from "./doctor-skill-workshop-collection-backups.js";
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";
import {
  createAppliedLegacyProposal,
  readSkillProposalRecord,
  seedLegacyV15ProposalRows,
} from "./doctor-skill-workshop-sqlite.test-support.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-doctor-workshop-sqlite-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

async function seedLegacyCollectionBackup(params: {
  workspaceDir: string;
  backupId: string;
  createdAt?: string;
  backupContent: string;
  resultContent?: string;
  relativeSkillDir?: string;
}): Promise<string> {
  const relativeSkillDir =
    params.relativeSkillDir ?? path.join("skills", "legacy-collection-skill");
  const legacyRoot = path.join(
    testState.stateDir,
    "skill-workshop",
    "collection-backups",
    "0000000000000000",
  );
  const backupDir = path.join(legacyRoot, params.backupId);
  const workspaceSkillDir = path.join(params.workspaceDir, relativeSkillDir);
  await fs.mkdir(path.join(backupDir, "workspace", relativeSkillDir), { recursive: true });
  const resultSkillHashes: Record<string, string> = {};
  if (params.resultContent !== undefined) {
    await fs.mkdir(workspaceSkillDir, { recursive: true });
    await fs.writeFile(path.join(workspaceSkillDir, "SKILL.md"), params.resultContent, "utf8");
    resultSkillHashes[relativeSkillDir] =
      await readSkillProposalTargetTreeSha256(workspaceSkillDir);
  }
  await fs.writeFile(
    path.join(backupDir, "workspace", relativeSkillDir, "SKILL.md"),
    params.backupContent,
    "utf8",
  );
  await fs.writeFile(
    path.join(backupDir, "manifest.json"),
    JSON.stringify({
      schema: "openclaw.skill-collection-backup.v1",
      id: params.backupId,
      createdAt: params.createdAt ?? "2026-09-01T00:00:00.000Z",
      workspaceDir: params.workspaceDir,
      skillDirs: [relativeSkillDir],
      resultSkillDirs: Object.keys(resultSkillHashes),
      resultSkillHashes,
    }),
    "utf8",
  );
  return legacyRoot;
}

async function seedOwnedLegacyCollectionBackup(name = "owned-legacy-backup") {
  const workspaceDir = await fs.realpath(
    await tempDirs.make("openclaw-workshop-owned-backup-workspace-"),
  );
  const proposal = await proposeCreateSkill({
    workspaceDir,
    config: {},
    agentId: "main",
    env: testState.env,
    name,
    description: "Owned legacy backup",
    content: "# Current\n",
  });
  const applied = await applySkillProposal({
    workspaceDir,
    config: {},
    agentId: "main",
    env: testState.env,
    proposalId: proposal.record.id,
    expectedRevisionHash: proposal.revisionHash,
  });
  const legacySkillDir = path.join(workspaceDir, "skills", name);
  const legacySkillFile = path.join(legacySkillDir, "SKILL.md");
  await fs.cp(applied.record.target.skillDir, legacySkillDir, { recursive: true });
  await fs.rm(applied.record.target.skillDir, { recursive: true });
  await workshopStore.updateSkillProposalRecord({
    record: {
      ...applied.record,
      target: {
        ...applied.record.target,
        skillDir: legacySkillDir,
        skillFile: legacySkillFile,
        source: "openclaw-workspace",
      },
    },
    store: { env: testState.env },
  });
  const resultContent = await fs.readFile(legacySkillFile, "utf8");
  const backupId = "2026-09-01T00-00-00.000Z-owned1";
  const backupContent = `---\nname: ${name}\ndescription: Owned legacy backup\n---\n\n# Before cleanup\n`;
  const legacyRoot = await seedLegacyCollectionBackup({
    workspaceDir,
    backupId,
    relativeSkillDir: path.join("skills", name),
    backupContent,
    resultContent,
  });
  const config = {
    agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
  };
  const sourceBackupDir = path.join(legacyRoot, backupId);
  const sourceMetadata = path.join(sourceBackupDir, "workspace", "skills", name, ".openclaw");
  await fs.mkdir(sourceMetadata);
  await fs.writeFile(path.join(sourceMetadata, "trace.json"), '{"source":"original"}\n');
  const destinationBackupDir = path.join(
    resolveSkillCollectionBackupRoot(config, "main", testState.env),
    backupId,
  );
  return {
    workspaceDir,
    config,
    name,
    backupId,
    backupContent,
    proposalId: applied.record.id,
    sourceBackupDir,
    destinationBackupDir,
  };
}

describe("doctor Skill Workshop collection backup migration", () => {
  it("ignores an empty recognized legacy collection backup root", async () => {
    const legacyRoot = path.join(
      testState.stateDir,
      "skill-workshop",
      "collection-backups",
      "0000000000000000",
    );
    await fs.mkdir(legacyRoot, { recursive: true });
    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({ legacyBackupRootCount: 0 });
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({ changes: [], warnings: [], migrated: 0 });
    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({ legacyBackupRootCount: 0 });
  });

  it("keeps an unowned legacy collection backup as history-only", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-legacy-backup-workspace-"),
    );
    const backupContent =
      "---\nname: legacy-collection-skill\ndescription: Legacy backup\n---\n\n# Before cleanup\n";
    const resultContent =
      "---\nname: legacy-collection-skill\ndescription: Current skill\n---\n\n# After cleanup\n";
    const backupId = "2026-09-01T00-00-00.000Z-legacy1";
    const legacyRoot = await seedLegacyCollectionBackup({
      workspaceDir,
      backupId,
      backupContent,
      resultContent,
    });
    const config = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };

    const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    expect(result.changes.join("\n")).toContain("migrated 1 legacy collection backup root");
    await expect(
      restoreLatestSkillCollectionBackup({
        workspaceDir,
        config,
        agentId: "main",
        env: testState.env,
      }),
    ).rejects.toThrow("history-only");
    await expect(fs.access(legacyRoot)).resolves.toBeUndefined();
    await expect(
      inspectLegacySkillWorkshopMigration({ config, env: testState.env }),
    ).resolves.toMatchObject({ legacyBackupRootCount: 0 });
    await expect(
      migrateLegacySkillWorkshopProposals({ config, env: testState.env }),
    ).resolves.toEqual(expect.objectContaining({ changes: [], migrated: 0, warnings: [] }));
    await expect(
      inspectLegacySkillWorkshopMigration({ config, env: testState.env }),
    ).resolves.toMatchObject({ legacyBackupRootCount: 0 });
  });

  it.each([
    { createdBy: "cli" as const, matchingReview: true },
    { createdBy: "skill-workshop" as const, matchingReview: true },
    { createdBy: "cli" as const, matchingReview: false },
  ])(
    "restores a $createdBy dropped skill only with its exact review receipt (matching: $matchingReview)",
    async ({ createdBy, matchingReview }) => {
      const workspaceDir = testState.workspaceDir;
      const name = "owned-legacy-drop";
      const skillDir = path.join(workspaceDir, "skills", name);
      const skillFile = path.join(skillDir, "SKILL.md");
      const now = "2026-08-31T00:00:00.000Z";
      const proposalContent = renderProposalMarkdown({
        name,
        description: "Dropped procedure",
        content: "# Saved procedure\n",
        date: now,
      });
      const content = stripProposalFrontmatterForSkill(proposalContent);
      const backupId = "2026-09-01T00-00-00.000Z-owned-drop";
      const legacyRoot = await seedLegacyCollectionBackup({
        workspaceDir,
        backupId,
        backupContent: content,
        relativeSkillDir: path.join("skills", name),
      });
      const record = createAppliedLegacyProposal({
        id: "owned-legacy-drop-20260831-1234567890",
        title: "Create dropped procedure",
        description: "Dropped procedure",
        createdAt: now,
        content: proposalContent,
        target: { skillKey: name, skillDir },
        createdBy,
      });
      await testState.writeText(
        path.join("skill-workshop", "proposals", record.id, "PROPOSAL.md"),
        proposalContent,
      );
      seedLegacyV15ProposalRows(testState.env, [
        {
          record,
          workspaceDir,
          claimReleasedTime: Date.parse("2026-09-01T00:00:01.000Z"),
        },
      ]);
      const databasePath = path.join(testState.stateDir, "state", "openclaw.sqlite");
      const legacy = openNodeSqliteDatabase(databasePath);
      try {
        legacy.exec(`
          DROP TABLE skill_workshop_collection_reviews;
          CREATE TABLE skill_workshop_collection_reviews (
            review_id TEXT NOT NULL PRIMARY KEY,
            workspace_dir TEXT NOT NULL,
            backup_id TEXT NOT NULL,
            create_time INTEGER NOT NULL,
            kept_names_json TEXT NOT NULL,
            written_names_json TEXT NOT NULL,
            dropped_json TEXT NOT NULL
          ) STRICT;
        `);
        legacy
          .prepare(
            `INSERT INTO skill_workshop_collection_reviews (
              review_id, workspace_dir, backup_id, create_time,
              kept_names_json, written_names_json, dropped_json
            ) VALUES (?, ?, ?, ?, '[]', '[]', ?)`,
          )
          .run(
            "owned-drop-review",
            workspaceDir,
            matchingReview ? backupId : "2026-08-30T00-00-00.000Z-other-review",
            Date.parse("2026-09-01T00:00:02.000Z"),
            JSON.stringify([{ name, reason: "Replaced by a retained procedure" }]),
          );
      } finally {
        legacy.close();
      }
      const config = {
        agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
      };

      const migration = await migrateLegacySkillWorkshopProposals({
        config,
        env: testState.env,
      });
      expect(migration.warnings).toEqual([]);
      await expect(
        readSkillProposalRecord(record.id, { env: testState.env }),
      ).resolves.toMatchObject({
        status: "stale",
        appliedAt: now,
        target: { skillDir, skillFile },
      });
      const restoredFile = path.join(
        resolveWorkshopSkillsDir(config, "main", testState.env),
        name,
        "SKILL.md",
      );
      const restore = restoreLatestSkillCollectionBackup({
        workspaceDir,
        config,
        agentId: "main",
        env: testState.env,
      });
      if (matchingReview) {
        await expect(restore).resolves.toEqual({ backupId, restored: [name], removed: [] });
        await expect(fs.readFile(restoredFile, "utf8")).resolves.toBe(content);
      } else {
        await expect(restore).rejects.toThrow("history-only");
        await expect(fs.access(restoredFile)).rejects.toThrow();
        await expect(fs.access(legacyRoot)).resolves.toBeUndefined();
      }
      await expect(fs.access(skillFile)).rejects.toThrow();
    },
  );

  it("resumes a mixed legacy root after archiving one backup and failing the next copy", async () => {
    const workspaceDir = testState.workspaceDir;
    const backups = [
      {
        id: "2026-09-01T00-00-00.000Z-first",
        content:
          "---\nname: legacy-collection-skill\ndescription: User procedure\n---\n\n# First saved procedure\n",
      },
      {
        id: "2026-09-01T00-00-00.000Z-second",
        content:
          "---\nname: legacy-collection-skill\ndescription: User procedure\n---\n\n# Second saved procedure\n",
      },
    ];
    const relativeSkillDir = path.join("skills", "legacy-collection-skill");
    const legacyRoot = path.join(
      testState.stateDir,
      "skill-workshop",
      "collection-backups",
      "0000000000000000",
    );
    for (const backup of backups) {
      await seedLegacyCollectionBackup({
        workspaceDir,
        backupId: backup.id,
        backupContent: backup.content,
        resultContent:
          "---\nname: legacy-collection-skill\ndescription: User procedure\n---\n\n# Current\n",
      });
    }
    const config = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    const backupSources = new Set(
      backups.map((backup) => path.join(legacyRoot, backup.id, "workspace")),
    );
    const copiedSources: string[] = [];
    const copy = fs.cp.bind(fs);
    const copySpy = vi.spyOn(fs, "cp").mockImplementation(async (source, destination, options) => {
      const sourcePath = String(source);
      if (backupSources.has(sourcePath) && copiedSources.length > 0) {
        throw new Error("injected second legacy backup copy failure");
      }
      await copy(source, destination, options);
      if (backupSources.has(sourcePath)) {
        copiedSources.push(sourcePath);
      }
    });
    try {
      const interrupted = await migrateLegacySkillWorkshopProposals({
        config,
        env: testState.env,
      });
      expect(interrupted.warnings).toEqual([
        expect.stringContaining("injected second legacy backup copy failure"),
      ]);
      expect(copiedSources).toHaveLength(1);
    } finally {
      copySpy.mockRestore();
    }

    const resumed = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });
    expect(resumed.warnings).toEqual([]);
    expect(resumed.changes.join("\n")).toContain("migrated 1 legacy collection backup root");
    const destinationRoot = resolveSkillCollectionBackupRoot(config, "main", testState.env);
    for (const backup of backups) {
      await expect(
        fs.readFile(
          path.join(
            destinationRoot,
            backup.id,
            "history",
            "workspace",
            relativeSkillDir,
            "SKILL.md",
          ),
          "utf8",
        ),
      ).resolves.toBe(backup.content);
      await expect(fs.access(path.join(legacyRoot, backup.id))).resolves.toBeUndefined();
    }
    await expect(
      inspectLegacySkillWorkshopMigration({ config, env: testState.env }),
    ).resolves.toMatchObject({ legacyBackupRootCount: 0 });
  });

  it("migrates the result snapshot for a Workshop-owned legacy collection backup", async () => {
    const { workspaceDir, config, backupId } = await seedOwnedLegacyCollectionBackup();

    const migrated = await migrateLegacySkillWorkshopProposals({
      config,
      env: testState.env,
    });
    expect(migrated.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 0 stale, and migrated 1 legacy collection backup root.",
    );
    await expect(
      restoreLatestSkillCollectionBackup({
        workspaceDir,
        config,
        agentId: "main",
        env: testState.env,
      }),
    ).resolves.toMatchObject({ backupId, restored: ["owned-legacy-backup"] });
    await expect(
      fs.readFile(
        path.join(
          resolveWorkshopSkillsDir(config, "main", testState.env),
          "owned-legacy-backup",
          "SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toContain("# Before cleanup");
  });

  it.each(["copy", "retirement"] as const)(
    "resumes a newest-first restorable backup batch after %s interruption",
    async (interruption) => {
      const fixture = await seedOwnedLegacyCollectionBackup();
      const legacyRoot = path.dirname(fixture.sourceBackupDir);
      const olderId = "2026-08-31T00-00-00.000Z-owned0";
      const olderSource = path.join(legacyRoot, olderId);
      const relativeSkillDir = path.join("skills", fixture.name);
      const olderContent = `${fixture.backupContent}\nEarlier saved procedure.\n`;
      await seedLegacyCollectionBackup({
        workspaceDir: fixture.workspaceDir,
        backupId: olderId,
        createdAt: "2026-08-31T00:00:00.000Z",
        relativeSkillDir,
        backupContent: olderContent,
        resultContent: await fs.readFile(
          path.join(fixture.workspaceDir, relativeSkillDir, "SKILL.md"),
          "utf8",
        ),
      });
      const backups = [
        { source: fixture.sourceBackupDir, id: fixture.backupId, content: fixture.backupContent },
        { source: olderSource, id: olderId, content: olderContent },
      ];
      const expectedHashes = await Promise.all(
        backups.map(({ source }) =>
          readSkillProposalTargetTreeSha256(path.join(source, "workspace", relativeSkillDir), {
            includeRootMetadata: true,
          }),
        ),
      );
      const readdir = fs.readdir.bind(fs);
      const readdirSpy = vi.spyOn(fs, "readdir").mockImplementation(async (directory, options) => {
        const entries = await readdir(directory, options);
        // Windows directory enumeration need not return timestamped backups oldest-first.
        return String(directory) === legacyRoot && options?.withFileTypes
          ? entries.toSorted((left, right) => String(right.name).localeCompare(String(left.name)))
          : entries;
      });
      const copy = fs.cp.bind(fs);
      const copySpy = vi
        .spyOn(fs, "cp")
        .mockImplementation(async (source, destination, options) => {
          if (
            interruption === "copy" &&
            String(source) === path.join(olderSource, "workspace", relativeSkillDir)
          ) {
            throw new Error("injected older backup copy failure");
          }
          await copy(source, destination, options);
        });
      const remove = fs.rm.bind(fs);
      const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (interruption === "retirement" && String(target) === fixture.sourceBackupDir) {
          throw new Error("injected newest backup retirement failure");
        }
        await remove(target, options);
      });
      try {
        const interrupted = await migrateLegacySkillWorkshopProposals({
          config: fixture.config,
          env: testState.env,
        });
        expect(interrupted.warnings).toEqual([
          expect.stringContaining(
            interruption === "copy"
              ? "injected older backup copy failure"
              : "injected newest backup retirement failure",
          ),
        ]);
        for (const backup of backups) {
          await expect(fs.access(backup.source)).resolves.toBeUndefined();
        }
        copySpy.mockRestore();
        removeSpy.mockRestore();

        const resumed = await migrateLegacySkillWorkshopProposals({
          config: fixture.config,
          env: testState.env,
        });
        expect(resumed.warnings).toEqual([]);
        const destinationRoot = path.dirname(fixture.destinationBackupDir);
        for (const [index, backup] of backups.entries()) {
          const destination = path.join(destinationRoot, backup.id, "skills", fixture.name);
          await expect(fs.readFile(path.join(destination, "SKILL.md"), "utf8")).resolves.toBe(
            backup.content,
          );
          await expect(
            readSkillProposalTargetTreeSha256(destination, { includeRootMetadata: true }),
          ).resolves.toBe(expectedHashes[index]);
          await expect(fs.access(backup.source)).rejects.toMatchObject({ code: "ENOENT" });
        }
        await expect(
          migrateLegacySkillWorkshopProposals({ config: fixture.config, env: testState.env }),
        ).resolves.toMatchObject({ changes: [], warnings: [] });
        await expect(
          restoreLatestSkillCollectionBackup({
            workspaceDir: fixture.workspaceDir,
            config: fixture.config,
            agentId: "main",
            env: testState.env,
          }),
        ).resolves.toMatchObject({ backupId: fixture.backupId, restored: [fixture.name] });
      } finally {
        copySpy.mockRestore();
        removeSpy.mockRestore();
        readdirSpy.mockRestore();
      }
    },
  );

  it.each(["unchanged", "metadata-bytes", "manifest"] as const)(
    "verifies a published restorable backup before retiring its source (%s)",
    async (destinationState) => {
      const fixture = await seedOwnedLegacyCollectionBackup();
      const sourceManifest = await fs.readFile(
        path.join(fixture.sourceBackupDir, "manifest.json"),
        "utf8",
      );
      const remove = fs.rm.bind(fs);
      const removeSpy = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
        if (String(target) === fixture.sourceBackupDir) {
          throw Object.assign(new Error("injected backup source retirement failure"), {
            code: "EACCES",
          });
        }
        await remove(target, options);
      });
      try {
        const first = await migrateLegacySkillWorkshopProposals({
          config: fixture.config,
          env: testState.env,
        });
        expect(first.warnings).toEqual([
          expect.stringContaining("injected backup source retirement failure"),
        ]);
      } finally {
        removeSpy.mockRestore();
      }
      const destinationSkillDir = path.join(fixture.destinationBackupDir, "skills", fixture.name);
      const destinationManifest = path.join(fixture.destinationBackupDir, "manifest.json");
      const metadataFile = path.join(destinationSkillDir, ".openclaw", "trace.json");
      await expect(fs.readFile(path.join(destinationSkillDir, "SKILL.md"), "utf8")).resolves.toBe(
        fixture.backupContent,
      );
      if (destinationState === "metadata-bytes") {
        await fs.writeFile(metadataFile, '{"source":"different"}\n');
      }
      if (destinationState === "manifest") {
        const manifest: CollectionBackupManifest = JSON.parse(
          await fs.readFile(destinationManifest, "utf8"),
        );
        manifest.resultSkillHashes[fixture.name] = "0".repeat(64);
        await fs.writeFile(destinationManifest, JSON.stringify(manifest));
      }
      const publishedManifest = await fs.readFile(destinationManifest, "utf8");
      const publishedMetadata = await fs.readFile(metadataFile, "utf8");

      const retry = await migrateLegacySkillWorkshopProposals({
        config: fixture.config,
        env: testState.env,
      });

      if (destinationState === "unchanged") {
        expect(retry.warnings).toEqual([]);
        await expect(fs.access(fixture.sourceBackupDir)).rejects.toMatchObject({ code: "ENOENT" });
        await expect(
          restoreLatestSkillCollectionBackup({
            workspaceDir: fixture.workspaceDir,
            config: fixture.config,
            agentId: "main",
            env: testState.env,
          }),
        ).resolves.toMatchObject({ backupId: fixture.backupId, restored: [fixture.name] });
      } else {
        expect(retry.warnings).toHaveLength(1);
        await expect(
          fs.readFile(path.join(fixture.sourceBackupDir, "manifest.json"), "utf8"),
        ).resolves.toBe(sourceManifest);
        await expect(
          fs.readFile(
            path.join(fixture.sourceBackupDir, "workspace", "skills", fixture.name, "SKILL.md"),
            "utf8",
          ),
        ).resolves.toBe(fixture.backupContent);
      }
      await expect(fs.readFile(destinationManifest, "utf8")).resolves.toBe(publishedManifest);
      await expect(fs.readFile(metadataFile, "utf8")).resolves.toBe(publishedMetadata);
    },
  );

  it("preserves a newer unrelated backup instead of publishing a legacy replacement", async () => {
    const fixture = await seedOwnedLegacyCollectionBackup();
    const newerId = "2026-09-02T00-00-00.000Z-newer";
    const newerDir = path.join(path.dirname(fixture.destinationBackupDir), newerId);
    const manifest: CollectionBackupManifest = {
      schema: "openclaw.skill-collection-backup.v2",
      id: newerId,
      createdAt: "2026-09-02T00:00:00.000Z",
      skillDirs: [],
      resultSkillDirs: [],
      resultSkillHashes: {},
    };
    await fs.mkdir(newerDir, { recursive: true });
    const manifestText = JSON.stringify(manifest);
    await fs.writeFile(path.join(newerDir, "manifest.json"), manifestText);

    const migration = await migrateLegacySkillWorkshopProposals({
      config: fixture.config,
      env: testState.env,
    });

    expect(migration.warnings).toEqual([
      expect.stringContaining("newer agent backup already exists"),
    ]);
    await expect(fs.access(fixture.sourceBackupDir)).resolves.toBeUndefined();
    await expect(fs.access(fixture.destinationBackupDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(path.join(newerDir, "manifest.json"), "utf8")).resolves.toBe(
      manifestText,
    );
  });

  it("defers backup conversion until Doctor imports the legacy workspace state", async () => {
    const fixture = await seedOwnedLegacyCollectionBackup();
    const sourceSkillFile = path.join(fixture.workspaceDir, "skills", fixture.name, "SKILL.md");
    const sourceContent = await fs.readFile(sourceSkillFile, "utf8");
    const sourceManifest = await fs.readFile(
      path.join(fixture.sourceBackupDir, "manifest.json"),
      "utf8",
    );
    const homedir = () => testState.home;
    const marker = resolveLegacyWorkspaceSourcePaths(fixture.workspaceDir, {
      env: testState.env,
      homedir,
    }).stateDirAttestationPaths[0]!;
    await fs.mkdir(path.dirname(marker), { recursive: true });
    await fs.writeFile(
      marker,
      `${LEGACY_WORKSPACE_ATTESTATION_HEADER}\n${new Date().toISOString()}\n`,
    );

    const deferred = await migrateLegacySkillWorkshopProposals({
      config: fixture.config,
      env: testState.env,
    });

    expect(deferred.warnings.length).toBeGreaterThan(0);
    await expect(fs.readFile(sourceSkillFile, "utf8")).resolves.toBe(sourceContent);
    await expect(
      fs.readFile(path.join(fixture.sourceBackupDir, "manifest.json"), "utf8"),
    ).resolves.toBe(sourceManifest);
    await expect(fs.access(fixture.destinationBackupDir)).rejects.toMatchObject({ code: "ENOENT" });
    const workspaceMigration = await migrateLegacyWorkspaceState({
      detected: detectLegacyWorkspaceState({
        cfg: fixture.config,
        stateDir: testState.stateDir,
        env: testState.env,
        homedir,
        doctorOnlyStateMigrations: true,
      }),
      stateDir: testState.stateDir,
      env: testState.env,
    });
    expect(workspaceMigration.warnings).toEqual([]);
    const migrated = await migrateLegacySkillWorkshopProposals({
      config: fixture.config,
      env: testState.env,
    });
    expect(migrated.warnings).toEqual([]);
    await expect(fs.access(sourceSkillFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      restoreLatestSkillCollectionBackup({
        workspaceDir: fixture.workspaceDir,
        config: fixture.config,
        agentId: "main",
        env: testState.env,
      }),
    ).resolves.toMatchObject({ backupId: fixture.backupId, restored: [fixture.name] });
  });

  it("converts a legacy collection backup after an interrupted relocation retarget", async () => {
    const { workspaceDir, config, backupId, proposalId } =
      await seedOwnedLegacyCollectionBackup("interrupted-backup");
    const legacySkillDir = path.join(workspaceDir, "skills", "interrupted-backup");
    const backupMigration = vi
      .spyOn(collectionBackups, "migrateLegacyCollectionBackups")
      .mockRejectedValueOnce(new Error("injected backup conversion interruption"));
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config, env: testState.env }),
      ).rejects.toThrow("injected backup conversion interruption");
    } finally {
      backupMigration.mockRestore();
    }

    await expect(fs.access(legacySkillDir)).rejects.toThrow();
    await expect(
      readSkillProposalRecord(proposalId, { env: testState.env }),
    ).resolves.toMatchObject({
      target: {
        skillDir: path.join(
          resolveWorkshopSkillsDir(config, "main", testState.env),
          "interrupted-backup",
        ),
        source: "openclaw-workshop",
      },
    });

    const rerun = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });
    expect(rerun.changes.join("\n")).toContain("migrated 1 legacy collection backup root");
    expect(rerun.warnings).toEqual([]);
    await expect(
      restoreLatestSkillCollectionBackup({
        workspaceDir,
        config,
        agentId: "main",
        env: testState.env,
      }),
    ).resolves.toMatchObject({ backupId, restored: ["interrupted-backup"] });
  });

  it("preserves a legacy collection backup when its workspace has ambiguous owners", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-ambiguous-backup-workspace-"),
    );
    const legacyRoot = await seedLegacyCollectionBackup({
      workspaceDir,
      backupId: "2026-09-01T00-00-00.000Z-legacy2",
      backupContent:
        "---\nname: legacy-collection-skill\ndescription: Legacy backup\n---\n\n# Backup\n",
      resultContent:
        "---\nname: legacy-collection-skill\ndescription: Current skill\n---\n\n# Current\n",
    });
    const config = {
      agents: {
        list: [
          { id: "alpha", default: true, workspace: workspaceDir },
          { id: "beta", workspace: workspaceDir },
        ],
      },
    };

    const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    await expect(fs.access(legacyRoot)).resolves.toBeUndefined();
    expect(result.warnings.join("\n")).toContain(legacyRoot);
  });
});
