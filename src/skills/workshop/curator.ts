import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { canonicalizePath } from "../../agents/utils/paths.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";

const log = createSubsystemLogger("skills/curator");
const CURATOR_STATE_ID = 1;
let loggedArchivedSkillReadFailure = false;

type SkillLifecycleState = "active" | "archived" | "stale";
type CuratorDatabase = Pick<
  OpenClawStateDatabase,
  "skill_curator_state" | "skill_lifecycle" | "skill_usage"
>;
type SkillOverlapCandidate = { left: string; right: string; score: number };

export type SkillCuratorStatus = {
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  counts: Record<SkillLifecycleState, number>;
  skills: Array<{
    skillFile: string;
    skillKey: string;
    skillName: string;
    state: SkillLifecycleState;
    pinned: boolean;
    createdAtMs: number;
    stateChangedAtMs: number;
    lastUsedAtMs: number | null;
    useCount: number;
    archivedReason: string | null;
  }>;
  overlaps: SkillOverlapCandidate[];
};

type CuratorOptions = OpenClawStateDatabaseOptions & { nowMs?: number };

function curatorDb(options: OpenClawStateDatabaseOptions = {}) {
  const database = openOpenClawStateDatabase(options);
  return { database, kysely: getNodeSqliteKysely<CuratorDatabase>(database.db) };
}

function canonicalSkillKey(name: string): string {
  const key = normalizeSkillIndexName(name);
  if (!key) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return key;
}

function parseLifecycleState(value: string): SkillLifecycleState {
  if (value === "active" || value === "stale" || value === "archived") {
    return value;
  }
  throw new Error(`Invalid legacy skill lifecycle state: ${value}`);
}

function parseOverlapCandidates(value: string | null | undefined): SkillOverlapCandidate[] {
  if (!value) {
    return [];
  }
  try {
    const overlaps = asNullableRecord(JSON.parse(value))?.overlaps;
    if (!Array.isArray(overlaps)) {
      return [];
    }
    return overlaps.flatMap((entry) => {
      const overlap = asNullableRecord(entry);
      return overlap &&
        typeof overlap.left === "string" &&
        typeof overlap.right === "string" &&
        typeof overlap.score === "number"
        ? [{ left: overlap.left, right: overlap.right, score: overlap.score }]
        : [];
    });
  } catch {
    return [];
  }
}

export function getSkillCuratorStatus(
  options: OpenClawStateDatabaseOptions = {},
): SkillCuratorStatus {
  const { database, kysely } = curatorDb(options);
  const state = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely.selectFrom("skill_curator_state").selectAll().where("id", "=", CURATOR_STATE_ID),
  );
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_lifecycle")
      .leftJoin("skill_usage", "skill_usage.skill_file", "skill_lifecycle.skill_file")
      .select([
        "skill_lifecycle.skill_key as skillKey",
        "skill_lifecycle.skill_name as skillName",
        "skill_lifecycle.skill_file as skillFile",
        "skill_lifecycle.state as state",
        "skill_lifecycle.pinned as pinned",
        "skill_lifecycle.created_at_ms as createdAtMs",
        "skill_lifecycle.state_changed_at_ms as stateChangedAtMs",
        "skill_lifecycle.archived_reason as archivedReason",
        "skill_usage.last_used_at_ms as lastUsedAtMs",
        "skill_usage.use_count as useCount",
      ])
      .orderBy("skill_lifecycle.skill_file", "asc"),
  ).rows;
  const counts: Record<SkillLifecycleState, number> = { active: 0, stale: 0, archived: 0 };
  const skills = [];
  for (const row of rows) {
    const lifecycleState = parseLifecycleState(row.state);
    counts[lifecycleState] += 1;
    skills.push({
      ...row,
      state: lifecycleState,
      pinned: row.pinned === 1,
      lastUsedAtMs: row.lastUsedAtMs ?? null,
      useCount: row.useCount ?? 0,
    });
  }
  return {
    lastAttemptAtMs: state?.last_attempt_at_ms ?? null,
    lastSuccessAtMs: state?.last_success_at_ms ?? null,
    lastError: state?.last_error ?? null,
    counts,
    skills,
    overlaps: parseOverlapCandidates(state?.last_result_json),
  };
}

