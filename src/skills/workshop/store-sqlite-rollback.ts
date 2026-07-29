import type { DatabaseSync } from "node:sqlite";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { assertProposalId, parseSkillProposalRollback } from "./store-record.js";
import { parseJson } from "./store-sqlite-record.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  openSkillWorkshopStore,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import { SKILL_WORKSHOP_ROLLBACK_SCHEMA, type SkillProposalRollback } from "./types.js";

function removeOtherPendingTargetRollbacks(
  database: DatabaseSync,
  params: { proposalId: string; targetSkillFile: string },
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    kysely
      .selectFrom("skill_workshop_proposal_rollbacks")
      .innerJoin(
        "skill_workshop_proposals",
        "skill_workshop_proposals.proposal_id",
        "skill_workshop_proposal_rollbacks.proposal_id",
      )
      .select("skill_workshop_proposal_rollbacks.proposal_id as proposalId")
      .where("skill_workshop_proposal_rollbacks.target_skill_file", "=", params.targetSkillFile)
      .where("skill_workshop_proposals.status", "=", "pending")
      .where("skill_workshop_proposals.proposal_id", "!=", params.proposalId),
  ).rows;
  for (const row of rows) {
    executeSqliteQuerySync(
      database,
      kysely
        .deleteFrom("skill_workshop_proposal_rollbacks")
        .where("proposal_id", "=", row.proposalId),
    );
  }
}

export async function writeSkillProposalRollback(params: {
  proposalId: string;
  rollback: SkillProposalRollback;
  store?: SkillWorkshopStoreOptions;
}): Promise<void> {
  assertProposalId(params.proposalId);
  ensureSkillWorkshopSchema(params.store);
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
      const proposal = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("skill_workshop_proposals")
          .select(["proposal_id", "kind", "status"])
          .where("proposal_id", "=", params.proposalId),
      );
      if (!proposal) {
        throw new Error(`Skill proposal not found: ${params.proposalId}`);
      }
      if (proposal.status !== "pending") {
        throw new Error(
          `Only pending proposals can be applied. Current status: ${proposal.status}.`,
        );
      }
      removeOtherPendingTargetRollbacks(db, {
        proposalId: params.proposalId,
        targetSkillFile: params.rollback.targetSkillFile,
      });
      executeSqliteQuerySync(
        db,
        kysely
          .insertInto("skill_workshop_proposal_rollbacks")
          .values({
            proposal_id: params.proposalId,
            written_at: params.rollback.writtenAt,
            target_skill_file: params.rollback.targetSkillFile,
            action: params.rollback.action,
            previous_content_hash: params.rollback.previousContentHash ?? null,
            previous_content: params.rollback.previousContent ?? null,
            support_files_json: params.rollback.supportFiles
              ? JSON.stringify(params.rollback.supportFiles)
              : null,
          })
          .onConflict((conflict) =>
            conflict.column("proposal_id").doUpdateSet({
              written_at: params.rollback.writtenAt,
              target_skill_file: params.rollback.targetSkillFile,
              action: params.rollback.action,
              previous_content_hash: params.rollback.previousContentHash ?? null,
              previous_content: params.rollback.previousContent ?? null,
              support_files_json: params.rollback.supportFiles
                ? JSON.stringify(params.rollback.supportFiles)
                : null,
            }),
          ),
      );
    },
    databaseOptions(params.store),
    { operationLabel: "skill-workshop.rollback.write" },
  );
}

export async function readSkillProposalRollback(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): Promise<SkillProposalRollback | null> {
  assertProposalId(proposalId);
  const { database, kysely } = openSkillWorkshopStore(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("skill_workshop_proposal_rollbacks")
      .selectAll()
      .where("proposal_id", "=", proposalId),
  );
  if (!row) {
    return null;
  }
  return parseSkillProposalRollback({
    schema: SKILL_WORKSHOP_ROLLBACK_SCHEMA,
    proposalId: row.proposal_id,
    writtenAt: row.written_at,
    targetSkillFile: row.target_skill_file,
    action: row.action,
    ...(row.previous_content_hash ? { previousContentHash: row.previous_content_hash } : {}),
    ...(row.previous_content !== null ? { previousContent: row.previous_content } : {}),
    ...(row.support_files_json ? { supportFiles: parseJson(row.support_files_json) } : {}),
  });
}
