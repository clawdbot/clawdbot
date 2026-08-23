import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import { getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { ensureColumn } from "../../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";

export type SkillWorkshopDatabase = Pick<
  OpenClawStateDatabase,
  | "skill_workshop_proposal_events"
  | "skill_workshop_proposal_origin_runs"
  | "skill_workshop_proposal_rollbacks"
  | "skill_workshop_proposals"
  | "skill_workshop_collection_reviews"
>;
export type SkillProposalRow = Selectable<SkillWorkshopDatabase["skill_workshop_proposals"]>;
export type SkillWorkshopStoreOptions = {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skill_workshop_proposals (
  proposal_id TEXT NOT NULL PRIMARY KEY,
  record_json TEXT NOT NULL,
  owner_agent_id TEXT,
  workspace_dir TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('create', 'update')),
  status TEXT NOT NULL CHECK (status IN ('pending', 'applied', 'rejected', 'quarantined', 'stale')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  draft_hash TEXT NOT NULL,
  origin_agent_id TEXT,
  origin_session_key TEXT,
  origin_run_id TEXT,
  origin_message_id TEXT,
  applied_at TEXT,
  rejected_at TEXT,
  quarantined_at TEXT,
  stale_at TEXT,
  status_reason TEXT,
  claim_released_time INTEGER
) STRICT;

CREATE TABLE IF NOT EXISTS skill_workshop_collection_reviews (
  review_id TEXT NOT NULL PRIMARY KEY,
  workspace_dir TEXT NOT NULL,
  backup_id TEXT NOT NULL,
  create_time INTEGER NOT NULL,
  kept_names_json TEXT NOT NULL,
  written_names_json TEXT NOT NULL,
  dropped_json TEXT NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_skill_workshop_collection_reviews_workspace_time
  ON skill_workshop_collection_reviews(workspace_dir, create_time DESC, review_id DESC);

CREATE TABLE IF NOT EXISTS skill_workshop_proposal_origin_runs (
  proposal_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  mutation_count INTEGER NOT NULL CHECK (mutation_count > 0),
  PRIMARY KEY (proposal_id, run_id),
  FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS skill_workshop_proposal_rollbacks (
  proposal_id TEXT NOT NULL PRIMARY KEY,
  written_at TEXT NOT NULL,
  target_skill_file TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'update')),
  previous_content_hash TEXT,
  previous_content TEXT,
  support_files_json TEXT,
  FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
) STRICT;

CREATE TABLE IF NOT EXISTS skill_workshop_proposal_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  proposal_id TEXT NOT NULL,
  proposed_version TEXT NOT NULL,
  revision_hash TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'created',
    'revised',
    'evaluation_completed',
    'applied',
    'rejected',
    'quarantined',
    'stale'
  )),
  occurred_at TEXT NOT NULL,
  actor_json TEXT NOT NULL,
  correlation_id TEXT,
  payload_json TEXT,
  FOREIGN KEY (proposal_id) REFERENCES skill_workshop_proposals(proposal_id) ON DELETE CASCADE
) STRICT;

CREATE INDEX IF NOT EXISTS idx_skill_workshop_proposal_events_proposal
  ON skill_workshop_proposal_events(proposal_id, sequence);
`;
const ensuredDatabases = new WeakSet<DatabaseSync>();

export function databaseOptions(
  options: SkillWorkshopStoreOptions = {},
): OpenClawStateDatabaseOptions {
  if (options.stateDir) {
    return {
      ...(options.env ? { env: options.env } : {}),
      path: path.join(path.resolve(options.stateDir), "state", "openclaw.sqlite"),
    };
  }
  return options.env ? { env: options.env } : {};
}

export function ensureSkillWorkshopSchema(options: SkillWorkshopStoreOptions = {}): void {
  const dbOptions = databaseOptions(options);
  const database = openOpenClawStateDatabase(dbOptions);
  if (ensuredDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      // sqlite-allow-raw -- Feature-local additive schema DDL; proposal rows use Kysely.
      db.exec(SCHEMA_SQL);
      ensureColumn(db, "skill_workshop_proposals", "claim_released_time INTEGER");
    },
    dbOptions,
    { operationLabel: "skill-workshop.schema.ensure" },
  );
  ensuredDatabases.add(database.db);
}

export function openSkillWorkshopStore(options: SkillWorkshopStoreOptions = {}) {
  ensureSkillWorkshopSchema(options);
  const database = openOpenClawStateDatabase(databaseOptions(options));
  return {
    database,
    kysely: getNodeSqliteKysely<SkillWorkshopDatabase>(database.db),
  };
}
