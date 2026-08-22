import { randomUUID } from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sha256Hex } from "../../infra/crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
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

const CURATOR_STATE_ID = 1;
const REVIEW_INTERVAL_MS = 24 * 60 * 60_000;
const REVIEW_FAILURE_RETRY_MS = 60 * 60_000;
const REVIEW_CLAIM_MS = 11 * 60_000;
// Bound per-workspace history so unattended daily maintenance cannot grow state forever.
const SKILL_COLLECTION_REVIEW_RETENTION_COUNT = 90;
const SKILL_COLLECTION_REVIEW_HISTORY_LIMIT = 20;
type CollectionReviewDatabase = Pick<
  OpenClawStateDatabase,
  "skill_curator_state" | "skill_workshop_collection_reviews"
>;

type SkillCollectionReviewOutcome = {
  createTime: number;
  backupId: string;
  kept: string[];
  written: string[];
  dropped: SkillCollectionReconcileResult["dropped"];
};

function workspaceKey(workspaceDir: string): string {
  return sha256Hex(path.resolve(workspaceDir));
}

export async function withSkillCollectionReviewClaim<T>(
  workspaceDir: string,
  run: () => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  return await withOpenClawStateLease(
    {
      scope: "skill-collection-review",
      key: workspaceKey(workspaceDir),
      database: { scope: "shared", options },
      leaseMs: REVIEW_CLAIM_MS,
      waitMs: 0,
      leaseLabel: "skill collection review claim",
      operationLabel: "skill-collection.review",
    },
    async () => await run(),
  );
}

function parseReviewState(value: string | null | undefined): Record<string, unknown> {
  if (!value) {
    return {};
  }
  try {
    return asNullableRecord(JSON.parse(value)) ?? {};
  } catch {
    return {};
  }
}

function parseReviewTimes(
  state: Record<string, unknown>,
  field: "collectionReviewAttempts" | "collectionReviewSuccess",
): Record<string, number> {
  const record = asNullableRecord(state[field]);
  return record
    ? Object.fromEntries(
        Object.entries(record).filter(
          (entry): entry is [string, number] =>
            typeof entry[1] === "number" && Number.isFinite(entry[1]),
        ),
      )
    : {};
}

function recordCollectionReviewState(
  db: DatabaseSync,
  workspaceDir: string,
  nowMs: number,
  lastError: string | null,
) {
  const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(db);
  const current = executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("skill_curator_state")
      .select("last_result_json")
      .where("id", "=", CURATOR_STATE_ID),
  );
  const reviewState = parseReviewState(current?.last_result_json);
  const key = workspaceKey(workspaceDir);
  const lastResultJson = JSON.stringify({
    ...reviewState,
    collectionReviewAttempts: {
      ...parseReviewTimes(reviewState, "collectionReviewAttempts"),
      [key]: nowMs,
    },
    ...(lastError === null
      ? {
          collectionReviewSuccess: {
            ...parseReviewTimes(reviewState, "collectionReviewSuccess"),
            [key]: nowMs,
          },
        }
      : {}),
  });
  const updatedState = {
    last_attempt_at_ms: nowMs,
    last_error: lastError,
    last_result_json: lastResultJson,
    ...(lastError === null ? { last_success_at_ms: nowMs } : {}),
  };
  executeSqliteQuerySync(
    db,
    kysely
      .insertInto("skill_curator_state")
      .values({ id: CURATOR_STATE_ID, last_success_at_ms: null, ...updatedState })
      .onConflict((conflict) => conflict.column("id").doUpdateSet(updatedState)),
  );
  return kysely;
}

export function isSkillCollectionReviewDue(
  workspaceDir: string,
  nowMs: number,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const database = openOpenClawStateDatabase(options);
  const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(database.db);
  const state = executeSqliteQueryTakeFirstSync(
    database.db,
    kysely
      .selectFrom("skill_curator_state")
      .select("last_result_json")
      .where("id", "=", CURATOR_STATE_ID),
  );
  const reviewState = parseReviewState(state?.last_result_json);
  const key = workspaceKey(workspaceDir);
  const lastSuccess = parseReviewTimes(reviewState, "collectionReviewSuccess")[key];
  if (lastSuccess !== undefined && nowMs - lastSuccess < REVIEW_INTERVAL_MS) {
    return false;
  }
  const lastAttempt = parseReviewTimes(reviewState, "collectionReviewAttempts")[key];
  return lastAttempt === undefined || nowMs - lastAttempt >= REVIEW_FAILURE_RETRY_MS;
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
  workspaceDir: string,
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
      .where("workspace_dir", "=", path.resolve(workspaceDir))
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

export function recordSkillCollectionReviewSuccess(
  workspaceDir: string,
  nowMs: number,
  result: SkillCollectionReconcileResult,
  options: SkillWorkshopStoreOptions = {},
): void {
  ensureSkillWorkshopSchema(options);
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = recordCollectionReviewState(db, workspaceDir, nowMs, null);
    const resolvedWorkspaceDir = path.resolve(workspaceDir);
    executeSqliteQuerySync(
      db,
      kysely.insertInto("skill_workshop_collection_reviews").values({
        review_id: randomUUID(),
        workspace_dir: resolvedWorkspaceDir,
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
      .where("workspace_dir", "=", resolvedWorkspaceDir)
      .orderBy("create_time", "desc")
      .orderBy("review_id", "desc")
      .limit(SKILL_COLLECTION_REVIEW_RETENTION_COUNT);
    executeSqliteQuerySync(
      db,
      kysely
        .deleteFrom("skill_workshop_collection_reviews")
        .where("workspace_dir", "=", resolvedWorkspaceDir)
        .where("review_id", "not in", retainedReviewIds),
    );
  }, databaseOptions(options));
}

export function recordSkillCollectionReviewFailure(
  workspaceDir: string,
  nowMs: number,
  error: unknown,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    recordCollectionReviewState(db, workspaceDir, nowMs, String(error).slice(0, 2_000));
  }, options);
}
