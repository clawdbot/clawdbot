import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposalRecord as readSkillProposalRecordImpl,
} from "../skills/workshop/store.js";
import * as workshopStore from "../skills/workshop/store.js";
import { SKILL_WORKSHOP_SCHEMA, type SkillProposalRecord } from "../skills/workshop/types.js";
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
describe("doctor Skill Workshop SQLite relocation conflicts and recovery", () => {
  it("stales an applied legacy directory without a loadable skill file", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-invalid-relocation-workspace-"),
    );
    const skillDir = path.join(workspaceDir, "skills", "invalid-relocation");
    const now = "2026-09-01T00:00:00.000Z";
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: "invalid-relocation-20260901-1234567890",
      kind: "create",
      status: "applied",
      title: "Create Invalid Relocation",
      description: "Invalid relocation",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent("invalid relocation"),
      target: {
        skillName: "invalid-relocation",
        skillKey: "invalid-relocation",
        skillDir,
        skillFile: path.join(skillDir, "SKILL.md"),
        source: "openclaw-workspace",
      },
      scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
      appliedAt: now,
    };
    await fs.mkdir(skillDir, { recursive: true });
    seedLegacyV15ProposalRows(testState.env, [{ record, workspaceDir, claimReleasedTime: null }]);

    const result = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });

    expect(result.changes.join("\n")).toContain(
      "Relocated 0 Skill Workshop skills, retargeted 0 proposals, marked 1 stale",
    );
    await expect(fs.access(skillDir)).resolves.toBeUndefined();
    await expect(
      fs.access(
        path.join(resolveWorkshopSkillsDir({}, "main", testState.env), "invalid-relocation"),
      ),
    ).rejects.toThrow();
    await expect(readSkillProposalRecord(record.id, { env: testState.env })).resolves.toMatchObject(
      {
        status: "stale",
        statusReason: expect.stringContaining("could not load"),
        target: { skillDir },
      },
    );
  });

  it.runIf(process.platform !== "win32")(
    "stales symlinked applied skills without relocating them",
    async () => {
      const workspaceDir = await fs.realpath(
        await tempDirs.make("openclaw-workshop-symlink-workspace-"),
      );
      const realSkillDir = await fs.realpath(
        await tempDirs.make("openclaw-workshop-symlink-target-"),
      );
      const skillsDir = path.join(workspaceDir, "skills");
      const symlinkedSkillName = "linked-workshop";
      const normalSkillName = "normal-workshop";
      const symlinkedSkillDir = path.join(skillsDir, symlinkedSkillName);
      const symlinkedSkillFile = path.join(symlinkedSkillDir, "SKILL.md");
      const normalSkillDir = path.join(skillsDir, normalSkillName);
      const normalSkillFile = path.join(normalSkillDir, "SKILL.md");
      const symlinkedContent =
        "---\nname: linked-workshop\ndescription: Linked procedure\n---\n\n# Linked\n";
      const normalContent =
        "---\nname: normal-workshop\ndescription: Normal procedure\n---\n\n# Normal\n";
      const now = "2026-09-01T00:00:00.000Z";
      const records = [
        {
          id: "linked-workshop-20260901-1234567890",
          skillName: "linked-workshop",
          skillDir: symlinkedSkillDir,
          skillFile: symlinkedSkillFile,
          content: symlinkedContent,
        },
        {
          id: "normal-workshop-20260901-1234567890",
          skillName: "normal-workshop",
          skillDir: normalSkillDir,
          skillFile: normalSkillFile,
          content: normalContent,
        },
      ].map(({ id, skillName, skillDir, skillFile, content }) => ({
        record: {
          schema: SKILL_WORKSHOP_SCHEMA,
          id,
          kind: "create",
          status: "applied",
          title: `Create ${skillName}`,
          description: `${skillName} procedure`,
          createdAt: now,
          updatedAt: now,
          createdBy: "skill-workshop",
          proposedVersion: "v1",
          draftFile: "PROPOSAL.md",
          draftHash: hashSkillProposalContent(content),
          target: {
            skillName,
            skillKey: skillName,
            skillDir,
            skillFile,
            source: "openclaw-workspace",
          },
          scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
          appliedAt: now,
        } satisfies SkillProposalRecord,
        workspaceDir,
      }));

      await fs.mkdir(realSkillDir, { recursive: true });
      await fs.writeFile(path.join(realSkillDir, "SKILL.md"), symlinkedContent, "utf8");
      await fs.mkdir(normalSkillDir, { recursive: true });
      await fs.writeFile(normalSkillFile, normalContent, "utf8");
      await fs.mkdir(skillsDir, { recursive: true });
      await fs.symlink(realSkillDir, symlinkedSkillDir, "dir");
      seedLegacyV15ProposalRows(
        testState.env,
        records.map(({ record, workspaceDir: recordWorkspaceDir }) => ({
          record,
          workspaceDir: recordWorkspaceDir,
          claimReleasedTime: null,
        })),
      );

      const workshopRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
      const symlinkedReason = `Skill Workshop no longer writes through symlinked skills; ${symlinkedSkillDir} stays a workspace skill.`;
      const first = await migrateLegacySkillWorkshopProposals({
        config: {},
        env: testState.env,
      });
      expect(first.changes.join("\n")).toContain(
        "Relocated 1 Skill Workshop skill, retargeted 1 proposal, marked 1 stale",
      );
      await expect(fs.lstat(symlinkedSkillDir)).resolves.toSatisfy((stat) => stat.isSymbolicLink());
      await expect(fs.readlink(symlinkedSkillDir)).resolves.toBe(realSkillDir);
      await expect(fs.readFile(symlinkedSkillFile, "utf8")).resolves.toBe(symlinkedContent);
      await expect(fs.access(path.join(workshopRoot, symlinkedSkillName))).rejects.toThrow();
      await expect(
        fs.readFile(path.join(workshopRoot, normalSkillName, "SKILL.md"), "utf8"),
      ).resolves.toBe(normalContent);
      await expect(
        readSkillProposalRecord("linked-workshop-20260901-1234567890", { env: testState.env }),
      ).resolves.toMatchObject({
        status: "stale",
        statusReason: symlinkedReason,
        target: {
          skillDir: symlinkedSkillDir,
          skillFile: symlinkedSkillFile,
          source: "openclaw-workspace",
        },
      });
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
    },
  );

  it("stales applied skills whose planned destinations collide", async () => {
    const firstWorkspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-collision-first-workspace-"),
    );
    const secondWorkspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-collision-second-workspace-"),
    );
    const now = "2026-09-01T00:00:00.000Z";
    const skillKey = "shared-name";
    const records = [
      {
        workspaceDir: firstWorkspaceDir,
        id: "shared-name-first-20260901-1234567890",
        content: "---\nname: shared-name\ndescription: First skill\n---\n\n# First\n",
      },
      {
        workspaceDir: secondWorkspaceDir,
        id: "shared-name-second-20260901-1234567890",
        content: "---\nname: shared-name\ndescription: Second skill\n---\n\n# Second\n",
      },
    ].map(({ workspaceDir, id, content }) => {
      const skillDir = path.join(workspaceDir, "skills", skillKey);
      return {
        workspaceDir,
        content,
        record: {
          schema: SKILL_WORKSHOP_SCHEMA,
          id,
          kind: "create",
          status: "applied",
          title: "Create Shared Name",
          description: "Shared skill",
          createdAt: now,
          updatedAt: now,
          createdBy: "skill-workshop",
          proposedVersion: "v1",
          draftFile: "PROPOSAL.md",
          draftHash: hashSkillProposalContent(content),
          target: {
            skillName: "Shared Name",
            skillKey,
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
      records.map(({ record, workspaceDir }) => ({
        record,
        workspaceDir,
        claimReleasedTime: null,
      })),
    );

    const workshopRoot = resolveWorkshopSkillsDir({}, "main", testState.env);
    const destination = path.join(workshopRoot, skillKey);
    const sources = records.map(({ record }) => path.resolve(record.target.skillDir)).toSorted();
    const conflictReason = `Skill Workshop relocation conflict: sources ${sources.join(", ")} map to the same destination ${destination}.`;

    const first = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(first.changes.join("\n")).toContain(
      "Relocated 0 Skill Workshop skills, retargeted 0 proposals, marked 2 stale",
    );
    for (const { record, content } of records) {
      await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(content);
      await expect(
        readSkillProposalRecord(record.id, { env: testState.env }),
      ).resolves.toMatchObject({
        status: "stale",
        statusReason: conflictReason,
        target: {
          skillDir: record.target.skillDir,
          skillFile: record.target.skillFile,
          source: "openclaw-workspace",
        },
      });
    }
    await expect(fs.access(destination)).rejects.toThrow();
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

  it("adopts a skill moved before its proposal persistence and converges on rerun", async () => {
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
    const persistSpy = vi
      .spyOn(workshopStore, "updateSkillProposalRecord")
      .mockRejectedValueOnce(new Error("injected relocation persistence failure"));
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
      ).rejects.toThrow("injected relocation persistence failure");
    } finally {
      persistSpy.mockRestore();
    }

    await expect(
      fs.readFile(path.join(workshopRoot, "first-relocation", "SKILL.md"), "utf8"),
    ).resolves.toBe(records[0]!.content);
    await expect(fs.access(records[0]!.record.target.skillDir)).rejects.toThrow();
    await expect(
      readSkillProposalRecord(records[0]!.record.id, { env: testState.env }),
    ).resolves.toMatchObject({
      target: {
        skillDir: records[0]!.record.target.skillDir,
        skillFile: records[0]!.record.target.skillFile,
        source: "openclaw-workspace",
      },
    });

    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({
      externalProposalCount: 2,
      externalProposalCountsByAgent: { main: 2 },
    });

    const repaired = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(repaired.changes.join("\n")).toContain(
      "Relocated 1 Skill Workshop skill, retargeted 2 proposals, marked 0 stale",
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

  it("quarantines a non-empty legacy directory missing proposal.json so Doctor converges", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-missing-json-");
    const proposalId = "missing-json-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(
      path.join(proposalDir, "references", "proof.md"),
      "# Orphan proof\n",
      "utf8",
    );
    const previousRecoveryDir = path.join(
      testState.stateDir,
      "skill-workshop",
      "recovery",
      "proposals",
      proposalId,
    );
    await fs.mkdir(previousRecoveryDir, { recursive: true });
    await fs.writeFile(path.join(previousRecoveryDir, "prior.md"), "prior recovery\n", "utf8");

    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(result.changes.join("\n")).toContain(
      `Quarantined incomplete Skill Workshop proposal ${proposalId}`,
    );
    const second = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });
    expect(second).toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
    await expect(fs.access(proposalDir)).rejects.toThrow();
    await expect(fs.readFile(path.join(previousRecoveryDir, "prior.md"), "utf8")).resolves.toBe(
      "prior recovery\n",
    );
    const recoveryRoot = path.dirname(previousRecoveryDir);
    const recoveryDirs = (await fs.readdir(recoveryRoot)).filter((name) =>
      name.startsWith(`${proposalId}-`),
    );
    expect(recoveryDirs).toHaveLength(1);
    const recoveredProposalDir = recoveryDirs[0];
    if (!recoveredProposalDir) {
      throw new Error("expected one recovered proposal directory");
    }
    await expect(
      fs.readFile(path.join(recoveryRoot, recoveredProposalDir, "references", "proof.md"), "utf8"),
    ).resolves.toBe("# Orphan proof\n");
  });

  it("quarantines a legacy directory with proposal.json but no PROPOSAL.md", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-missing-draft-");
    const proposalId = "missing-draft-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(workspaceDir, "skills", "missing-draft");
    const now = "2026-08-29T00:00:00.000Z";
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "pending",
      title: "Create Missing Draft",
      description: "Proposal whose PROPOSAL.md was removed",
      createdAt: now,
      updatedAt: now,
      createdBy: "cli",
      origin: { agentId: "main", runId: "missing-draft-run" },
      originRunIds: ["missing-draft-run"],
      originRunMutationCounts: { "missing-draft-run": 1 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent("# Missing Draft\n"),
      supportFiles: [],
      target: {
        skillName: "Missing Draft",
        skillKey: "missing-draft",
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
    await fs.mkdir(proposalDir, { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");

    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(result.changes.join("\n")).toContain(
      `Quarantined incomplete Skill Workshop proposal ${proposalId}`,
    );
    await expect(fs.access(proposalDir)).rejects.toThrow();
    const recoveryRoot = path.join(testState.stateDir, "skill-workshop", "recovery", "proposals");
    const recoveryDirs = (await fs.readdir(recoveryRoot)).filter((name) =>
      name.startsWith(`${proposalId}-`),
    );
    expect(recoveryDirs).toHaveLength(1);
    const recoveryDir = recoveryDirs[0];
    if (!recoveryDir) {
      throw new Error("expected one recovered proposal directory");
    }
    await expect(
      fs.access(path.join(recoveryRoot, recoveryDir, "proposal.json")),
    ).resolves.toBeUndefined();

    importLegacySkillProposal({ record, ownerAgentId: "main" });
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "references", "leftover.md"), "leftover\n", "utf8");
    await expect(
      migrateLegacySkillWorkshopProposals({
        config: {
          agents: {
            entries: {
              main: { default: true, workspace: workspaceDir },
            },
          },
        },
      }),
    ).resolves.toMatchObject({
      changes: [
        expect.stringContaining(
          "Relocated 0 Skill Workshop skills, retargeted 1 proposal, marked 0 stale",
        ),
      ],
      warnings: [],
      detected: 1,
      migrated: 0,
    });
    await expect(
      fs.access(path.join(proposalDir, "references", "leftover.md")),
    ).resolves.toBeUndefined();
  });

  it("removes an empty orphaned legacy proposal directory directly", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-empty-dir-");
    const proposalId = "empty-dir-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    await fs.mkdir(proposalDir, { recursive: true });

    const result = await migrateLegacySkillWorkshopProposals({
      config: {
        agents: {
          entries: {
            main: { default: true, workspace: workspaceDir },
          },
        },
      },
    });

    expect(result).toMatchObject({ detected: 1, migrated: 0, warnings: [] });
    expect(result.changes.join("\n")).toContain(
      `Removed empty legacy Skill Workshop proposal directory ${proposalId}`,
    );
    await expect(fs.access(proposalDir)).rejects.toThrow();
  });
});
