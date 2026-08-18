import path from "node:path";
import { executeSqliteQuerySync } from "../../infra/kysely-sync.js";
import { parseSkillProposalRow } from "./store-sqlite-record.js";
import { openSkillWorkshopStore, type SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";

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
      .where("status", "=", "applied"),
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
