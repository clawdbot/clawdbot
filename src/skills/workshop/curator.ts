import fs from "node:fs";
import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import type { DiagnosticSkillUsedEvent } from "../../infra/diagnostic-events.js";
import { onTrustedInternalDiagnosticEvent } from "../../infra/diagnostic-events.js";
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
import { readSkillProposalManifest, readSkillProposalRecord } from "./store.js";
import type { SkillProposalRecord } from "./types.js";

// Fixed policy keeps lifecycle behavior predictable and avoids another config surface.
const STALE_AFTER_MS = 30 * 24 * 60 * 60_000;
const ARCHIVE_AFTER_MS = 90 * 24 * 60 * 60_000;
const CURATOR_SWEEP_INTERVAL_MS = 24 * 60 * 60_000;
const CURATOR_INITIAL_DELAY_MS = 5 * 60_000;
const DOCTOR_WEDGED_AFTER_MS = 7 * 24 * 60 * 60_000;

const log = createSubsystemLogger("skills/curator");
const CURATOR_STATE_ID = 1;
const EMPTY_RESULT_JSON = "{}";
let loggedArchivedSkillReadFailure = false;

type SkillLifecycleState = "active" | "archived" | "stale";

type CuratorDatabase = Pick<
  OpenClawStateDatabase,
  "skill_curator_state" | "skill_lifecycle" | "skill_usage"
>;

type CuratedSkill = {
  createdAtMs: number;
  description: string;
  lastAppliedAtMs: number;
  skillFile: string;
  skillKey: string;
  skillName: string;
};

type SkillOverlapCandidate = {
  left: string;
  right: string;
  score: number;
};

type SkillCuratorSweepResult = {
  examined: number;
  stale: number;
  archived: number;
  pinnedSkipped: number;
  durationMs: number;
  overlaps: SkillOverlapCandidate[];
};

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

type CuratorOptions = OpenClawStateDatabaseOptions & {
  nowMs?: number;
};

function curatorDb(options: OpenClawStateDatabaseOptions = {}) {
  const database = openOpenClawStateDatabase(options);
  return {
    database,
    kysely: getNodeSqliteKysely<CuratorDatabase>(database.db),
  };
}

function canonicalSkillKey(name: string): string {
  const key = normalizeSkillIndexName(name);
  if (!key) {
    throw new Error(`Invalid skill name: ${name}`);
  }
  return key;
}

function recordSkillUsage(
  event: Pick<DiagnosticSkillUsedEvent, "agentId" | "skillName" | "skillSource" | "ts"> & {
    skillFile?: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const rawSkillFile = event.skillFile?.trim();
  // Lifecycle identity is the canonical file. Name-only usage would refresh unrelated
  // same-named skills, so events without an absolute file identity are not persisted.
  if (!rawSkillFile || !path.isAbsolute(rawSkillFile)) {
    log.debug(`skipping skill usage without file identity: ${event.skillName}`);
    return;
  }
  const skillFile = canonicalizePath(path.resolve(rawSkillFile));
  const skillKey = canonicalSkillKey(event.skillName);
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("skill_usage")
        .values({
          skill_file: skillFile,
          skill_key: skillKey,
          skill_name: event.skillName,
          skill_source: event.skillSource,
          first_used_at_ms: event.ts,
          last_used_at_ms: event.ts,
          use_count: 1,
          last_agent_id: event.agentId ?? null,
        })
        .onConflict((conflict) =>
          conflict.column("skill_file").doUpdateSet((eb) => ({
            skill_key: skillKey,
            skill_name: event.skillName,
            skill_source: event.skillSource,
            first_used_at_ms: eb.fn<number>("min", [eb.ref("first_used_at_ms"), eb.val(event.ts)]),
            last_used_at_ms: eb.fn<number>("max", [eb.ref("last_used_at_ms"), eb.val(event.ts)]),
            use_count: eb("use_count", "+", 1),
            last_agent_id: eb
              .case()
              .when("last_used_at_ms", "<=", event.ts)
              .then(event.agentId ?? null)
              .else(eb.ref("last_agent_id"))
              .end(),
          })),
        ),
    );
  }, options);
}

