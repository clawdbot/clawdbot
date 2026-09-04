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
import { restoreLatestSkillCollectionBackup } from "../skills/workshop/collection-reconcile.js";
import {
  renderProposalMarkdown,
  stripProposalFrontmatterForSkill,
} from "../skills/workshop/frontmatter.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  proposeCreateSkill,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import * as workshopStore from "../skills/workshop/store.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposalRollback,
} from "../skills/workshop/store.js";
import {
  SKILL_WORKSHOP_ROLLBACK_SCHEMA,
  SKILL_WORKSHOP_SCHEMA,
  type SkillProposalRecord,
  type SkillProposalRollback,
} from "../skills/workshop/types.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "../state/openclaw-state-db-contract.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
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
      createdAt: "2026-09-01T00:00:00.000Z",
      workspaceDir: params.workspaceDir,
      skillDirs: [relativeSkillDir],
      resultSkillDirs: Object.keys(resultSkillHashes),
      resultSkillHashes,
    }),
    "utf8",
  );
  return legacyRoot;
}

async function seedOwnedLegacyCollectionBackup() {
  const workspaceDir = await fs.realpath(
    await tempDirs.make("openclaw-workshop-owned-backup-workspace-"),
  );
  const name = "owned-legacy-backup";
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
  const backupContent =
    "---\nname: owned-legacy-backup\ndescription: Owned legacy backup\n---\n\n# Before cleanup\n";
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
    sourceBackupDir,
    destinationBackupDir,
  };
}