function updateLifecyclePin(skill: string, pinned: boolean, options: OpenClawStateDatabaseOptions) {
  const skillKey = canonicalSkillKey(skill);
  const firstSkillFile = runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    const first = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("skill_lifecycle")
        .select("skill_file")
        .where("skill_key", "=", skillKey)
        .orderBy("skill_file", "asc"),
    );
    if (!first) {
      return null;
    }
    const changed = executeSqliteQuerySync(
      db,
      kysely
        .updateTable("skill_lifecycle")
        .set({ pinned: pinned ? 1 : 0 })
        .where("skill_key", "=", skillKey),
    ).numAffectedRows;
    return changed === 0n ? null : first.skill_file;
  }, options);
  if (!firstSkillFile) {
    throw new Error(`Curated skill not found: ${skill}`);
  }
  return getSkillCuratorStatus(options).skills.find((entry) => entry.skillFile === firstSkillFile)!;
}

export function pinCuratedSkill(skill: string, options: OpenClawStateDatabaseOptions = {}) {
  return updateLifecyclePin(skill, true, options);
}

export function unpinCuratedSkill(skill: string, options: OpenClawStateDatabaseOptions = {}) {
  return updateLifecyclePin(skill, false, options);
}

export function restoreCuratedSkill(skill: string, options: CuratorOptions = {}) {
  const skillKey = canonicalSkillKey(skill);
  const nowMs = options.nowMs ?? Date.now();
  const firstSkillFile = runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    const first = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("skill_lifecycle")
        .select("skill_file")
        .where("skill_key", "=", skillKey)
        .where("state", "=", "archived")
        .orderBy("skill_file", "asc"),
    );
    if (!first) {
      return null;
    }
    const changed = executeSqliteQuerySync(
      db,
      kysely
        .updateTable("skill_lifecycle")
        .set({ state: "active", state_changed_at_ms: nowMs, archived_reason: null })
        .where("skill_key", "=", skillKey)
        .where("state", "=", "archived"),
    ).numAffectedRows;
    return changed === 0n ? null : first.skill_file;
  }, options);
  if (!firstSkillFile) {
    throw new Error(`Archived curated skill not found: ${skill}`);
  }
  bumpSkillsSnapshotVersion({ reason: "workshop", changedPath: firstSkillFile });
  return getSkillCuratorStatus(options).skills.find((entry) => entry.skillFile === firstSkillFile)!;
}

export function getArchivedSkillFiles(
  options: OpenClawStateDatabaseOptions = {},
): ReadonlySet<string> {
  try {
    const { database, kysely } = curatorDb(options);
    const rows = executeSqliteQuerySync(
      database.db,
      kysely
        .selectFrom("skill_lifecycle")
        .select("skill_file")
        .where("state", "=", "archived")
        .orderBy("skill_file", "asc"),
    ).rows;
    return new Set(rows.map((row) => row.skill_file));
  } catch (error) {
    if (!loggedArchivedSkillReadFailure) {
      loggedArchivedSkillReadFailure = true;
      log.warn("failed to read archived skill state; loading without lifecycle filtering", {
        error: String(error),
      });
    }
    return new Set();
  }
}

/** Clears age-based state after the collection model has made a content decision. */
export function clearCuratedSkillLifecycle(
  skillFiles: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): void {
  if (skillFiles.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely.deleteFrom("skill_lifecycle").where(
        "skill_file",
        "in",
        skillFiles.map((skillFile) => canonicalizePath(skillFile)),
      ),
    );
  }, options);
}
