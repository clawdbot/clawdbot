import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderProposalMarkdown } from "../skills/workshop/frontmatter.js";
import {
  applySkillProposal,
  listSkillProposals,
  reviseSkillProposal,
} from "../skills/workshop/service.js";
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

    await expect(
      inspectLegacySkillWorkshopMigration({ config: {}, env: testState.env }),
    ).resolves.toEqual({
      externalProposalCount: 1,
      externalProposalCountsByAgent: { main: 1 },
      legacyBackupRootCount: 0,
    });
    const first = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });
    expect(first.changes.join("\n")).toContain("marked 1 stale");
    await expect(
      readSkillProposalRecord(proposalId, { config: {}, env: testState.env }, {}, { config: {} }),
    ).resolves.toMatchObject({
      status: "stale",
      statusReason: "Skill Workshop no longer edits skills outside its own directory.",
    });
    await expect(fs.readFile(skillFile, "utf8")).resolves.toBe(skillContent);
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
      config: {},
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
      applySkillProposal({ workspaceDir, agentId: "main", config: {}, proposalId }),
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

    await expect(listSkillProposals({ config: {}, agentId: "main" })).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposalId, status: "pending" })],
    });
    await expect(fs.readFile(targetSupportFile, "utf8")).resolves.toBe(supportContent);

    const revised = await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      config: {},
      proposalId,
      content: "# Partial Workshop\n\nRevised after recovery.\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, agentId: "main", config: {}, proposalId }),
    ).resolves.toMatchObject({ record: { id: proposalId, status: "applied" } });
    await expect(fs.readFile(revised.record.target.skillFile, "utf8")).resolves.toContain(
      "Revised after recovery.",
    );
    await expect(fs.readFile(targetSupportFile, "utf8")).resolves.toBe(supportContent);
  });
});
