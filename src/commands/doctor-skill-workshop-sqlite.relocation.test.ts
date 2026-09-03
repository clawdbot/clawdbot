import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { restoreLatestSkillCollectionBackup } from "../skills/workshop/collection-reconcile.js";
import { renderProposalMarkdown } from "../skills/workshop/frontmatter.js";
import { readSkillProposalTargetTreeSha256 } from "../skills/workshop/proposal-bundle.js";
import { inspectSkillProposal, listSkillProposals } from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposalRecord as readSkillProposalRecordImpl,
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
import {
  inspectLegacySkillWorkshopMigration,
  migrateLegacySkillWorkshopProposals,
} from "./doctor-skill-workshop-sqlite.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

const readSkillProposalRecord = (proposalId: string, options: { env?: NodeJS.ProcessEnv } = {}) =>
  readSkillProposalRecordImpl(proposalId, { config: {}, ...options }, {}, { config: {} });

function seedLegacyV15ProposalRows(
  env: NodeJS.ProcessEnv,
  rows: readonly {
    record: SkillProposalRecord;
    workspaceDir: string;
    claimReleasedTime: number | null;
    ownerAgentId?: string | null;
  }[],
): void {
  const databasePath = openOpenClawStateDatabase({ env }).path;
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
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const { record, workspaceDir, claimReleasedTime, ownerAgentId = "main" } of rows) {
    insertProposal.run(
      record.id,
      JSON.stringify(record),
      ownerAgentId,
      workspaceDir,
      record.kind,
      record.status,
      record.createdAt,
      record.updatedAt,
      record.draftHash,
      record.appliedAt ?? null,
      claimReleasedTime,
    );
  }
  legacy.exec(`
    PRAGMA user_version = 15;
    UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
  `);
  legacy.close();
}

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
  resultContent: string;
}): Promise<string> {
  const relativeSkillDir = path.join("skills", "legacy-collection-skill");
  const legacyRoot = path.join(
    testState.stateDir,
    "skill-workshop",
    "collection-backups",
    "0000000000000000",
  );
  const backupDir = path.join(legacyRoot, params.backupId);
  const workspaceSkillDir = path.join(params.workspaceDir, relativeSkillDir);
  await fs.mkdir(path.join(backupDir, "workspace", relativeSkillDir), { recursive: true });
  await fs.mkdir(workspaceSkillDir, { recursive: true });
  await fs.writeFile(path.join(workspaceSkillDir, "SKILL.md"), params.resultContent, "utf8");
  const resultSkillHash = await readSkillProposalTargetTreeSha256(workspaceSkillDir);
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
      resultSkillDirs: [relativeSkillDir],
      resultSkillHashes: { [relativeSkillDir]: resultSkillHash },
    }),
    "utf8",
  );
  return legacyRoot;
}

describe("doctor Skill Workshop SQLite relocation and legacy migration", () => {
  it("migrates a legacy collection backup so restore can use it", async () => {
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
    await expect(fs.access(legacyRoot)).rejects.toThrow();
    const workshopSkillDir = path.join(
      resolveWorkshopSkillsDir(config, "main", testState.env),
      "legacy-collection-skill",
    );
    await fs.mkdir(workshopSkillDir, { recursive: true });
    await fs.writeFile(path.join(workshopSkillDir, "SKILL.md"), resultContent, "utf8");
    await expect(
      restoreLatestSkillCollectionBackup({
        workspaceDir,
        config,
        agentId: "main",
        env: testState.env,
      }),
    ).resolves.toMatchObject({ backupId, restored: ["legacy-collection-skill"] });
    await expect(fs.readFile(path.join(workshopSkillDir, "SKILL.md"), "utf8")).resolves.toBe(
      backupContent,
    );
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
