import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applySkillProposal,
  proposeCreateSkill,
  proposeUpdateSkill,
} from "../skills/workshop/service.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { readStoredProposal } from "../skills/workshop/store-sqlite-record.js";
import { hashSkillProposalContent, updateSkillProposalRecord } from "../skills/workshop/store.js";
import { SKILL_WORKSHOP_SCHEMA, type SkillProposalRecord } from "../skills/workshop/types.js";
import {
  openOpenClawStateDatabase,
  repairOpenClawStateDatabaseSchemaIfNeeded,
} from "../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";
import { seedLegacyV15ProposalRows } from "./doctor-skill-workshop-sqlite.test-support.js";

const tempDirs = createTrackedTempDirs();
let testState: OpenClawTestState;

beforeEach(async () => {
  testState = await createOpenClawTestState({
    layout: "state-only",
    prefix: "openclaw-workshop-relocation-atomicity-",
  });
});

afterEach(async () => {
  await testState.cleanup();
  await tempDirs.cleanup();
});

function appliedCreate(params: { id: string; skillName: string; skillDir: string }) {
  const content = `---\nname: ${params.skillName}\ndescription: Relocation procedure\n---\n\n# Procedure\n`;
  const now = "2026-09-01T00:00:00.000Z";
  const record: SkillProposalRecord = {
    schema: SKILL_WORKSHOP_SCHEMA,
    id: params.id,
    kind: "create",
    status: "applied",
    title: `Create ${params.skillName}`,
    description: "Relocation procedure",
    createdAt: now,
    updatedAt: now,
    createdBy: "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(content),
    target: {
      skillName: params.skillName,
      skillKey: params.skillName,
      skillDir: params.skillDir,
      skillFile: path.join(params.skillDir, "SKILL.md"),
      source: "openclaw-workspace",
    },
    scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
    appliedAt: now,
  };
  return { record, content };
}

