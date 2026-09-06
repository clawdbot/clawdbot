import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  readConfigMachineState,
  updateConfigMachineState,
} from "../../state/config-machine-state.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  openSkillWorkshopStore,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";

const SKILL_COLLECTION_REVIEW_HISTORY_LIMIT = 20;
type CollectionReviewDatabase = Pick<OpenClawStateDatabase, "skill_workshop_collection_reviews">;
type SkillCuratorState = {
  lastAttemptAtMs: number;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  lastResult: {
    collectionReviews?: Record<string, SkillCollectionReviewStatus>;
    experienceReviews?: Record<string, SkillExperienceReviewStatus>;
  };
};

type SkillCollectionReviewOutcome = SkillCollectionReviewResult & { createTime: number };

type SkillCollectionReviewResult = {
  backupId: string;
  kept: string[];
  written: string[];
  dropped: Array<{ name: string; reason: string }>;
};

export type SkillCollectionReviewStatus = {
  attemptedAtMs: number;
  succeededAtMs?: number;
  error?: string;
};

export type SkillExperienceReviewStatus = {
  attemptedAtMs: number;
  outcome: "applied" | "proposed" | "nothing" | "failed";
  proposalId?: string;
  error?: string;
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number };
};

function experienceReviewKey(agentId: string, workspaceDir: string): string {
  return sha256Hex(`${agentId}\0${path.resolve(workspaceDir)}`);
}

export function readSkillReviewOutcomes(options: OpenClawStateDatabaseOptions = {}) {
  const state = readConfigMachineState<SkillCuratorState>("skills.curatorState", options);
  return {
    collectionReviews: state?.lastResult.collectionReviews ?? {},
    experienceReviews: state?.lastResult.experienceReviews ?? {},
  };
}

export function recordSkillExperienceReviewOutcome(
  agentId: string,
  workspaceDir: string,
  review: SkillExperienceReviewStatus,
  options: OpenClawStateDatabaseOptions = {},
): void {
  const entryKey = experienceReviewKey(agentId, workspaceDir);
  updateConfigMachineState<SkillCuratorState>(
    "skills.curatorState",
    (current) => {
      const state = current?.lastResult;
      return {
        lastAttemptAtMs: 0,
        lastSuccessAtMs: null,
        lastError: null,
        ...current,
        lastResult: {
          ...state,
          experienceReviews: {
            ...state?.experienceReviews,
            [entryKey]: review,
          },
        },
      };
    },
    options,
  );
}

function parseStoredNames(value: string, field: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (
    !Array.isArray(parsed) ||
    !parsed.every((entry): entry is string => typeof entry === "string")
  ) {
    throw new Error(`Invalid ${field} in stored skill collection review.`);
  }
  return parsed;
}

function parseStoredDrops(value: string): SkillCollectionReviewResult["dropped"] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) {
    throw new Error("Invalid dropped entries in stored skill collection review.");
  }
  return parsed.map((entry) => {
    const record = asNullableRecord(entry);
    if (!record || typeof record.name !== "string" || typeof record.reason !== "string") {
      throw new Error("Invalid dropped entry in stored skill collection review.");
    }
    return { name: record.name, reason: record.reason };
  });
}

export function readSkillCollectionBackupDrops(
  agentId: string,
  backupId: string,
  options: SkillWorkshopStoreOptions = {},
): Set<string> {
  const { database, kysely } = openSkillWorkshopStore(options);
  const rows = executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_workshop_collection_reviews")
      .select("dropped_json")
      .where("owner_agent_id", "=", agentId)
      .where("backup_id", "=", backupId),
  ).rows;
  return new Set(
    rows.flatMap((row) => parseStoredDrops(row.dropped_json).map((drop) => drop.name)),
  );
}

export function listSkillCollectionReviewOutcomes(
  agentId: string,
  options: SkillWorkshopStoreOptions = {},
): SkillCollectionReviewOutcome[] {
  ensureSkillWorkshopSchema(options);
  const database = openOpenClawStateDatabase(databaseOptions(options));
  const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    kysely
      .selectFrom("skill_workshop_collection_reviews")
      .select(["backup_id", "create_time", "kept_names_json", "written_names_json", "dropped_json"])
      .where("owner_agent_id", "=", agentId)
      .orderBy("create_time", "desc")
      .orderBy("review_id", "desc")
      .limit(SKILL_COLLECTION_REVIEW_HISTORY_LIMIT),
  ).rows.map((row) => ({
    createTime: row.create_time,
    backupId: row.backup_id,
    kept: parseStoredNames(row.kept_names_json, "kept names"),
    written: parseStoredNames(row.written_names_json, "written names"),
    dropped: parseStoredDrops(row.dropped_json),
  }));
}
