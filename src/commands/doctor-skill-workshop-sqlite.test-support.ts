import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import { readSkillProposalRecord as readSkillProposalRecordImpl } from "../skills/workshop/store.js";
import type { SkillProposalRecord } from "../skills/workshop/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";

export const readSkillProposalRecord = (
  proposalId: string,
  options: { env?: NodeJS.ProcessEnv } = {},
) => readSkillProposalRecordImpl(proposalId, { config: {}, ...options }, {}, { config: {} });

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
