import { randomUUID } from "node:crypto";
import path from "node:path";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../../infra/kysely-sync.js";
import {
  readConfigMachineState,
  updateConfigMachineState,
} from "../../state/config-machine-state.js";
import type { DB as OpenClawStateDatabase } from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../../state/openclaw-state-db.js";
import { withOpenClawStateLease } from "../../state/openclaw-state-lease.js";
import type { SkillCollectionReconcileResult } from "./collection-contracts.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";

const REVIEW_CLAIM_MS = 11 * 60_000;
// Bound history so unattended weekly maintenance cannot grow state forever.
const SKILL_COLLECTION_REVIEW_RETENTION_COUNT = 90;
const SKILL_COLLECTION_REVIEW_HISTORY_LIMIT = 20;
type CollectionReviewDatabase = Pick<OpenClawStateDatabase, "skill_workshop_collection_reviews">;
type SkillCuratorState = {
  lastAttemptAtMs: number;
  lastSuccessAtMs: number | null;
  lastError: string | null;
  lastResult: Record<string, unknown>;
};

type SkillCollectionReviewOutcome = {
  createTime: number;
  backupId: string;
  kept: string[];
  written: string[];
  dropped: SkillCollectionReconcileResult["dropped"];
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

export async function withSkillCollectionReviewClaim<T>(
  agentId: string,
  run: () => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: "skill-collection-review",
      key: agentId,
      database: { scope: "shared", options },
      leaseMs: REVIEW_CLAIM_MS,
      waitMs: 0,
      leaseLabel: "skill collection review claim",
      operationLabel: "skill-collection.review",
    },
    async () => await run(),
  );
}

function reviewMap<T>(state: Record<string, unknown>, field: string): Record<string, T> {
  // SAFETY: cache-class state is written only by recordWorkspaceReview below.
  return (asNullableRecord(state[field]) ?? {}) as Record<string, T>;
}

function readReviewState(options: OpenClawStateDatabaseOptions): Record<string, unknown> {
  return (
    asNullableRecord(
      readConfigMachineState<SkillCuratorState>("skills.curatorState", options)?.lastResult,
    ) ?? {}
  );
}

export function readSkillReviewOutcomes(options: OpenClawStateDatabaseOptions = {}) {
  const state = readReviewState(options);
  return {
    collectionReviews: reviewMap<SkillCollectionReviewStatus>(state, "collectionReviews"),
    experienceReviews: reviewMap<SkillExperienceReviewStatus>(state, "experienceReviews"),
  };
}

export function recordSkillCollectionReviewStatus(
  agentId: string,
  review: { attemptedAtMs: number; succeededAtMs?: number; error?: unknown },
  options: OpenClawStateDatabaseOptions = {},
): void {
  const status: SkillCollectionReviewStatus =
    review.error !== undefined
      ? {
          attemptedAtMs: review.attemptedAtMs,
          error: formatErrorMessage(review.error).slice(0, 300),
        }
      : {
          attemptedAtMs: review.attemptedAtMs,
          ...(review.succeededAtMs !== undefined ? { succeededAtMs: review.succeededAtMs } : {}),
        };
  recordReviewEntry("collectionReviews", agentId, status, {}, options);
}

export function recordSkillExperienceReviewOutcome(
  agentId: string,
  workspaceDir: string,
  review: SkillExperienceReviewStatus,
  options: OpenClawStateDatabaseOptions = {},
): void {
  recordReviewEntry(
    "experienceReviews",
    experienceReviewKey(agentId, workspaceDir),
    review,
    {},
    options,
  );
}

function recordReviewEntry(
  field: "collectionReviews" | "experienceReviews",
  entryKey: string,
  review: SkillCollectionReviewStatus | SkillExperienceReviewStatus,
  columns: Partial<Omit<SkillCuratorState, "lastResult">>,
  options: OpenClawStateDatabaseOptions,
): void {
  updateConfigMachineState<SkillCuratorState>(
    "skills.curatorState",
    (current) => {
      const state = asNullableRecord(current?.lastResult) ?? {};
      return {
        lastAttemptAtMs: 0,
        lastSuccessAtMs: null,
        lastError: null,
        ...current,
        ...columns,
        lastResult: {
          ...state,
          [field]: {
            ...asNullableRecord(state[field]),
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

function parseStoredDrops(value: string): SkillCollectionReconcileResult["dropped"] {
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

export function recordSkillCollectionReviewHistory(
  agentId: string,
  nowMs: number,
  result: SkillCollectionReconcileResult,
  options: SkillWorkshopStoreOptions = {},
): void {
  ensureSkillWorkshopSchema(options);
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(db);
    executeSqliteQuerySync(
      db,
      kysely.insertInto("skill_workshop_collection_reviews").values({
        review_id: randomUUID(),
        owner_agent_id: agentId,
        backup_id: result.backupId,
        create_time: nowMs,
        kept_names_json: JSON.stringify(result.kept),
        written_names_json: JSON.stringify(result.written),
        dropped_json: JSON.stringify(result.dropped),
      }),
    );
    const retainedReviewIds = kysely
      .selectFrom("skill_workshop_collection_reviews")
      .select("review_id")
      .where("owner_agent_id", "=", agentId)
      .orderBy("create_time", "desc")
      .orderBy("review_id", "desc")
      .limit(SKILL_COLLECTION_REVIEW_RETENTION_COUNT);
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("skill_workshop_collection_reviews")
        .where("owner_agent_id", "=", agentId)
        .where("review_id", "not in", retainedReviewIds),
    );
  }, databaseOptions(options));
}
