import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalizePath } from "../../agents/utils/paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import {
  openSkillWorkshopStore,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import type { SkillProposalRecord } from "./types.js";

export type SkillLifecycleRecord = {
  state: string;
  pinned: boolean;
};

function canonicalSkillFile(skillFile: string): string {
  return canonicalizePath(path.resolve(skillFile));
}

export function readSkillLifecycleRecord(
  skillFile: string,
  options: SkillWorkshopStoreOptions = {},
): SkillLifecycleRecord | null {
  const { database, kysely } = openSkillWorkshopStore(options);
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("skill_lifecycle")
      .select(["state", "pinned"])
      .where("skill_file", "=", canonicalSkillFile(skillFile)),
  );
  return row ? { state: row.state, pinned: row.pinned === 1 } : null;
}

export function readArchivedSkillFiles(
  options: SkillWorkshopStoreOptions = {},
): ReadonlySet<string> {
  const records = readSkillLifecycleRecords(options);
  return new Set(
    [...records]
      .filter(([, record]) => record.state === "archived")
      .map(([skillFile]) => skillFile),
  );
}

export function readSkillLifecycleRecords(
  options: SkillWorkshopStoreOptions = {},
): ReadonlyMap<string, SkillLifecycleRecord> {
  const { database, kysely } = openSkillWorkshopStore(options);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("skill_lifecycle").select(["skill_file", "state", "pinned"]),
  ).rows;
  return new Map(
    rows.map((row) => [row.skill_file, { state: row.state, pinned: row.pinned === 1 }]),
  );
}

export function commitAppliedSkillLifecycle(
  database: DatabaseSync,
  record: SkillProposalRecord,
  appliedAtMs: number,
): void {
  const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(database);
  const targetSkillFile = canonicalSkillFile(record.target.skillFile);
  if (record.kind === "create" && record.createdBy === "skill-workshop") {
    const createdAtMs = Date.parse(record.createdAt);
    executeSqliteQuerySync(
      database,
      kysely
        .insertInto("skill_lifecycle")
        .values({
          skill_file: targetSkillFile,
          skill_key: record.target.skillKey,
          skill_name: record.target.skillName,
          state: "active",
          pinned: 0,
          state_changed_at_ms: appliedAtMs,
          created_at_ms: Number.isFinite(createdAtMs) ? createdAtMs : appliedAtMs,
          archived_reason: null,
        })
        .onConflict((conflict) =>
          conflict.column("skill_file").doUpdateSet({
            skill_key: record.target.skillKey,
            skill_name: record.target.skillName,
            state: "active",
            state_changed_at_ms: appliedAtMs,
            archived_reason: null,
          }),
        ),
    );
  } else {
    const targetLifecycle = executeSqliteQueryTakeFirstSync(
      database,
      kysely
        .selectFrom("skill_lifecycle")
        .select("state")
        .where("skill_file", "=", targetSkillFile),
    );
    if (targetLifecycle?.state === "archived") {
      throw new Error(`Target skill is no longer eligible: ${record.target.skillKey}`);
    }
    executeSqliteQuerySync(
      database,
      kysely
        .updateTable("skill_lifecycle")
        .set({
          skill_key: record.target.skillKey,
          skill_name: record.target.skillName,
          state: "active",
          state_changed_at_ms: appliedAtMs,
          archived_reason: null,
        })
        .where("skill_file", "=", targetSkillFile),
    );
  }

  for (const source of record.supersedes ?? []) {
    const sourceSkillFile = canonicalSkillFile(source.skillFile);
    if (sourceSkillFile === targetSkillFile) {
      throw new Error(`A skill cannot supersede itself: ${source.skillKey}`);
    }
    const lifecycle = executeSqliteQueryTakeFirstSync(
      database,
      kysely
        .selectFrom("skill_lifecycle")
        .select(["pinned", "state"])
        .where("skill_file", "=", sourceSkillFile),
    );
    if (!lifecycle || lifecycle.pinned === 1 || lifecycle.state === "archived") {
      throw new Error(`Superseded skill is no longer eligible: ${source.skillKey}`);
    }
    executeSqliteQuerySync(
      database,
      kysely
        .updateTable("skill_lifecycle")
        .set({
          state: "archived",
          state_changed_at_ms: appliedAtMs,
          archived_reason: `superseded by ${record.target.skillKey}`,
        })
        .where("skill_file", "=", sourceSkillFile),
    );
  }
}
