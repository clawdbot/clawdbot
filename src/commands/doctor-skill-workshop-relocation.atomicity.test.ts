import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { readStoredProposal } from "../skills/workshop/store-sqlite-record.js";
import { hashSkillProposalContent } from "../skills/workshop/store.js";
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
    const claims = ["alpha", "beta"].map((agentId) => ({
      agentId,
      ...appliedCreate({
        id: `shared-${agentId}-20260901-1234567890`,
        skillName: "shared-skill",
        skillDir,
      }),
    }));
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
});