/** Register once per Gateway lifetime; listener failures never reach tool execution. */
function registerSkillUsageTracking(options: OpenClawStateDatabaseOptions = {}): () => void {
  return onTrustedInternalDiagnosticEvent((event, metadata, privateData) => {
    if (!metadata.trusted || event.type !== "skill.used") {
      return;
    }
    try {
      recordSkillUsage(
        {
          ...event,
          skillFile: privateData.skillUsage?.skillFile,
        },
        options,
      );
    } catch (error) {
      log.warn(`failed to record skill usage: ${String(error)}`);
    }
  });
}

export function startSkillCuratorMaintenance(options: {
  onError: (error: unknown) => void;
  registerUsageTracking?: () => () => void;
  runSweep?: () => Promise<unknown>;
}): () => void {
  const unregisterUsageTracking = (options.registerUsageTracking ?? registerSkillUsageTracking)();
  const sweep = options.runSweep ?? runSkillCuratorSweep;
  let sweepInFlight: Promise<void> | null = null;
  const performSweep = () => {
    if (sweepInFlight) {
      return sweepInFlight;
    }
    sweepInFlight = sweep()
      .then(() => undefined)
      .catch(options.onError)
      .finally(() => {
        sweepInFlight = null;
      });
    return sweepInFlight;
  };
  const initialSweep = setTimeout(() => void performSweep(), CURATOR_INITIAL_DELAY_MS);
  const sweepInterval = setInterval(() => void performSweep(), CURATOR_SWEEP_INTERVAL_MS);
  return () => {
    clearTimeout(initialSweep);
    clearInterval(sweepInterval);
    unregisterUsageTracking();
  };
}

async function loadCuratedSkills(
  options: OpenClawStateDatabaseOptions = {},
): Promise<CuratedSkill[]> {
  const manifest = await readSkillProposalManifest({ env: options.env });
  const byFile = new Map<string, CuratedSkill>();
  const appliedRecords: Array<{ appliedAtMs: number; record: SkillProposalRecord }> = [];
  for (const entry of manifest.proposals.toSorted((a, b) => a.id.localeCompare(b.id))) {
    if (entry.status !== "applied") {
      continue;
    }
    const record = await readSkillProposalRecord(entry.id, { env: options.env });
    if (!record || record.status !== "applied" || !record.appliedAt) {
      continue;
    }
    const appliedAtMs = Date.parse(record.appliedAt);
    if (!Number.isFinite(appliedAtMs)) {
      continue;
    }
    appliedRecords.push({ appliedAtMs, record });
    if (record.kind !== "create" || record.createdBy !== "skill-workshop") {
      continue;
    }
    const skillKey = canonicalSkillKey(record.target.skillKey || record.target.skillName);
    const skillFile = canonicalizePath(record.target.skillFile);
    const existing = byFile.get(skillFile);
    if (existing && existing.lastAppliedAtMs > appliedAtMs) {
      existing.createdAtMs = Math.min(existing.createdAtMs, appliedAtMs);
      continue;
    }
    byFile.set(skillFile, {
      createdAtMs: Math.min(existing?.createdAtMs ?? appliedAtMs, appliedAtMs),
      description: record.description,
      lastAppliedAtMs: appliedAtMs,
      skillFile,
      skillKey,
      skillName: record.target.skillName,
    });
  }
  for (const { appliedAtMs, record } of appliedRecords) {
    if (record.kind !== "update") {
      continue;
    }
    const skillFile = canonicalizePath(record.target.skillFile);
    const curated = byFile.get(skillFile);
    if (!curated) {
      continue;
    }
    if (appliedAtMs >= curated.lastAppliedAtMs) {
      curated.lastAppliedAtMs = appliedAtMs;
      curated.description = record.description;
    }
  }
  return [...byFile.values()].toSorted((a, b) => a.skillFile.localeCompare(b.skillFile));
}

function overlapTokens(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/u)
      .filter((token) => token.length > 2),
  );
}