describe("doctor Workshop relocation ownership and commit boundaries", () => {
  it("recovers an applied update with no pending proposal after relocation commit failure", async () => {
    const workspaceDir = await fs.realpath(
      await tempDirs.make("workshop-applied-update-recovery-"),
    );
    const options = { workspaceDir, config: {}, agentId: "main", env: testState.env };
    const name = "applied-update-recovery";
    const create = await proposeCreateSkill({
      ...options,
      name,
      description: "Recover an improved procedure",
      content: "# Original procedure\n",
    });
    const created = await applySkillProposal({
      ...options,
      proposalId: create.record.id,
      expectedRevisionHash: create.revisionHash,
    });
    const update = await proposeUpdateSkill({
      ...options,
      skillName: name,
      content: "# Updated procedure\n\nVerify the final result.\n",
    });
    const updated = await applySkillProposal({
      ...options,
      proposalId: update.record.id,
      expectedRevisionHash: update.revisionHash,
    });
    expect([created.record.status, updated.record.status]).toEqual(["applied", "applied"]);
    const liveContent = await fs.readFile(updated.targetSkillFile, "utf8");
    expect(liveContent).toContain("# Updated procedure");
    const legacySkillDir = path.join(workspaceDir, "skills", name);
    const legacySkillFile = path.join(legacySkillDir, "SKILL.md");
    await fs.mkdir(path.dirname(legacySkillDir), { recursive: true });
    await fs.cp(created.record.target.skillDir, legacySkillDir, { recursive: true });
    await fs.rm(created.record.target.skillDir, { recursive: true });
    const legacyRecords: SkillProposalRecord[] = [];
    for (const record of [created.record, updated.record]) {
      const legacy: SkillProposalRecord = {
        ...record,
        target: {
          ...record.target,
          skillDir: legacySkillDir,
          skillFile: legacySkillFile,
          source: "openclaw-workspace",
        },
      };
      legacyRecords.push(legacy);
      await updateSkillProposalRecord({ record: legacy, store: { env: testState.env } });
    }
    const database = openOpenClawStateDatabase({ env: testState.env });
    database.db.exec(`
      CREATE TEMP TRIGGER reject_applied_create_relocation
      BEFORE UPDATE OF record_json ON main.skill_workshop_proposals
      WHEN OLD.proposal_id = '${created.record.id}'
        AND json_extract(NEW.record_json, '$.target.source') = 'openclaw-workshop'
      BEGIN
        SELECT RAISE(ABORT, 'applied create relocation metadata unavailable');
      END;
    `);
    try {
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
      ).rejects.toThrow("applied create relocation metadata unavailable");
    } finally {
      database.db.exec("DROP TRIGGER reject_applied_create_relocation");
    }
    await expect(fs.access(legacySkillDir)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.readFile(updated.targetSkillFile, "utf8")).resolves.toBe(liveContent);
    expect(readStoredProposal(created.record.id, { env: testState.env })?.record).toEqual(
      legacyRecords[0],
    );

    const recovered = await migrateLegacySkillWorkshopProposals({
      config: {},
      env: testState.env,
    });

    expect(recovered.warnings).toEqual([]);
    expect(readStoredProposal(created.record.id, { env: testState.env })?.record).toMatchObject({
      status: "applied",
      target: created.record.target,
    });
    expect(readStoredProposal(updated.record.id, { env: testState.env })?.record).toEqual(
      legacyRecords[1],
    );
    await expect(fs.readFile(updated.targetSkillFile, "utf8")).resolves.toBe(liveContent);
    await expect(
      migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
    ).resolves.toMatchObject({ changes: [], warnings: [], migrated: 0 });
  });

  it.each(["original", "improved", "display-name"] as const)(
    "recovers %s skill bytes when its pending update cannot commit",
    async (version) => {
      const workspaceDir = await fs.realpath(await tempDirs.make("workshop-metadata-failure-"));
      const created = appliedCreate({
        id: "atomic-create-20260901-1234567890",
        skillName: "atomic-skill",
        skillDir: path.join(workspaceDir, "skills", "atomic-skill"),
      });
      const liveContent =
        version === "display-name"
          ? '---\nname: Atomic Guide\ndescription: Relocation procedure\nmetadata: {"openclaw":{"skillKey":"atomic-skill"}}\n---\n\n# Improved procedure\n'
          : version === "improved"
            ? `${created.content}\nVerify the result before continuing.\n`
            : created.content;
      const pending: SkillProposalRecord = {
        ...created.record,
        id: "atomic-update-20260901-1234567890",
        kind: "update",
        status: "pending",
        appliedAt: undefined,
        draftHash: hashSkillProposalContent(`${created.content}\nRecord the result.\n`),
        target: {
          ...created.record.target,
          skillName: version === "display-name" ? "Atomic Guide" : created.record.target.skillName,
          currentContentHash: hashSkillProposalContent(liveContent),
        },
      };
      await fs.mkdir(created.record.target.skillDir, { recursive: true });
      await fs.writeFile(created.record.target.skillFile, liveContent);
      seedLegacyV15ProposalRows(testState.env, [
        { record: created.record, workspaceDir, claimReleasedTime: null },
        { record: pending, workspaceDir, claimReleasedTime: null },
      ]);
      repairOpenClawStateDatabaseSchemaIfNeeded({ env: testState.env });
      const database = openOpenClawStateDatabase({ env: testState.env });
      database.db.exec(`
      CREATE TEMP TRIGGER reject_pending_relocation
      BEFORE UPDATE OF record_json ON main.skill_workshop_proposals
      WHEN OLD.proposal_id = '${pending.id}'
        AND NEW.status = 'pending'
        AND json_extract(NEW.record_json, '$.target.source') = 'openclaw-workshop'
      BEGIN
        SELECT RAISE(ABORT, 'pending relocation metadata unavailable');
      END;
    `);
      try {
        await expect(
          migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
        ).rejects.toThrow("pending relocation metadata unavailable");
      } finally {
        database.db.exec("DROP TRIGGER reject_pending_relocation");
      }
      const afterFailure = {
        created: readStoredProposal(created.record.id, { env: testState.env })?.record,
        pending: readStoredProposal(pending.id, { env: testState.env })?.record,
      };
      const destinationDir = path.join(
        resolveWorkshopSkillsDir({}, "main", testState.env),
        "atomic-skill",
      );
      await expect(fs.access(created.record.target.skillDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.readFile(path.join(destinationDir, "SKILL.md"), "utf8")).resolves.toBe(
        liveContent,
      );

      await migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env });
      const afterRetry = {
        created: readStoredProposal(created.record.id, { env: testState.env })?.record,
        pending: readStoredProposal(pending.id, { env: testState.env })?.record,
      };
      expect(afterFailure).toMatchObject({
        created: { status: "applied", target: created.record.target },
        pending: { status: "pending", target: pending.target },
      });
      const relocatedTarget = {
        skillDir: destinationDir,
        skillFile: path.join(destinationDir, "SKILL.md"),
        source: "openclaw-workshop",
      };
      expect(afterRetry).toMatchObject({
        created: { status: "applied", target: relocatedTarget },
        pending: { status: "pending", target: relocatedTarget },
      });
      await expect(
        migrateLegacySkillWorkshopProposals({ config: {}, env: testState.env }),
      ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
    },
  );

  it("leaves one source untouched when applied records claim different agent destinations", async () => {
    const workspaceDir = await fs.realpath(await tempDirs.make("workshop-conflicting-owners-"));
    const skillDir = path.join(workspaceDir, "skills", "shared-skill");
    const config = {
      agents: {
        ownership: "explicit" as const,
        entries: {
          alpha: { workspace: workspaceDir, agentDir: path.join(workspaceDir, ".alpha") },
          beta: { workspace: workspaceDir, agentDir: path.join(workspaceDir, ".beta") },
        },
      },
    };
    const claims = ["alpha", "beta"].map((agentId) => {
      const { record, content } = appliedCreate({
        id: `shared-${agentId}-20260901-1234567890`,
        skillName: "shared-skill",
        skillDir,
      });
      return { agentId, record, content };
    });
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), claims[0]!.content);
    seedLegacyV15ProposalRows(
      testState.env,
      claims.map(({ record, agentId }) => ({
        record,
        workspaceDir,
        ownerAgentId: agentId,
        claimReleasedTime: null,
      })),
    );

    await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

    await expect(fs.readFile(path.join(skillDir, "SKILL.md"), "utf8")).resolves.toBe(
      claims[0]!.content,
    );
    for (const { record, agentId } of claims) {
      const stored = readStoredProposal(record.id, { env: testState.env })?.record;
      expect(stored).toMatchObject({ status: "stale", target: record.target });
      expect(stored?.statusReason).toContain("relocation conflict");
      await expect(
        fs.access(
          path.join(resolveWorkshopSkillsDir(config, agentId, testState.env), "shared-skill"),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    }
    await expect(
      migrateLegacySkillWorkshopProposals({ config, env: testState.env }),
    ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
  });

  it.each([
    { order: "parent first", childFirst: false, childClaim: true },
    { order: "child first", childFirst: true, childClaim: true },
    { order: "no child claim", childFirst: false, childClaim: false },
  ])(
    "preserves overlapping sources across configured workspaces ($order)",
    async ({ childFirst, childClaim }) => {
      const workspaceDir = await fs.realpath(await tempDirs.make("workshop-nested-workspaces-"));
      const nestedWorkspace = path.join(workspaceDir, "skills", "parent-skill");
      const config = {
        agents: {
          ownership: "explicit" as const,
          entries: {
            alpha: { workspace: workspaceDir },
            beta: { workspace: nestedWorkspace },
          },
        },
      };
      const claims = [
        {
          agentId: "alpha",
          workspaceDir,
          ...appliedCreate({
            id: "nested-parent-20260901-1234567890",
            skillName: "parent-skill",
            skillDir: nestedWorkspace,
          }),
        },
        {
          agentId: "beta",
          workspaceDir: nestedWorkspace,
          ...appliedCreate({
            id: "nested-child-20260901-1234567890",
            skillName: "child-skill",
            skillDir: path.join(nestedWorkspace, "skills", "child-skill"),
          }),
        },
      ];
      for (const { record, content } of claims) {
        await fs.mkdir(record.target.skillDir, { recursive: true });
        await fs.writeFile(record.target.skillFile, content);
      }
      const active = childClaim ? claims : [claims[0]!];
      const ordered = childFirst ? active.toReversed() : active;
      seedLegacyV15ProposalRows(
        testState.env,
        ordered.map(({ record, agentId, workspaceDir: sourceWorkspace }) => ({
          record,
          workspaceDir: sourceWorkspace,
          ownerAgentId: agentId,
          claimReleasedTime: null,
        })),
      );

      const result = await migrateLegacySkillWorkshopProposals({ config, env: testState.env });

      expect(result.warnings).toEqual([]);
      expect(result.changes.join("\n")).toContain(`marked ${active.length} stale`);
      for (const { record, content, agentId } of claims) {
        await expect(fs.readFile(record.target.skillFile, "utf8")).resolves.toBe(content);
        if (!active.some((claim) => claim.record.id === record.id)) {
          expect(readStoredProposal(record.id, { env: testState.env })).toBeNull();
          continue;
        }
        expect(readStoredProposal(record.id, { env: testState.env })?.record).toMatchObject({
          status: "stale",
          target: record.target,
          statusReason: expect.stringContaining("relocation conflict"),
        });
        await expect(
          fs.access(
            path.join(
              resolveWorkshopSkillsDir(config, agentId, testState.env),
              record.target.skillKey,
            ),
          ),
        ).rejects.toMatchObject({ code: "ENOENT" });
      }
    },
  );
});
