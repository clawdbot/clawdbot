import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderProposalMarkdown } from "../skills/workshop/frontmatter.js";
import {
  applySkillProposal,
  inspectSkillProposal,
  listSkillProposals,
  reviseSkillProposal,
} from "../skills/workshop/service.js";
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
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";

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
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toContain(
      "Revised after upgrade.",
    );
    await expect(
      fs.readFile(path.join(record.target.skillDir, "references", "proof.md"), "utf8"),
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

    await expect(listSkillProposals({ agentId: "main", workspaceDir })).resolves.toMatchObject({
      proposals: [expect.objectContaining({ id: proposalId, status: "pending" })],
    });
    await expect(fs.access(targetSupportFile)).rejects.toThrow();

    await reviseSkillProposal({
      workspaceDir,
      agentId: "main",
      proposalId,
      content: "# Partial Workshop\n\nRevised after recovery.\n",
    });
    await expect(
      applySkillProposal({ workspaceDir, agentId: "main", proposalId }),
    ).resolves.toMatchObject({ record: { id: proposalId, status: "applied" } });
    await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toContain(
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

    const listed = await listSkillProposals({ agentId: "main", workspaceDir: currentWorkspace });
    expect(listed.proposals).toEqual([
      expect.objectContaining({ id: proposalId, workspaceMismatch: true }),
    ]);
    await expect(
      inspectSkillProposal(proposalId, { agentId: "main", workspaceDir: currentWorkspace }),
    ).resolves.toMatchObject({
      record: {
        originRunIds: ["legacy-run", "revision-run"],
        originRunMutationCounts: { "legacy-run": 1, "revision-run": 2 },
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

    importLegacySkillProposal({ record, ownerAgentId: "main", workspaceDir });
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
    ).resolves.toEqual({ changes: [], warnings: [], detected: 1, migrated: 0 });
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