function tokenJaccard(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((token) => right.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function detectOverlapCandidates(skills: readonly CuratedSkill[]): SkillOverlapCandidate[] {
  const candidates: SkillOverlapCandidate[] = [];
  for (let leftIndex = 0; leftIndex < skills.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < skills.length; rightIndex += 1) {
      const left = skills[leftIndex];
      const right = skills[rightIndex];
      if (!left || !right) {
        continue;
      }
      const leftWorkspace = path.dirname(path.dirname(path.dirname(left.skillFile)));
      const rightWorkspace = path.dirname(path.dirname(path.dirname(right.skillFile)));
      if (leftWorkspace !== rightWorkspace) {
        continue;
      }
      const nameScore = tokenJaccard(overlapTokens(left.skillName), overlapTokens(right.skillName));
      const descriptionScore = tokenJaccard(
        overlapTokens(left.description),
        overlapTokens(right.description),
      );
      const score = Math.max(nameScore, descriptionScore);
      if (score >= 0.5) {
        candidates.push({ left: left.skillKey, right: right.skillKey, score });
      }
    }
  }
  return candidates;
}

function desiredLifecycleState(ageMs: number): SkillLifecycleState {
  if (ageMs > ARCHIVE_AFTER_MS) {
    return "archived";
  }
  if (ageMs > STALE_AFTER_MS) {
    return "stale";
  }
  return "active";
}

function writeSweepAttempt(nowMs: number, options: OpenClawStateDatabaseOptions): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("skill_curator_state")
        .values({
          id: CURATOR_STATE_ID,
          last_attempt_at_ms: nowMs,
          last_success_at_ms: null,
          last_error: null,
          last_result_json: EMPTY_RESULT_JSON,
        })
        .onConflict((conflict) => conflict.column("id").doUpdateSet({ last_attempt_at_ms: nowMs })),
    );
  }, options);
}

function writeSweepFailure(
  nowMs: number,
  error: unknown,
  options: OpenClawStateDatabaseOptions,
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("skill_curator_state")
        .values({
          id: CURATOR_STATE_ID,
          last_attempt_at_ms: nowMs,
          last_success_at_ms: null,
          last_error: String(error),
          last_result_json: EMPTY_RESULT_JSON,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            last_attempt_at_ms: nowMs,
            last_error: String(error),
          }),
        ),
    );
  }, options);
}

async function runSkillCuratorSweep(
  options: CuratorOptions = {},
): Promise<SkillCuratorSweepResult> {
  const nowMs = options.nowMs ?? Date.now();
  const startedAtMs = Date.now();
  writeSweepAttempt(nowMs, options);
  try {
    const curated = await loadCuratedSkills(options);
    const existingCurated: CuratedSkill[] = [];
    const result = runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
      const lifecycleQuery = kysely.selectFrom("skill_lifecycle").selectAll();
      const lifecycleRows = executeSqliteQuerySync(db, lifecycleQuery).rows;
      const usageQuery = kysely.selectFrom("skill_usage").select(["skill_file", "last_used_at_ms"]);
      const usageRows = executeSqliteQuerySync(db, usageQuery).rows;
      const lifecycleByFile = new Map(lifecycleRows.map((row) => [row.skill_file, row]));
      const usageByFile = new Map(usageRows.map((row) => [row.skill_file, row.last_used_at_ms]));
      let stale = 0;
      let archived = 0;
      let pinnedSkipped = 0;

      for (const skill of curated) {
        const existing = lifecycleByFile.get(skill.skillFile);
        if (!fs.existsSync(skill.skillFile)) {
          // Lifecycle and usage share file identity; remove both atomically to avoid orphan rows.
          for (const table of ["skill_lifecycle", "skill_usage"] as const) {
            executeSqliteQuerySync(
              db,
              kysely.deleteFrom(table).where("skill_file", "=", skill.skillFile),
            );
          }
          continue;
        }
        existingCurated.push(skill);
        if (existing?.pinned === 1) {
          pinnedSkipped += 1;
          continue;
        }
        const createdAtMs = existing?.created_at_ms ?? skill.createdAtMs;
        const lastActivityMs = Math.max(
          usageByFile.get(skill.skillFile) ?? 0,
          skill.lastAppliedAtMs,
          createdAtMs,
        );
        const desired =
          existing?.state === "archived"
            ? "archived"
            : desiredLifecycleState(nowMs - lastActivityMs);
        if (desired === "stale" && existing?.state !== "stale") {
          stale += 1;
        }
        if (desired === "archived" && existing?.state !== "archived") {
          archived += 1;
        }
        const stateChangedAtMs = existing?.state === desired ? existing.state_changed_at_ms : nowMs;
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("skill_lifecycle")
            .values({
              skill_key: skill.skillKey,
              skill_name: skill.skillName,
              skill_file: skill.skillFile,
              state: desired,
              pinned: 0,
              state_changed_at_ms: stateChangedAtMs,
              created_at_ms: createdAtMs,
              archived_reason: desired === "archived" ? "unused for 90 days" : null,
            })
            .onConflict((conflict) =>
              conflict.column("skill_file").doUpdateSet({
                skill_key: skill.skillKey,
                skill_name: skill.skillName,
                state: desired,
                state_changed_at_ms: stateChangedAtMs,
                archived_reason: desired === "archived" ? "unused for 90 days" : null,
              }),
            ),
        );
      }

      return { stale, archived, pinnedSkipped };
    }, options);
    const sweepResult: SkillCuratorSweepResult = {
      examined: curated.length,
      ...result,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      overlaps: detectOverlapCandidates(existingCurated),
    };
    runOpenClawStateWriteTransaction(({ db }) => {
      const kysely = getNodeSqliteKysely<CuratorDatabase>(db);
      executeSqliteQuerySync(
        db,
        kysely
          .updateTable("skill_curator_state")
          .set({
            last_success_at_ms: nowMs,
            last_error: null,
            last_result_json: JSON.stringify(sweepResult),
          })
          .where("id", "=", CURATOR_STATE_ID),
      );
    }, options);
    return sweepResult;
  } catch (error) {
    writeSweepFailure(nowMs, error, options);
    throw error;
  }
}

