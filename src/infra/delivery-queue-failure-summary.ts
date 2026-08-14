// Metadata-only delivery failure aggregation for health and doctor output.
import { sql } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { safeDeliveryQueueEntryJsonExtract } from "./delivery-queue-failures.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "./kysely-sync.js";

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

type DeliveryFailureQueueSummary = {
  queueName: string;
  count: number;
  oldestFailedAt: number | null;
  full: number;
  compacted: number;
  safe: number;
  ambiguous: number;
  ownerManaged: number;
  ownerCleanupPending: number;
  fenceNone: number;
  fencePermanent: number;
  fenceProducerBounded: number;
  legacyUnknown: number;
  payloadBearing: number;
  oldestPayloadFailedAt: number | null;
};

function countPolicyValue(field: string, value: string) {
  const policy = safeDeliveryQueueEntryJsonExtract(`$.terminalPolicy.${field}`);
  return /* kysely-allow-raw: SQLite JSON1 counts one bounded terminal-policy classification. */ sql<number>`SUM(CASE WHEN ${policy} = ${value} THEN 1 ELSE 0 END)`;
}

function countLegacyPolicies() {
  const version = safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.version");
  return /* kysely-allow-raw: SQLite IS NOT includes missing or malformed policy versions. */ sql<number>`SUM(CASE WHEN ${version} IS NOT ${1} THEN 1 ELSE 0 END)`;
}

function countOwnerCleanupPending() {
  const replay = safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.replay");
  const cleanup = safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.cleanup");
  return /* kysely-allow-raw: SQLite JSON1 counts only owner rows whose cleanup remains pending. */ sql<number>`SUM(CASE WHEN ${replay} = ${"owner-managed"} AND ${cleanup} IN (${"pending"}, ${"media_pending"}) THEN 1 ELSE 0 END)`;
}

function oldestPayloadFailure() {
  const payload = safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.payload");
  return /* kysely-allow-raw: SQLite JSON1 bounds the oldest timestamp to payload-bearing failures. */ sql<
    number | null
  >`MIN(CASE WHEN ${payload} = ${"present"} THEN failed_at END)`;
}

export function summarizeDeliveryFailureQueues(stateDir?: string): DeliveryFailureQueueSummary[] {
  const database = openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const rows = executeSqliteQuerySync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select([
        "queue_name",
        (eb) => eb.fn.countAll().as("failed_count"),
        (eb) => eb.fn.min("failed_at").as("oldest_failed_at"),
        countPolicyValue("detail", "full").as("full_count"),
        countPolicyValue("detail", "compacted").as("compacted_count"),
        countPolicyValue("replay", "safe").as("safe_count"),
        countPolicyValue("replay", "ambiguous").as("ambiguous_count"),
        countPolicyValue("replay", "owner-managed").as("owner_count"),
        countOwnerCleanupPending().as("owner_cleanup_pending_count"),
        countPolicyValue("fence.kind", "none").as("fence_none_count"),
        countPolicyValue("fence.kind", "permanent").as("fence_permanent_count"),
        countPolicyValue("fence.kind", "producer-bounded").as("fence_bounded_count"),
        countLegacyPolicies().as("legacy_count"),
        countPolicyValue("payload", "present").as("payload_count"),
        oldestPayloadFailure().as("oldest_payload_failed_at"),
      ])
      .where("status", "=", "failed")
      .groupBy("queue_name")
      .orderBy("queue_name", "asc"),
  ).rows as Array<Record<string, number | bigint | string | null>>;
  const count = (row: Record<string, number | bigint | string | null>, key: string) =>
    Number(row[key] ?? 0);
  return rows.map((row) => ({
    queueName: String(row.queue_name),
    count: count(row, "failed_count"),
    oldestFailedAt: row.oldest_failed_at == null ? null : Number(row.oldest_failed_at),
    full: count(row, "full_count"),
    compacted: count(row, "compacted_count"),
    safe: count(row, "safe_count"),
    ambiguous: count(row, "ambiguous_count"),
    ownerManaged: count(row, "owner_count"),
    ownerCleanupPending: count(row, "owner_cleanup_pending_count"),
    fenceNone: count(row, "fence_none_count"),
    fencePermanent: count(row, "fence_permanent_count"),
    fenceProducerBounded: count(row, "fence_bounded_count"),
    legacyUnknown: count(row, "legacy_count"),
    payloadBearing: count(row, "payload_count"),
    oldestPayloadFailedAt:
      row.oldest_payload_failed_at == null ? null : Number(row.oldest_payload_failed_at),
  }));
}
