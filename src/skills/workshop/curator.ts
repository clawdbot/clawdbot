import fs from "node:fs";
import path from "node:path";
import { canonicalizePath } from "../../agents/utils/paths.js";
import {
  onTrustedInternalDiagnosticEvent,
  type DiagnosticSkillUsedEvent,
} from "../../infra/diagnostic-events.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readConfigMachineState } from "../../state/config-machine-state.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  readSkillReviewOutcomes,
  type SkillCollectionReviewStatus,
  type SkillExperienceReviewStatus,
} from "./collection-review-state.js";
import { parseSkillProposalRow } from "./store-sqlite-record.js";

const log = createSubsystemLogger("skills/curator");

export const SKILL_LIFECYCLE_CURATION_RETIRED_MESSAGE =
  "Skill lifecycle curation is retired. The weekly collection review manages the skill collection; pin, unpin, and restore no longer exist.";

type SkillLifecycleState = "active" | "archived" | "stale";
type CuratorDatabase = Pick<OpenClawStateDatabase, "skill_usage" | "skill_workshop_proposals">;
type SkillOverlapCandidate = { left: string; right: string; score: number };

export type SkillCuratorStatus = {
  lastAttemptAtMs: number | null;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  collectionReview: Record<string, SkillCollectionReviewStatus>;
  experienceReview: Record<string, SkillExperienceReviewStatus>;
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

export type SkillUsageFacts = { lastUsedAtMs: number; useCount: number };

/** Single reader for recorded usage; callers pass canonical skill files. */
export function readSkillUsageByFile(
  skillFiles: readonly string[],
  options: OpenClawStateDatabaseOptions = {},
): Map<string, SkillUsageFacts> {
  if (skillFiles.length === 0) {
    return new Map();
  }
  const { database, kysely } = curatorDb(options);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_usage")
      .select(["skill_file", "last_used_at_ms", "use_count"])
      .where("skill_file", "in", [...skillFiles]),
  ).rows;
  return new Map(
    rows.map((row) => [
      row.skill_file,
      { lastUsedAtMs: row.last_used_at_ms, useCount: row.use_count },
    ]),
  );
}

export function getSkillCuratorStatus(
  options: OpenClawStateDatabaseOptions = {},
): SkillCuratorStatus {
  const { database, kysely } = curatorDb(options);
  const state = readConfigMachineState<{
    lastAttemptAtMs: number;
    lastSuccessAtMs: number | null;
    lastError: string | null;
    lastResult: Record<string, unknown>;
  }>("skills.curatorState", options);
  const reviewOutcomes = readSkillReviewOutcomes(options);
  const proposalRows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_workshop_proposals")
      .selectAll()
      .where("kind", "=", "create")
      .where("status", "=", "applied")
      .orderBy("applied_at", "asc")
      .orderBy("proposal_id", "asc"),
  ).rows;
  const curatedByFile = new Map<
    string,
    { skillFile: string; skillKey: string; skillName: string; createdAtMs: number }
  >();
  for (const row of proposalRows) {
    const record = parseSkillProposalRow(row);
    if (!record || record.createdBy !== "skill-workshop" || !record.appliedAt) {
      continue;
    }
    const appliedAtMs = Date.parse(record.appliedAt);
    const skillFile = canonicalizePath(record.target.skillFile);
    if (!Number.isFinite(appliedAtMs) || !fs.existsSync(skillFile)) {
      continue;
    }
    const existing = curatedByFile.get(skillFile);
    if (existing) {
      existing.createdAtMs = Math.min(existing.createdAtMs, appliedAtMs);
      continue;
    }
    curatedByFile.set(skillFile, {
      skillFile,
      skillKey: canonicalSkillKey(record.target.skillKey || record.target.skillName),
      skillName: record.target.skillName,
      createdAtMs: appliedAtMs,
    });
  }
  const curatedSkills = [...curatedByFile.values()].toSorted((left, right) =>
    left.skillFile.localeCompare(right.skillFile),
  );
  const usageByFile = readSkillUsageByFile(
    curatedSkills.map((skill) => skill.skillFile),
    options,
  );
  const skills: SkillCuratorStatus["skills"] = curatedSkills.map((skill) => {
    const usage = usageByFile.get(skill.skillFile);
    return {
      skillFile: skill.skillFile,
      skillKey: skill.skillKey,
      skillName: skill.skillName,
      createdAtMs: skill.createdAtMs,
      state: "active",
      pinned: false,
      stateChangedAtMs: skill.createdAtMs,
      lastUsedAtMs: usage?.lastUsedAtMs ?? null,
      useCount: usage?.useCount ?? 0,
      archivedReason: null,
    };
  });
  return {
    lastAttemptAtMs: state?.lastAttemptAtMs ?? null,
    lastSuccessAtMs: state?.lastSuccessAtMs ?? null,
    lastError: state?.lastError ?? null,
    collectionReview: reviewOutcomes.collectionReviews,
    experienceReview: reviewOutcomes.experienceReviews,
    counts: { active: skills.length, stale: 0, archived: 0 },
    skills,
    overlaps: [],
  };
}

function recordSkillUsage(
  event: Pick<DiagnosticSkillUsedEvent, "agentId" | "skillName" | "skillSource" | "ts"> & {
    skillFile?: string;
  },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const rawSkillFile = event.skillFile?.trim();
  // File identity prevents a same-named skill in another workspace from inheriting usage.
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

/** Listener failures must never propagate into the tool execution that emitted usage. */
export function registerSkillUsageTracking(options: OpenClawStateDatabaseOptions = {}): () => void {
  return onTrustedInternalDiagnosticEvent(
    (event, metadata, privateData) => {
      if (!metadata.trusted || event.type !== "skill.used") {
        return;
      }
      try {
        recordSkillUsage({ ...event, skillFile: privateData.skillUsage?.skillFile }, options);
      } catch (error) {
        log.warn(`failed to record skill usage: ${String(error)}`);
      }
    },
    { include: ["skill.used"] },
  );
}

export function clearSkillUsageForRemovedSkills(
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
      kysely.deleteFrom("skill_usage").where(
        "skill_file",
        "in",
        skillFiles.map((skillFile) => canonicalizePath(skillFile)),
      ),
    );
  }, options);
}
