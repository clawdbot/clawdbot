import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { renderProposalMarkdown } from "../skills/workshop/frontmatter.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  reviseSkillProposal,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposalRecord,
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

describe("doctor Skill Workshop SQLite migration", () => {
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

    await expect(inspectLegacySkillWorkshopMigration(testState.env)).resolves.toEqual({
      externalProposalCount: 1,
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
      resolveWorkshopSkillsDir(testState.env),
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
      ) VALUES (?, ?, 'main', ?, 'create', 'applied', ?, ?, ?, ?, NULL)`,
    );
    for (const { record } of records) {
      insertProposal.run(
        record.id,
        JSON.stringify(record),
        workspaceDir,
        now,
        now,
        record.draftHash,
        now,
      );
    }
    legacy.exec(`
      PRAGMA user_version = 15;
      UPDATE schema_meta SET schema_version = 15 WHERE meta_key = 'primary';
    `);
    legacy.close();

    const workshopRoot = resolveWorkshopSkillsDir(testState.env);
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
      fs.access(path.join(resolveWorkshopSkillsDir(testState.env), "released-skill")),
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
        path.join(resolveWorkshopSkillsDir(testState.env), "active-skill", "SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe(activeContent);
    await expect(inspectLegacySkillWorkshopMigration(testState.env)).resolves.toEqual({
      externalProposalCount: 0,
      legacyBackupRootCount: 0,
    });
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });

  it("stales an outside pending update once and converges", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("openclaw-workshop-stale-update-workspace-"),
    );
    const proposalId = "stale-workshop-20260901-1234567890";
    const skillDir = path.join(workspaceDir, "skills", "stale-workshop");
    const skillFile = path.join(skillDir, "SKILL.md");
    const skillContent =
      "---\nname: stale-workshop\ndescription: Stale procedure\n---\n\n# Stale\n";
    const now = "2026-09-01T00:00:00.000Z";
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "update",
      status: "pending",
      title: "Update Stale Workshop",
      description: "Stale procedure",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(skillContent),
      target: {
        skillName: "stale-workshop",
        skillKey: "stale-workshop",
        skillDir,
        skillFile,
        source: "openclaw-workspace",
        currentContentHash: hashSkillProposalContent(skillContent),
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
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, skillContent, "utf8");
    importLegacySkillProposal({
      record,
      ownerAgentId: "main",
      store: { env: testState.env },
    });

    await expect(inspectLegacySkillWorkshopMigration(testState.env)).resolves.toEqual({
      externalProposalCount: 1,
      legacyBackupRootCount: 0,
    });
    const first = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(first.changes.join("\n")).toContain("marked 1 stale");
    await expect(
      readSkillProposalRecord(proposalId, { env: testState.env }),
    ).resolves.toMatchObject({
      status: "stale",
      statusReason: "Skill Workshop no longer edits skills outside its own directory.",
    });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(skillContent);
    await expect(inspectLegacySkillWorkshopMigration(testState.env)).resolves.toEqual({
      externalProposalCount: 0,
      legacyBackupRootCount: 0,
    });
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });

  it("preserves shipped v1 proposals through migration, revision, and apply", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-shipped-upgrade-");
    const proposalId = "shipped-workshop-20260729-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(workspaceDir, "skills", "shipped-workshop");
    const now = "2026-07-29T00:00:00.000Z";
    const supportContent = "Shipped support artifact.\n";
    const content = renderProposalMarkdown({
      name: "shipped-workshop",
      description: "Proposal written by a shipped Workshop release",
      content: "# Shipped Workshop\n\nOriginal proposal body.\n",
      date: now,
    });
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "pending",
      title: "Create Shipped Workshop",
      description: "Proposal written by a shipped Workshop release",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      origin: {
        agentId: "main",
        sessionKey: "agent:main:shipped-workshop",
        runId: "shipped-run",
      },
      originRunIds: ["shipped-run"],
      originRunMutationCounts: { "shipped-run": 1 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(content),
      supportFiles: [
        {
          path: "references/proof.md",
          sizeBytes: Buffer.byteLength(supportContent, "utf8"),
          hash: hashSkillProposalContent(supportContent),
        },
      ],
      target: {
        skillName: "Shipped Workshop",
        skillKey: "shipped-workshop",
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
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");
    await fs.writeFile(path.join(proposalDir, "PROPOSAL.md"), content, "utf8");
    await fs.writeFile(path.join(proposalDir, "references", "proof.md"), supportContent, "utf8");

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
    ).resolves.toMatchObject({ detected: 1, migrated: 1, warnings: [] });

    const revised = await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId,
      content: "# Shipped Workshop\n\nRevised after upgrade.\n",
    });
    expect(revised.record).toMatchObject({
      id: proposalId,
      proposedVersion: "v2",
      status: "pending",
      supportFiles: [expect.objectContaining({ path: "references/proof.md" })],
    });

    await expect(
      applySkillProposal({ workspaceDir, agentId: "main", proposalId }),
    ).resolves.toMatchObject({
      record: { id: proposalId, status: "applied" },
    });
    await expect(fs.readFile(revised.record.target.skillFile, "utf8")).resolves.toContain(
      "Revised after upgrade.",
    );
    await expect(
      fs.readFile(path.join(revised.record.target.skillDir, "references", "proof.md"), "utf8"),
    ).resolves.toBe(supportContent);
  });

  it("restores a shipped partial apply after migration and allows retry", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-partial-upgrade-");
    const proposalId = "partial-workshop-20260729-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    const targetDir = path.join(workspaceDir, "skills", "partial-workshop");
    const targetSupportFile = path.join(targetDir, "references", "proof.md");
    const now = "2026-07-29T00:00:00.000Z";
    const supportContent = "Shipped partial support.\n";
    const content = renderProposalMarkdown({
      name: "partial-workshop",
      description: "Recover a shipped interrupted apply",
      content: "# Partial Workshop\n\nOriginal shipped proposal.\n",
      date: now,
    });
    const record: SkillProposalRecord = {
      schema: SKILL_WORKSHOP_SCHEMA,
      id: proposalId,
      kind: "create",
      status: "pending",
      title: "Create Partial Workshop",
      description: "Recover a shipped interrupted apply",
      createdAt: now,
      updatedAt: now,
      createdBy: "skill-workshop",
      origin: { agentId: "main", runId: "partial-upgrade-run" },
      originRunIds: ["partial-upgrade-run"],
      originRunMutationCounts: { "partial-upgrade-run": 1 },
      proposedVersion: "v1",
      draftFile: "PROPOSAL.md",
      draftHash: hashSkillProposalContent(content),
      supportFiles: [
        {
          path: "references/proof.md",
          sizeBytes: Buffer.byteLength(supportContent, "utf8"),
          hash: hashSkillProposalContent(supportContent),
        },
      ],
      target: {
        skillName: "Partial Workshop",
        skillKey: "partial-workshop",
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
    const rollback: SkillProposalRollback = {
      schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
      proposalId,
      writtenAt: now,
      targetSkillFile: record.target.skillFile,
      action: "create",
      supportFiles: [{ path: "references/proof.md", existed: false }],
    };
    await fs.mkdir(path.join(proposalDir, "references"), { recursive: true });
    await fs.mkdir(path.dirname(targetSupportFile), { recursive: true });
    await fs.writeFile(path.join(proposalDir, "proposal.json"), JSON.stringify(record), "utf8");
    await fs.writeFile(path.join(proposalDir, "PROPOSAL.md"), content, "utf8");
    await fs.writeFile(path.join(proposalDir, "references", "proof.md"), supportContent, "utf8");
    await fs.writeFile(path.join(proposalDir, "rollback.json"), JSON.stringify(rollback), "utf8");
    await fs.writeFile(targetSupportFile, supportContent, "utf8");

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
    ).resolves.toMatchObject({ detected: 1, migrated: 1, warnings: [] });
    await expect(readSkillProposalRollback(proposalId)).resolves.toMatchObject(rollback);

    await expect(listSkillProposals({ agentId: "main" })).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposalId, status: "pending" })],
    });
    await expect(fs.readFile(targetSupportFile, "utf8")).resolves.toBe(supportContent);

    const revised = await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId,
      content: "# Partial Workshop\n\nRevised after recovery.\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, agentId: "main", proposalId }),
    ).resolves.toMatchObject({ record: { id: proposalId, status: "applied" } });
    await expect(fs.readFile(revised.record.target.skillFile, "utf8")).resolves.toContain(
      "Revised after recovery.",
    );
    await expect(fs.readFile(targetSupportFile, "utf8")).resolves.toBe(supportContent);
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

    await expect(listSkillProposals()).resolves.toMatchObject({ proposals: [] });
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

    const listed = await listSkillProposals({ agentId: "main" });
    expect(listed.proposals).toEqual([expect.objectContaining({ id: proposalId })]);
    await expect(inspectSkillProposal(proposalId, { agentId: "main" })).resolves.toMatchObject({
      record: {
        originRunIds: ["legacy-run", "revision-run"],
        originRunMutationCounts: { "legacy-run": 1, "revision-run": 2 },
        target: {
          skillDir: path.join(resolveWorkshopSkillsDir(testState.env), "legacy-workshop"),
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

  it("quarantines a non-empty legacy directory missing proposal.json so Doctor converges", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workshop-missing-json-");
    const proposalId = "missing-json-workshop-20260829-1234567890";
    const proposalDir = path.join(testState.stateDir, "skill-workshop", "proposals", proposalId);
    // Leftover review artifact without the required proposal.json / PROPOSAL.md.
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
    // The metadata JSON sidecar is preserved for manual recovery.
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
