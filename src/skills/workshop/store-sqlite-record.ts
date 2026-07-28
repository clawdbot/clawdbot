import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Insertable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { parseSkillProposalRecord } from "./store-record.js";
import {
  openSkillWorkshopStore,
  type SkillProposalRow,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

export function parseJson(value: string | null): unknown {
  if (value === null) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function parseSkillProposalRow(row: SkillProposalRow): SkillProposalRecord | null {
  const record = parseSkillProposalRecord(parseJson(row.record_json));
  if (
    !record ||
    record.id !== row.proposal_id ||
    record.kind !== row.kind ||
    record.status !== row.status ||
    record.createdAt !== row.created_at ||
    record.updatedAt !== row.updated_at ||
    record.draftHash !== row.draft_hash ||
    record.origin?.agentId !== (row.origin_agent_id ?? undefined) ||
    record.origin?.sessionKey !== (row.origin_session_key ?? undefined) ||
    record.origin?.runId !== (row.origin_run_id ?? undefined) ||
    record.origin?.messageId !== (row.origin_message_id ?? undefined)
  ) {
    return null;
  }
  return record;
}

export function readStoredProposal(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
): { record: SkillProposalRecord; row: SkillProposalRow } | null {
  const { database, kysely } = openSkillWorkshopStore(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("skill_workshop_proposals").selectAll().where("proposal_id", "=", proposalId),
  );
  if (!row) {
    return null;
  }
  const record = parseSkillProposalRow(row);
  return record ? { record, row } : null;
}

function proposalRowValues(params: {
  record: SkillProposalRecord;
  ownerAgentId: string | null;
  workspaceDir: string;
}): Insertable<SkillWorkshopDatabase["skill_workshop_proposals"]> {
  const { record } = params;
  return {
    proposal_id: record.id,
    record_json: JSON.stringify(record),
    owner_agent_id: params.ownerAgentId,
    workspace_dir: path.resolve(params.workspaceDir),
    kind: record.kind,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    draft_hash: record.draftHash,
    origin_agent_id: record.origin?.agentId ?? null,
    origin_session_key: record.origin?.sessionKey ?? null,
    origin_run_id: record.origin?.runId ?? null,
    origin_message_id: record.origin?.messageId ?? null,
    applied_at: record.appliedAt ?? null,
    rejected_at: record.rejectedAt ?? null,
    quarantined_at: record.quarantinedAt ?? null,
    stale_at: record.staleAt ?? null,
    status_reason: record.statusReason ?? null,
  };
}

function replaceOriginRuns(
  database: DatabaseSync,
  record: SkillProposalRecord,
  kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database),
): void {
  executeSqliteQuerySync(
    database,
    kysely.deleteFrom("skill_workshop_proposal_origin_runs").where("proposal_id", "=", record.id),
  );
  record.originRunIds?.forEach((runId, position) => {
    executeSqliteQuerySync(
      database,
      kysely.insertInto("skill_workshop_proposal_origin_runs").values({
        proposal_id: record.id,
        run_id: runId,
        position,
        mutation_count: record.originRunMutationCounts?.[runId] ?? 1,
      }),
    );
  });
}

export function insertProposal(
  database: DatabaseSync,
  params: { record: SkillProposalRecord; ownerAgentId: string | null; workspaceDir: string },
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  executeSqliteQuerySync(
    database,
    kysely.insertInto("skill_workshop_proposals").values(proposalRowValues(params)),
  );
  replaceOriginRuns(database, params.record, kysely);
}

export function updateProposal(
  database: DatabaseSync,
  current: SkillProposalRow,
  record: SkillProposalRecord,
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const { proposal_id: _proposalId, ...values } = proposalRowValues({
    record,
    ownerAgentId: current.owner_agent_id,
    workspaceDir: current.workspace_dir,
  });
  executeSqliteQuerySync(
    database,
    kysely.updateTable("skill_workshop_proposals").set(values).where("proposal_id", "=", record.id),
  );
  replaceOriginRuns(database, record, kysely);
}
