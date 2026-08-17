import path from "node:path";
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

const CURATOR_STATE_ID = 1;
const REVIEW_INTERVAL_MS = 24 * 60 * 60_000;
const REVIEW_CLAIM_MS = 11 * 60_000;
type CollectionReviewDatabase = Pick<OpenClawStateDatabase, "skill_curator_state">;

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

function parseReviewTimes(value: string | null | undefined): Record<string, number> {
  if (!value) {
    return {};
  }
  try {
    const reviews = asNullableRecord(JSON.parse(value))?.collectionReviewSuccess;
    const record = asNullableRecord(reviews);
    if (!record) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(record).filter(
        (entry): entry is [string, number] =>
          typeof entry[1] === "number" && Number.isFinite(entry[1]),
      ),
    );
  } catch {
    return {};
  }
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
  const lastSuccess = parseReviewTimes(state?.last_result_json)[workspaceKey(workspaceDir)];
  return lastSuccess === undefined || nowMs - lastSuccess >= REVIEW_INTERVAL_MS;
}

export function recordSkillCollectionReviewSuccess(
  workspaceDir: string,
  nowMs: number,
  options: OpenClawStateDatabaseOptions = {},
): void {
  runOpenClawStateWriteTransaction(({ db }) => {
    const kysely = getNodeSqliteKysely<CollectionReviewDatabase>(db);
    const current = executeSqliteQueryTakeFirstSync(
      db,
      kysely
        .selectFrom("skill_curator_state")
        .select("last_result_json")
        .where("id", "=", CURATOR_STATE_ID),
    );
    const reviews = parseReviewTimes(current?.last_result_json);
    reviews[workspaceKey(workspaceDir)] = nowMs;
    const lastResultJson = JSON.stringify({ collectionReviewSuccess: reviews });
    executeSqliteQuerySync(
      db,
      kysely
        .insertInto("skill_curator_state")
        .values({
          id: CURATOR_STATE_ID,
          last_attempt_at_ms: nowMs,
          last_success_at_ms: nowMs,
          last_error: null,
          last_result_json: lastResultJson,
        })
        .onConflict((conflict) =>
          conflict.column("id").doUpdateSet({
            last_attempt_at_ms: nowMs,
            last_success_at_ms: nowMs,
            last_error: null,
            last_result_json: lastResultJson,
          }),
        ),
    );
  }, options);
}