function parseOverlapCandidates(value: string | null | undefined): SkillOverlapCandidate[] {
  if (!value) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as { overlaps?: unknown };
    return Array.isArray(parsed.overlaps)
      ? parsed.overlaps.filter((entry): entry is SkillOverlapCandidate =>
          Boolean(
            entry &&
            typeof entry === "object" &&
            typeof (entry as SkillOverlapCandidate).left === "string" &&
            typeof (entry as SkillOverlapCandidate).right === "string" &&
            typeof (entry as SkillOverlapCandidate).score === "number",
          ),
        )
      : [];
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
    const lifecycleState = row.state as SkillLifecycleState;
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
        .set({
          state: "active",
          state_changed_at_ms: nowMs,
          archived_reason: null,
        })
        .where("skill_key", "=", skillKey)
        .where("state", "=", "archived"),
    ).numAffectedRows;
    return changed === 0n ? null : first.skill_file;
  }, options);
  if (!firstSkillFile) {
    throw new Error(`Archived curated skill not found: ${skill}`);
  }
  // Archive and restore are snapshot-bound transitions: running sessions retain
  // their current skill snapshot until a new session or agent run builds one.
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
    // Skill loading fails open: temporarily showing archived skills is safer than
    // breaking prompt/snapshot builds. Curator commands and sweeps remain strict.
    if (!loggedArchivedSkillReadFailure) {
      loggedArchivedSkillReadFailure = true;
      log.warn("failed to read archived skill state; loading without lifecycle filtering", {
        error: String(error),
      });
    }
    return new Set();
  }
}

export function getSkillCuratorDoctorWarning(options: CuratorOptions = {}): string | null {
  const status = getSkillCuratorStatus(options);
  if (status.lastAttemptAtMs === null) {
    return null;
  }
  const nowMs = options.nowMs ?? Date.now();
  const successTooOld =
    status.lastSuccessAtMs === null
      ? nowMs - status.lastAttemptAtMs > DOCTOR_WEDGED_AFTER_MS
      : status.lastAttemptAtMs - status.lastSuccessAtMs > DOCTOR_WEDGED_AFTER_MS &&
        nowMs - status.lastSuccessAtMs > DOCTOR_WEDGED_AFTER_MS;
  if (!status.lastError && !successTooOld) {
    return null;
  }
  const since = status.lastSuccessAtMs
    ? new Date(status.lastSuccessAtMs).toISOString()
    : "its first attempt";
  return `skill curator has not completed a sweep since ${since} — check gateway logs`;
}
