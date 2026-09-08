import path from "node:path";
import { expect } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import {
  hashSkillProposalContent,
  readSkillProposalRecord as readSkillProposalRecordImpl,
} from "../skills/workshop/store.js";
import { SKILL_WORKSHOP_SCHEMA, type SkillProposalRecord } from "../skills/workshop/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { migrateLegacySkillWorkshopProposals } from "./doctor-skill-workshop-sqlite.js";

export const readSkillProposalRecord = (
  proposalId: string,
  options: { env?: NodeJS.ProcessEnv } = {},
) => readSkillProposalRecordImpl(proposalId, { config: {}, ...options }, {}, { config: {} });

export function createAppliedLegacyProposal(
  params: Pick<SkillProposalRecord, "id" | "title" | "description"> & {
    content: string;
    createdAt?: string;
    createdBy?: SkillProposalRecord["createdBy"];
    target: Pick<SkillProposalRecord["target"], "skillKey" | "skillDir"> &
      Partial<Pick<SkillProposalRecord["target"], "skillName" | "source">>;
  },
): SkillProposalRecord & { appliedAt: string } {
  const now = params.createdAt ?? "2026-09-01T00:00:00.000Z";
  return {
    schema: SKILL_WORKSHOP_SCHEMA,
    id: params.id,
    kind: "create",
    status: "applied",
    title: params.title,
    description: params.description,
    createdAt: now,
    updatedAt: now,
    createdBy: params.createdBy ?? "skill-workshop",
    proposedVersion: "v1",
    draftFile: "PROPOSAL.md",
    draftHash: hashSkillProposalContent(params.content),
    target: {
      skillName: params.target.skillKey,
      skillFile: path.join(params.target.skillDir, "SKILL.md"),
      source: "openclaw-workspace",
      ...params.target,
    },
    scan: { state: "clean", scannedAt: now, critical: 0, warn: 0, info: 0, findings: [] },
    appliedAt: now,
  };
}

export async function expectWorkshopMigrationConverged(params: {
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
}): Promise<void> {
  await expect(
    migrateLegacySkillWorkshopProposals({ config: params.config ?? {}, env: params.env }),
  ).resolves.toEqual({ changes: [], warnings: [], detected: 0, migrated: 0 });
}

export async function expectRelocationWriteFailure(params: {
  env: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  proposalId: string;
  status?: SkillProposalRecord["status"];
  message: string;
}): Promise<void> {
  const database = openOpenClawStateDatabase({ env: params.env });
  const statusClause = params.status ? `AND NEW.status = '${params.status}'` : "";
  database.db.exec(`
    CREATE TEMP TRIGGER reject_workshop_relocation
    BEFORE UPDATE OF record_json ON main.skill_workshop_proposals
    WHEN OLD.proposal_id = '${params.proposalId}'
      ${statusClause}
      AND json_extract(NEW.record_json, '$.target.source') = 'openclaw-workshop'
    BEGIN
      SELECT RAISE(ABORT, '${params.message}');
    END;
  `);
  try {
    await expect(
      migrateLegacySkillWorkshopProposals({ config: params.config ?? {}, env: params.env }),
    ).rejects.toThrow(params.message);
  } finally {
    database.db.exec("DROP TRIGGER reject_workshop_relocation");
  }
}

export function seedLegacyV15ProposalRows(
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
