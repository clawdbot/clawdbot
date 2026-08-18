import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { logWarn } from "../../logger.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { parseSkillProposalRow } from "./store-sqlite-record.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  openSkillWorkshopStore,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";

function setWorkshopOwnershipClaimRelease(
  database: DatabaseSync,
  workspaceDir: string,
  skillDirs: readonly string[],
  releaseTime: number | null,
): void {
  const targetDirs = new Set(skillDirs.map((skillDir) => path.resolve(skillDir)));
  if (targetDirs.size === 0) {
    return;
  }
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const rows = executeSqliteQuerySync(
    database,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("workspace_dir", "=", path.resolve(workspaceDir))
      .where("kind", "=", "create")
      .where("status", "=", "applied"),
  ).rows;
  const proposalIds = rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record && targetDirs.has(path.resolve(record.target.skillDir)) ? [record.id] : [];
  });
  if (proposalIds.length === 0) {
    return;
  }
  executeSqliteQuerySync(
    database,
    kysely
      .updateTable("skill_workshop_proposals")
      .set({ claim_released_time: releaseTime })
      .where("proposal_id", "in", proposalIds),
  );
}

function writeWorkshopOwnershipClaimRelease(
  workspaceDir: string,
  skillDirs: readonly string[],
  releaseTime: number | null,
  options: SkillWorkshopStoreOptions,
): void {
  if (skillDirs.length === 0) {
    return;
  }
  ensureSkillWorkshopSchema(options);
  runOpenClawStateWriteTransaction(
    ({ db }) => setWorkshopOwnershipClaimRelease(db, workspaceDir, skillDirs, releaseTime),
    databaseOptions(options),
  );
}

export function releaseWorkshopOwnershipClaims(
  workspaceDir: string,
  skillDirs: readonly string[],
  releaseTime: number,
  options: SkillWorkshopStoreOptions = {},
): void {
  writeWorkshopOwnershipClaimRelease(workspaceDir, skillDirs, releaseTime, options);
}

export function restoreWorkshopOwnershipClaims(
  workspaceDir: string,
  skillDirs: readonly string[],
  options: SkillWorkshopStoreOptions = {},
): void {
  writeWorkshopOwnershipClaimRelease(workspaceDir, skillDirs, null, options);
}

export function restoreWorkshopOwnershipClaimsBestEffort(
  workspaceDir: string,
  skillDirs: readonly string[],
  options: SkillWorkshopStoreOptions = {},
): void {
  try {
    restoreWorkshopOwnershipClaims(workspaceDir, skillDirs, options);
  } catch (error) {
    logWarn(`skill-workshop: failed to reclaim ownership after rollback: ${String(error)}`);
  }
}

/** Paths claimed by a successfully applied Workshop create proposal. */
export function listWorkshopOwnedSkillDirs(
  workspaceDir: string,
  options: SkillWorkshopStoreOptions = {},
): Set<string> {
  const { database, kysely } = openSkillWorkshopStore(options);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("workspace_dir", "=", path.resolve(workspaceDir))
      .where("kind", "=", "create")
      .where("status", "=", "applied")
      .where("claim_released_time", "is", null),
  ).rows;
  // Unknown provenance fails closed to user-owned; only an applied create proves ownership.
  return new Set(
    rows.flatMap((row) => {
      const record = parseSkillProposalRow(row);
      return record ? [path.resolve(record.target.skillDir)] : [];
    }),
  );
}

export function isWorkshopOwnedSkillDir(
  workspaceDir: string,
  skillDir: string,
  options: SkillWorkshopStoreOptions = {},
): boolean {
  return listWorkshopOwnedSkillDirs(workspaceDir, options).has(path.resolve(skillDir));
}