describe("doctor Skill Workshop SQLite relocation and legacy migration", () => {
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
      const record: SkillProposalRecord = {
        schema: SKILL_WORKSHOP_SCHEMA,
        id: "owned-legacy-drop-20260831-1234567890",
        kind: "create",
        status: "applied",
        title: "Create dropped procedure",
        description: "Dropped procedure",
        createdAt: now,
        updatedAt: now,
        createdBy,
        proposedVersion: "v1",
        draftFile: "PROPOSAL.md",
        draftHash: hashSkillProposalContent(proposalContent),
        target: {
          skillName: name,
          skillKey: name,
          skillDir,
          skillFile,
          source: "openclaw-workspace",
        },
        scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
        appliedAt: now,
      };
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
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-interrupted-backup-workspace-"),
    );
    const proposal = await proposeCreateSkill({
      workspaceDir,
      config: {},
      agentId: "main",
      env: testState.env,
      name: "interrupted-backup",
      description: "Interrupted backup relocation",
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
    const legacySkillDir = path.join(workspaceDir, "skills", "interrupted-backup");
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
    const backupId = "2026-09-01T00-00-00.000Z-interrupted1";
    await seedLegacyCollectionBackup({
      workspaceDir,
      backupId,
      relativeSkillDir: path.join("skills", "interrupted-backup"),
      backupContent:
        "---\nname: interrupted-backup\ndescription: Interrupted backup\n---\n\n# Before cleanup\n",
      resultContent,
    });
    const config = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
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
      readSkillProposalRecord(applied.record.id, { env: testState.env }),
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

  it("moves an applied legacy skill into the Workshop directory and converges", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-relocation-workspace-"),
    );
    const proposalId = "relocate-workshop-20260901-1234567890";
    const legacySkillDir = path.join(workspaceDir, "skills", "relocate-workshop");
    const legacySkillFile = path.join(legacySkillDir, "SKILL.md");
    const skillContent =
      "---\nname: relocate-workshop\ndescription: Relocated procedure\n---\n\n# Relocated\n";
    const now = "2026-09-01T00:00:00.000Z";
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "applied",
      title: "Create Relocated Workshop",
      description: "Relocated procedure",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(skillContent),
      target: {
        skillName: "relocate-workshop",
        skillKey: "relocate-workshop",
        skillDir: legacySkillDir,
        skillFile: legacySkillFile,
        source: "openclaw-workspace",
      },
      scan: {
        state: "clean",
        scannedAt: now,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
      appliedAt: now,
    };
    await fs.mkdir(legacySkillDir, { recursive: true });
    await fs.writeFile(legacySkillFile, skillContent, "utf8");
    importLegacySkillProposal({
      record,
      ownerAgentId: "main",
      store: { env: testState.env },
    });

    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 1,
      externalProposalCountsByAgent: { main: 1 },
      legacyBackupRootCount: 0,
    });
    await expect(fs.access(legacySkillFile)).resolves.toBeUndefined();

    const first = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(first.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 0 stale",
    );
    const workshopSkillFile = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "relocate-workshop",
      "SKILL.md",
    );
    await expect(fs.readFile(workshopSkillFile, "utf8")).resolves.toBe(skillContent);
    await expect(fs.access(legacySkillDir)).rejects.toThrow();
    await expect(
      readSkillProposalRecord(proposalId, { env: testState.env }),
    ).resolves.toMatchObject({
      target: {
        skillDir: path.dirname(workshopSkillFile),
        skillFile: workshopSkillFile,
        source: "openclaw-workshop",
      },
    });

    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });

  it("retargets a pending update for a relocated applied skill", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-relocation-update-workspace-"),
    );
    const skillDir = path.join(workspaceDir, "skills", "relocate-update");
    const skillFile = path.join(skillDir, "SKILL.md");
    const skillContent =
      "---\nname: relocate-update\ndescription: Relocated update\n---\n\n# Original\n";
    const updatedContent =
      "---\nname: relocate-update\ndescription: Relocated update\n---\n\n# Updated\n";
    const now = "2026-09-01T00:00:00.000Z";
    const create: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: "relocate-update-create-20260901-1234567890",
      kind: "create",
      status: "applied",
      title: "Create Relocate Update",
      description: "Relocated update",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(skillContent),
      target: {
        skillName: "relocate-update",
        skillKey: "relocate-update",
        skillDir,
        skillFile,
        source: "openclaw-workspace",
      },
      scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
      appliedAt: now,
    };
    const update: SkillProposalRecord = {
      ...create,
      id: "relocate-update-pending-20260901-1234567890",
      kind: "update",
      status: "pending",
      draftHash: hashSkillProposalContent(updatedContent),
      target: {
        ...create.target,
        currentContentHash: hashSkillProposalContent(skillContent),
      },
      appliedAt: undefined,
    };
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, skillContent, "utf8");
    seedLegacyV15ProposalRows(testState.env, [
      { record: create, workspaceDir, claimReleasedTime: null },
      { record: update, workspaceDir, claimReleasedTime: null },
    ]);

    const result = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    const workshopSkillFile = path.join(
      resolveWorkshopSkillsDir({}, "main", testState.env),
      "relocate-update",
      "SKILL.md",
    );

    expect(result.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 2 proposals, marked 0 stale",
    );
    await expect(fs.access(skillDir)).rejects.toThrow();
    await expect(fs.readFile(workshopSkillFile, "utf8")).resolves.toBe(skillContent);
    await expect(readSkillProposalRecord(update.id, { env: testState.env })).resolves.toMatchObject(
      {
        status: "pending",
        target: {
          skillDir: path.dirname(workshopSkillFile),
          skillFile: workshopSkillFile,
          source: "openclaw-workshop",
        },
      },
    );
  });

  it("leaves an applied skill in place when its workspace has ambiguous owners", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-ambiguous-workspace-"),
    );
    const legacySkillDir = path.join(workspaceDir, "skills", "ambiguous-workshop");
    const skillContent =
      "---\nname: ambiguous-workshop\ndescription: Ambiguous procedure\n---\n\n# Ambiguous\n";
    const now = "2026-09-01T00:00:00.000Z";
    const record: SkillProposalRecord & { appliedAt: string } = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: "ambiguous-workshop-20260901-1234567890",
      kind: "create",
      status: "applied",
      title: "Create Ambiguous Workshop",
      description: "Ambiguous procedure",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(skillContent),
      target: {
        skillName: "ambiguous-workshop",
        skillKey: "ambiguous-workshop",
        skillDir: legacySkillDir,
        skillFile: path.join(legacySkillDir, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: {
        state: "clean",
        scannedAt: now,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
      appliedAt: now,
    };
    await fs.mkdir(legacySkillDir, { recursive: true });
    await fs.writeFile(record.target.skillFile, skillContent, "utf8");
    seedLegacyV15ProposalRows(testState.env, [
      { record, workspaceDir, claimReleasedTime: null, ownerAgentId: null },
    ]);

    const config = {
      agents: {
        list: [
          { id: "alpha", default: true, workspace: workspaceDir },
          { id: "beta", workspace: workspaceDir },
        ],
      },
    };
    const result = await migrateLegacySkillWorkshopProposals({
      config,
      env: testState.env,
    });

    expect(result.changes.join("\n")).toContain("marked 1 stale");
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(skillContent);
    await expect(
      fs.access(resolveWorkshopSkillsDir(config, "alpha", testState.env)),
    ).rejects.toThrow();
    expect(
      openOpenClawStateDatabase({ env: testState.env })
        .db.prepare(
          "SELECT status, status_reason FROM skill_workshop_proposals WHERE proposal_id = ?",
        )
        .get(record.id),
    ).toMatchObject({
      status: "stale",
      status_reason: expect.stringContaining("could not identify one owning agent"),
    });
  });

  it("leaves an applied skill in place when its row owner is not configured", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-retired-owner-workspace-"),
    );
    const legacySkillDir = path.join(workspaceDir, "skills", "retired-owner-workshop");
    const skillContent =
      "---\nname: retired-owner-workshop\ndescription: Retired owner procedure\n---\n\n# Retired\n";
    const now = "2026-09-01T00:00:00.000Z";
    const record: SkillProposalRecord & { appliedAt: string } = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: "retired-owner-workshop-20260901-1234567890",
      kind: "create",
      status: "applied",
      title: "Create Retired Owner Workshop",
      description: "Retired owner procedure",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(skillContent),
      target: {
        skillName: "retired-owner-workshop",
        skillKey: "retired-owner-workshop",
        skillDir: legacySkillDir,
        skillFile: path.join(legacySkillDir, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
      appliedAt: now,
    };
    await fs.mkdir(legacySkillDir, { recursive: true });
    await fs.writeFile(record.target.skillFile, skillContent, "utf8");
    seedLegacyV15ProposalRows(testState.env, [
      { record, workspaceDir, claimReleasedTime: null, ownerAgentId: "retired" },
    ]);

    const config = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    };
    await expect(
      inspectLegacySkillWorkshopMigration({ config, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 1,
      externalProposalCountsByAgent: { retired: 1 },
      legacyBackupRootCount: 0,
    });
    const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    expect(result.changes.join("\n")).toContain("marked 1 stale");
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(skillContent);
    await expect(fs.access(legacySkillDir)).resolves.toBeUndefined();
    await expect(
      fs.access(resolveWorkshopSkillsDir(config, "retired", testState.env)),
    ).rejects.toThrow();
    await expect(readSkillProposalRecord(record.id, { env: testState.env })).resolves.toMatchObject(
      {
        status: "stale",
        statusReason: expect.stringContaining("retired"),
        target: {
          skillDir: legacySkillDir,
          skillFile: record.target.skillFile,
        },
      },
    );
  });

  it("persists each relocation before continuing after a later move fails", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-relocation-failure-workspace-"),
    );
    const now = "2026-09-01T00:00:00.000Z";
    const records = ["first-relocation", "second-relocation"].map((name) => {
      const skillDir = path.join(workspaceDir, "skills", name);
      const content = `---\nname: ${name}\ndescription: ${name} procedure\n---\n\n# ${name}\n`;
      return {
        content,
        record: {
          schema: SKILL_WORKSHOP_SCHEMA,
          id: `${name}-20260901-1234567890`,
          kind: "create",
          status: "applied",
          title: `Create ${name}`,
          description: `${name} procedure`,
          createdAt: now,
          updatedAt: now,
          createdBy: "skill-workshop",
          proposedVersion: "v1",
          draftFile: "PROPOSAL.md",
          draftHash: hashSkillProposalContent(content),
          target: {
            skillName: name,
            skillKey: name,
            skillDir,
            skillFile: path.join(skillDir, "SKILL.md"),
            source: "openclaw-workspace",
          },
          scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
          appliedAt: now,
        } satisfies SkillProposalRecord,
      };
    });
    for (const { record, content } of records) {
      await fs.mkdir(record.target.skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content, "utf8");
    }

    seedLegacyV15ProposalRows(
      testState.env,
      records.map((record) => ({ record: record.record, workspaceDir, claimReleasedTime: null })),
    );

    const workshopRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    const secondSource = records[1]!.record.target.skillDir;
    const secondDestination = path.join(workshopRoot, "second-relocation");
    const originalRename = fs.rename.bind(fs);
    const renameSpy = vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (
        path.resolve(String(source)) === path.resolve(secondSource) &&
        path.resolve(String(destination)) === path.resolve(secondDestination)
      ) {
        throw new Error("injected relocation failure");
      }
      return originalRename(source, destination);
    });
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
      ).rejects.toThrow("injected relocation failure");
    } finally {
      renameSpy.mockRestore();
    }

    expect(
      (await readSkillProposalRecord(records[0]!.record.id, { env: testState.env }))?.target,
    ).toMatchObject({
      skillDir: path.join(workshopRoot, "first-relocation"),
      skillFile: path.join(workshopRoot, "first-relocation", "SKILL.md"),
      source: "openclaw-workshop",
    });

    const repaired = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(repaired.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 0 stale",
    );
    for (const { record } of records) {
      const targetDir = path.join(workshopRoot, path.basename(record.target.skillDir));
      await expect(fs.access(path.join(targetDir, "SKILL.md"))).resolves.toBeUndefined();
      await expect(
        readSkillProposalRecord(record.id, { env: testState.env }),
      ).resolves.toMatchObject({
        target: {
          skillDir: targetDir,
          skillFile: path.join(targetDir, "SKILL.md"),
          source: "openclaw-workshop",
        },
      });
    }
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });

  it("keeps a released legacy skill user-owned through the v16 migration and Doctor repair", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-released-workspace-"),
    );
    const now = "2026-09-01T00:00:00.000Z";
    const legacyRecord = (name: string, content: string): SkillProposalRecord => ({
      schema: SKILL_WORKSHOP_SCHEMA,
      id: `${name}-20260901-1234567890`,
      kind: "create",
      status: "applied",
      title: `Create ${name}`,
      description: `${name} procedure`,
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(content),
      target: {
        skillName: name,
        skillKey: name,
        skillDir: path.join(workspaceDir, "skills", name),
        skillFile: path.join(workspaceDir, "skills", name, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
      appliedAt: now,
    });
    // v15 collection review dropped this skill and released its claim; the operator
    // then recreated the path by hand, so it is theirs.
    const recreatedContent =
      "---\nname: released-skill\ndescription: Handwritten again\n---\n\n# Mine\n";
    const released = legacyRecord("released-skill", "---\nname: released-skill\n---\n");
    const activeContent =
      "---\nname: active-skill\ndescription: Still Workshop-owned\n---\n\n# Active\n";
    const active = legacyRecord("active-skill", activeContent);
    for (const [record, content] of [
      [released, recreatedContent],
      [active, activeContent],
    ] as const) {
      await fs.mkdir(record.target.skillDir, { recursive: true });
      await fs.writeFile(record.target.skillFile, content, "utf8");
    }
    // Build the shipped v15 row shape, then let the store upgrade it on next open.
    const databasePath = openOpenClawStateDatabase({ env: testState.env }).path;
    closeOpenClawStateDatabaseForTest();
    const legacy = openNodeSqliteDatabase(databasePath);
    legacy.exec(`
      ALTER TABLE skill_workshop_proposals ADD COLUMN workspace_dir TEXT NOT NULL DEFAULT '';
      ALTER TABLE skill_workshop_proposals ADD COLUMN claim_released_time INTEGER;
    `);
    const insertProposal = legacy.prepare(
      `INSERT INTO skill_workshop_proposals (
        proposal_id, record_json, owner_agent_id, workspace_dir, kind, status,
        created_at, updated_at, draft_hash, applied_at, claim_released_time
      ) VALUES (?, ?, 'main', ?, 'create', 'applied', ?, ?, ?, ?, ?)`,
    );
    for (const [record, claimReleasedTime] of [
      [released, 1_756_684_800_000],
      [active, null],
    ] as const) {
      insertProposal.run(
        record.id,
        JSON.stringify(record),
        workspaceDir,
        now,
        now,
        record.draftHash,
        now,
        claimReleasedTime,
      );
    }
    legacy.exec(`
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const repaired = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(repaired.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 0 stale",
    );
    await expect(fs.readFile(released.target.skillFile, "utf8")).resolves.toBe(recreatedContent);
    await expect(
      fs.access(path.join(resolveWorkshopSkillsDir({}, "main", testState.env), "released-skill")),
    ).rejects.toThrow();
    await expect(
      readSkillProposalRecord(released.id, { env: testState.env }),
    ).resolves.toMatchObject({
      status: "stale",
      statusReason: expect.stringContaining("stays user-owned"),
      target: { skillDir: released.target.skillDir },
    });
    await expect(fs.access(active.target.skillDir)).rejects.toThrow();
    await expect(
      fs.readFile(
        path.join(resolveWorkshopSkillsDir({}, "main", testState.env), "active-skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe(activeContent);
    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 0,
      externalProposalCountsByAgent: {},
      legacyBackupRootCount: 0,
    });
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });

  it("imports verified sidecars, preserves review artifacts, and removes legacy JSON", async () => {
    const oldWorkspace = await tempDirs.make("openclaw-workshop-old-workspace-");
    const currentWorkspace = await tempDirs.make("openclaw-workshop-current-workspace-");
    const proposalId = "legacy-workshop-20260727-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(oldWorkspace, "skills", "legacy-workshop");
    const now = "2026-07-27T00:00:00.000Z";
    const content = renderProposalMarkdown({
      name: "legacy-workshop",
      description: "Migrate the legacy proposal store",
      content: "# Legacy Workshop\n\nKeep this review artifact.\n",
      date: now,
    });
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "pending",
      title: "Create Legacy Workshop",
      description: "Migrate the legacy proposal store",
      createdAt: now,
      updatedAt: now,
      createdBy: "cli",
      origin: {
        sessionKey: "agent:main:legacy-workshop",
        runId: "legacy-run",
        messageId: "legacy-message",
      },
      originRunIds: ["legacy-run", "revision-run"],
      originRunMutationCounts: { "legacy-run": 1, "revision-run": 2 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(content),
      target: {
        skillName: "Legacy Workshop",
        skillKey: "legacy-workshop",
        skillDir: targetDir,
        skillFile: path.join(targetDir, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: {
        state: "clean",
        scannedAt: now,
        critical: 0,
        warn: 0,
        info: 0,
        findings: [],
      },
    };
    const previousSupportContent = "\n".repeat(256 * 1024);
    const rollback: SkillProposalRollback = {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
      proposalId,
      writtenAt: now,
      targetSkillFile: record.target.skillFile,
      action: "create",
      supportFiles: Array.from({ length: 64 }, (_, index) => ({
        path: `references/large-${index}.md`,
        existed: true,
        previousContent: previousSupportContent,
        previousContentHash: hashSkillProposalContent(previousSupportContent),
      })),
    };
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");
    await fs.writeFile(path.join(proposalDir, "PROPOSAL.md"), content, "utf8");
    await fs.writeFile(path.join(proposalDir, "rollback.json"), JSON.stringify(rollback), "utf8");
    await fs.writeFile(
      path.join(proposalDir, "references", "proof.md"),
      "# Preserved support file\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(testState.stateDir, "skill-workshop", "proposals.json"),
      "{}",
      "utf8",
    );

    await expect(listSkillProposals({ config: {}, agentId: "main" })).resolves.toMatchObject({
      proposals: [],
    });
    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { workspace: oldWorkspace },
            other: { workspace: currentWorkspace },
          },
        },
      },
    });
    expect(result).toMatchObject({ detected: 1, migrated: 1, warnings: [] });

    const listed = await listSkillProposals({ config: {}, agentId: "main" });
    expect(listed.proposals).toEqual([expect.objectContaining({ id: proposalId })]);
    await expect(
      inspectSkillProposal(proposalId, { config: {}, agentId: "main" }),
    ).resolves.toMatchObject({
      record: {
        originRunIds: ["legacy-run", "revision-run"],
        originRunMutationCounts: { "legacy-run": 1, "revision-run": 2 },
        target: {
          skillDir: path.join(
            resolveWorkshopSkillsDir({}, "main", testState.env),
            "legacy-workshop",
          ),
        },
      },
    });
    await expect(readSkillProposalRollback(proposalId)).resolves.toMatchObject(rollback);
    await expect(fs.readFile(path.join(proposalDir, "PROPOSAL.md"), "utf8")).resolves.toBe(content);
    await expect(
      fs.readFile(path.join(proposalDir, "references", "proof.md"), "utf8"),
    ).resolves.toContain("Preserved support file");
    await expect(fs.access(path.join(proposalDir, "proposal.json"))).rejects.toThrow();
    await expect(fs.access(path.join(proposalDir, "rollback.json"))).rejects.toThrow();
    await expect(
      fs.access(path.join(testState.stateDir, "skill-workshop", "proposals.json")),
    ).rejects.toThrow();
    expect(openOpenClawStateDatabase().db.prepare("PRAGMA user_version").get()).toEqual({
      user_version: OPENCLAW_STATE_SCHEMA_VERSION,
    });

    const ambiguousId = "ambiguous-workshop-20260727-1234567890";
    const ambiguousDir = path.join(testState.stateDir, "skill-workshop", "proposals", ambiguousId);
    const ambiguousRecord: SkillProposalRecord = {
      ...record,
      id: ambiguousId,
      origin: { runId: "ambiguous-run" },
      originRunIds: ["ambiguous-run"],
      originRunMutationCounts: { "ambiguous-run": 1 },
      target: {
        ...record.target,
        skillDir: path.join(oldWorkspace, "skills", "ambiguous-workshop"),
        skillFile: path.join(oldWorkspace, "skills", "ambiguous-workshop", "SKILL.md"),
      },
    };
    await fs.mkdir(ambiguousDir, { recursive: true });
    await fs.writeFile(
      path.join(ambiguousDir, "proposal.json"),
      JSON.stringify(ambiguousRecord),
      "utf8",
    );
    await fs.writeFile(path.join(ambiguousDir, "PROPOSAL.md"), content, "utf8");
    const secondWorkspace = await tempDirs.make("openclaw-workshop-second-agent-");
    const ambiguous = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: currentWorkspace },
            other: { workspace: secondWorkspace },
          },
        },
      },
    });
    expect(ambiguous).toMatchObject({ migrated: 0 });
    expect(ambiguous.warnings).toEqual([
      expect.stringContaining("owning agent could not be inferred"),
    ]);
    await expect(fs.access(path.join(ambiguousDir, "proposal.json"))).resolves.toBeUndefined();
  });
});
