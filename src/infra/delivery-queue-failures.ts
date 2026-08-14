// Failed delivery lifecycle: metadata inspection, retention, and compact tombstones.
import { sql } from "kysely";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import type {
  DeliveryQueueEntryState,
  DeliveryQueueTerminalPolicy,
} from "./delivery-queue-sqlite.types.js";
import {
  classifyLegacySessionTerminalPolicy,
  compactDeliveryTerminalEntry,
  DELIVERY_FAILURE_DETAIL_MAX_ENTRIES,
  DELIVERY_FAILURE_DETAIL_RETENTION_MS,
  FAILED_TERMINAL_RECOVERY_STATE,
  parseDeliveryQueueTerminalPolicy,
  parseTerminalPolicyFromEntryJson,
  unknownDeliveryTerminalPolicy,
} from "./delivery-queue-terminal-policy.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { runSqliteImmediateTransactionSync } from "./sqlite-transaction.js";

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

/** JSON1 projection that never evaluates json_extract against malformed legacy bytes. */
export function safeDeliveryQueueEntryJsonExtract(path: string) {
  return /* kysely-allow-raw: SQLite JSON1 projects bounded terminal-policy fields without inflating payloads. */ sql<
    string | number | null
  >`CASE
    WHEN json_valid(entry_json) THEN json_extract(entry_json, ${path})
    ELSE NULL
  END`;
}

export type DeliveryFailureRow = {
  queue_name: string;
  id: string;
  status: string;
  retry_count: number | bigint;
  recovery_state: string | null;
  entry_json: string;
  enqueued_at: number | bigint;
  updated_at: number | bigint;
  failed_at: number | bigint | null;
};

type DeliveryFailurePurgeAction = {
  kind: "compact" | "delete";
  row: DeliveryFailureRow;
  policy: DeliveryQueueTerminalPolicy;
};

type DeliveryFailurePurgeAppliedAction = {
  kind: DeliveryFailurePurgeAction["kind"];
  queueName: string;
  entryJson: string;
  stateDir?: string;
};

export type DeliveryFailureMetadata = {
  queueName: string;
  id: string;
  failedAt: number | null;
  retryCount: number;
  detail: DeliveryQueueTerminalPolicy["detail"];
  replay: DeliveryQueueTerminalPolicy["replay"];
  fence: DeliveryQueueTerminalPolicy["fence"];
  reason: DeliveryQueueTerminalPolicy["reason"];
  payloadBearing: boolean;
  legacyUnknown: boolean;
  owner?: DeliveryQueueTerminalPolicy["owner"];
};

export type DeliveryFailureMaintenanceResult = {
  scanned: number;
  compacted: number;
  deleted: number;
  legacyUnknown: number;
  errors: number;
};

export function openDeliveryFailureDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

function selectFailedRow(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
): DeliveryFailureRow | undefined {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  return executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select([
        "queue_name",
        "id",
        "status",
        "retry_count",
        "recovery_state",
        "entry_json",
        "enqueued_at",
        "updated_at",
        "failed_at",
      ])
      .where("queue_name", "=", queueName)
      .where("id", "=", id),
  ) as DeliveryFailureRow | undefined;
}

export function readDeliveryFailurePolicy(row: DeliveryFailureRow): {
  policy: DeliveryQueueTerminalPolicy;
  legacyUnknown: boolean;
  legacySessionEntry?: DeliveryQueueEntryState;
} {
  const parsed = parseTerminalPolicyFromEntryJson(row.entry_json);
  if (parsed.policy) {
    return parsed.policy.fence.kind === "producer-bounded" &&
      !row.id.startsWith(parsed.policy.fence.idPrefix)
      ? { policy: unknownDeliveryTerminalPolicy(), legacyUnknown: true }
      : { policy: parsed.policy, legacyUnknown: false };
  }
  if (row.queue_name === "session") {
    const legacy = classifyLegacySessionTerminalPolicy(
      parsed.entry,
      row.id,
      Number(row.failed_at ?? row.updated_at),
    );
    if (legacy.classified) {
      return {
        policy: legacy.policy,
        legacyUnknown: false,
        legacySessionEntry: legacy.entry,
      };
    }
  }
  return { policy: unknownDeliveryTerminalPolicy(), legacyUnknown: true };
}

function failureMetadata(row: DeliveryFailureRow): DeliveryFailureMetadata {
  const { policy, legacyUnknown } = readDeliveryFailurePolicy(row);
  return {
    queueName: row.queue_name,
    id: row.id,
    failedAt: row.failed_at == null ? null : Number(row.failed_at),
    retryCount: Number(row.retry_count),
    detail: policy.detail,
    replay: policy.replay,
    fence: policy.fence,
    reason: policy.reason,
    payloadBearing: policy.payload === "present",
    legacyUnknown,
    ...(policy.owner ? { owner: policy.owner } : {}),
  };
}

function failedRowMatches(left: DeliveryFailureRow, right: DeliveryFailureRow): boolean {
  return (
    left.status === "failed" &&
    right.status === "failed" &&
    left.entry_json === right.entry_json &&
    left.failed_at === right.failed_at &&
    left.retry_count === right.retry_count &&
    left.recovery_state === right.recovery_state
  );
}

export function compactFailedDeliveryQueueEntryInDatabase(params: {
  database: OpenClawStateDatabase;
  queueName: string;
  id: string;
  expected?: DeliveryFailureRow;
  policy?: DeliveryQueueTerminalPolicy;
  now?: number;
}): boolean {
  const current = selectFailedRow(params.database, params.queueName, params.id);
  if (
    !current ||
    current.status !== "failed" ||
    (params.expected && !failedRowMatches(current, params.expected))
  ) {
    return false;
  }
  const policy =
    parseDeliveryQueueTerminalPolicy(params.policy) ?? readDeliveryFailurePolicy(current).policy;
  const attemptCount = parseTerminalPolicyFromEntryJson(current.entry_json).entry?.attemptCount;
  const compact = compactDeliveryTerminalEntry({
    id: current.id,
    enqueuedAt: Number(current.enqueued_at),
    retryCount: Number(current.retry_count),
    ...(attemptCount === undefined ? {} : { attemptCount }),
    terminalPolicy: policy,
  });
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(params.database.db);
  let query = queueDb
    .updateTable("delivery_queue_entries")
    .set({
      session_key: null,
      channel: null,
      target: null,
      account_id: null,
      last_error: null,
      platform_send_started_at: null,
      recovery_state: FAILED_TERMINAL_RECOVERY_STATE,
      entry_json: JSON.stringify(compact),
      updated_at: params.now ?? Date.now(),
    })
    .where("queue_name", "=", current.queue_name)
    .where("id", "=", current.id)
    .where("status", "=", "failed")
    .where("entry_json", "=", current.entry_json)
    .where("retry_count", "=", Number(current.retry_count))
    .where("recovery_state", current.recovery_state == null ? "is" : "=", current.recovery_state);
  query =
    current.failed_at == null
      ? query.where("failed_at", "is", null)
      : query.where("failed_at", "=", Number(current.failed_at));
  return executeSqliteQuerySync(params.database.db, query).numAffectedRows === 1n;
}

/** Replaces one exact full failed row's terminal policy without changing its payload. */
export function updateFailedDeliveryQueueEntryPolicyInDatabase(params: {
  database: OpenClawStateDatabase;
  row: DeliveryFailureRow;
  entry: DeliveryQueueEntryState;
  policy: DeliveryQueueTerminalPolicy;
  now: number;
}): boolean {
  const current = selectFailedRow(params.database, params.row.queue_name, params.row.id);
  if (!current || !failedRowMatches(current, params.row)) {
    return false;
  }
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(params.database.db);
  let query = queueDb
    .updateTable("delivery_queue_entries")
    .set({
      entry_json: JSON.stringify({ ...params.entry, terminalPolicy: params.policy }),
      updated_at: params.now,
    })
    .where("queue_name", "=", current.queue_name)
    .where("id", "=", current.id)
    .where("status", "=", "failed")
    .where("entry_json", "=", current.entry_json)
    .where("retry_count", "=", Number(current.retry_count))
    .where("recovery_state", current.recovery_state == null ? "is" : "=", current.recovery_state);
  query =
    current.failed_at == null
      ? query.where("failed_at", "is", null)
      : query.where("failed_at", "=", Number(current.failed_at));
  return executeSqliteQuerySync(params.database.db, query).numAffectedRows === 1n;
}

/** Compact one exact failed row only while its authoritative terminal state is unchanged. */
export function compactFailedDeliveryQueueEntry(params: {
  queueName: string;
  id: string;
  stateDir?: string;
  policy?: DeliveryQueueTerminalPolicy;
}): boolean {
  const database = openDeliveryFailureDatabase(params.stateDir);
  return runSqliteImmediateTransactionSync(
    database.db,
    () =>
      compactFailedDeliveryQueueEntryInDatabase({
        database,
        queueName: params.queueName,
        id: params.id,
        ...(params.policy ? { policy: params.policy } : {}),
      }),
    {
      databaseLabel: "openclaw-state",
      operationLabel: "compact failed delivery queue entry",
    },
  );
}

export function deleteDeliveryFailureRow(
  database: OpenClawStateDatabase,
  row: DeliveryFailureRow,
): boolean {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  let query = queueDb
    .deleteFrom("delivery_queue_entries")
    .where("queue_name", "=", row.queue_name)
    .where("id", "=", row.id)
    .where("status", "=", "failed")
    .where("entry_json", "=", row.entry_json)
    .where("retry_count", "=", Number(row.retry_count));
  query =
    row.failed_at == null
      ? query.where("failed_at", "is", null)
      : query.where("failed_at", "=", Number(row.failed_at));
  return executeSqliteQuerySync(database.db, query).numAffectedRows === 1n;
}

export function loadDeliveryFailureFullDetailCutoff(
  database: OpenClawStateDatabase,
  queueName: string,
): { failedAt: number; id: string } | undefined {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const cutoff = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select(["failed_at", "id"])
      .where("queue_name", "=", queueName)
      .where("status", "=", "failed")
      .where(
        /* kysely-allow-raw: SQLite JSON1 selects canonical terminal-policy fields without inflating payloads. */
        sql<boolean>`${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.version")} = 1
          AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.detail")} = 'full'
          AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.replay")} = 'safe'`,
      )
      .orderBy("failed_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .offset(DELIVERY_FAILURE_DETAIL_MAX_ENTRIES - 1),
  ) as { failed_at: number | bigint | null; id: string } | undefined;
  return cutoff?.failed_at == null
    ? undefined
    : { failedAt: Number(cutoff.failed_at), id: cutoff.id };
}

function isBeyondFullDetailCount(
  row: DeliveryFailureRow,
  cutoff: { failedAt: number; id: string } | undefined,
): boolean {
  if (!cutoff || row.failed_at == null) {
    return false;
  }
  const failedAt = Number(row.failed_at);
  return failedAt < cutoff.failedAt || (failedAt === cutoff.failedAt && row.id < cutoff.id);
}

export function resolveDeliveryFailureExpiry(params: {
  database: OpenClawStateDatabase;
  row: DeliveryFailureRow;
  policy: DeliveryQueueTerminalPolicy;
  fullDetailCutoff?: { failedAt: number; id: string };
  now: number;
}) {
  return {
    boundedExpired: isProducerBoundedFailureFenceExpiredInDatabase(params),
    detailExpired:
      (params.policy.detailExpiresAt !== undefined &&
        params.policy.detailExpiresAt <= params.now) ||
      (params.row.failed_at != null &&
        Number(params.row.failed_at) <= params.now - DELIVERY_FAILURE_DETAIL_RETENTION_MS) ||
      (params.policy.replay === "safe" &&
        isBeyondFullDetailCount(params.row, params.fullDetailCutoff)),
    immediateTerminal: params.policy.replay === "ambiguous" && params.policy.cleanup === "complete",
  };
}

function isProducerBoundedFailureFenceExpiredInDatabase(params: {
  database: OpenClawStateDatabase;
  row: DeliveryFailureRow;
  policy: DeliveryQueueTerminalPolicy;
  now?: number;
}): boolean {
  const fence = params.policy.fence;
  if (fence.kind !== "producer-bounded" || !params.row.id.startsWith(fence.idPrefix)) {
    return false;
  }
  const failedAt = Number(params.row.failed_at ?? params.row.updated_at);
  if (failedAt < (params.now ?? Date.now()) - fence.maxAgeMs) {
    return true;
  }
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(params.database.db);
  const cutoff = executeSqliteQueryTakeFirstSync(
    params.database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select("id")
      .where("queue_name", "=", params.row.queue_name)
      .where("status", "=", "failed")
      .where("id", ">=", fence.idPrefix)
      .where("id", "<", `${fence.idPrefix}\uffff`)
      .where(
        /* kysely-allow-raw: SQLite JSON1 keeps producer count retention isolated to its authored prefix. */
        sql<boolean>`${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.version")} = 1
          AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.fence.kind")} = 'producer-bounded'
          AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.fence.idPrefix")} = ${fence.idPrefix}`,
      )
      .where((eb) =>
        eb.or([
          eb("failed_at", ">", failedAt),
          eb.and([eb("failed_at", "=", failedAt), eb("id", ">", params.row.id)]),
        ]),
      )
      .orderBy("failed_at", "desc")
      .orderBy("id", "desc")
      .limit(1)
      .offset(fence.maxEntries - 1),
  );
  return cutoff !== undefined;
}

/** Deletes only an exact expired producer-bounded fence; unknown/permanent rows fail closed. */
export function expireProducerBoundedFailureFenceInDatabase(params: {
  database: OpenClawStateDatabase;
  queueName: string;
  id: string;
  now?: number;
}): boolean {
  const row = selectFailedRow(params.database, params.queueName, params.id);
  if (!row || row.status !== "failed") {
    return false;
  }
  const { policy, legacyUnknown } = readDeliveryFailurePolicy(row);
  return !legacyUnknown &&
    isProducerBoundedFailureFenceExpiredInDatabase({
      database: params.database,
      row,
      policy,
      now: params.now,
    })
    ? deleteDeliveryFailureRow(params.database, row)
    : false;
}

export function listDeliveryFailures(params?: {
  stateDir?: string;
  queueName?: string;
  limit?: number;
  before?: number;
}): DeliveryFailureMetadata[] {
  const database = openDeliveryFailureDatabase(params?.stateDir);
  return loadSelectedFailureRows(database, params).map(failureMetadata);
}

function loadSelectedFailureRows(
  database: OpenClawStateDatabase,
  params?: { queueName?: string; limit?: number; before?: number },
): DeliveryFailureRow[] {
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  let query = queueDb
    .selectFrom("delivery_queue_entries")
    .select([
      "queue_name",
      "id",
      "status",
      "retry_count",
      "recovery_state",
      "entry_json",
      "enqueued_at",
      "updated_at",
      "failed_at",
    ])
    .where("status", "=", "failed");
  if (params?.queueName) {
    query = query.where("queue_name", "=", params.queueName);
  }
  if (params?.before !== undefined) {
    query = query.where("failed_at", "<", params.before);
  }
  return executeSqliteQuerySync(
    database.db,
    query
      .orderBy("failed_at", "desc")
      .orderBy("queue_name", "asc")
      .orderBy("id", "asc")
      .limit(Math.max(1, Math.min(params?.limit ?? 100, 500))),
  ).rows as DeliveryFailureRow[];
}

/** Full failed entries that still retain replay or owner-cleanup custody. */
export function loadRetainedFailedDeliveryEntries(
  queueNames: readonly string[],
  stateDir?: string,
  id?: string,
): DeliveryQueueEntryState[] {
  const database = openDeliveryFailureDatabase(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  let query = queueDb
    .selectFrom("delivery_queue_entries")
    .select("entry_json")
    .where("queue_name", "in", queueNames)
    .where("status", "=", "failed")
    .where(
      /* kysely-allow-raw: SQLite JSON1 bounds the GC candidate set to rows retaining outbound custody. */
      sql<boolean>`${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.version")} = 1
        AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.detail")} = 'full'
        AND (
          (${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.replay")} = 'safe'
            AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.fence.kind")} = 'none')
          OR
          (${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.replay")} = 'owner-managed'
            AND ${safeDeliveryQueueEntryJsonExtract("$.terminalPolicy.cleanup")} != 'complete')
        )`,
    );
  if (id) {
    query = query.where("id", "=", id);
  }
  const rows = executeSqliteQuerySync(database.db, query).rows as Array<{ entry_json: string }>;
  return rows.flatMap((row) => {
    const parsed = parseTerminalPolicyFromEntryJson(row.entry_json);
    return parsed.entry && parsed.policy ? [parsed.entry] : [];
  });
}

export async function purgeDeliveryFailures(params?: {
  stateDir?: string;
  apply?: boolean;
  now?: number;
  queueName?: string;
  limit?: number;
  afterApply?: (action: DeliveryFailurePurgeAppliedAction) => Promise<void>;
}): Promise<DeliveryFailureMaintenanceResult> {
  const database = openDeliveryFailureDatabase(params?.stateDir);
  const now = params?.now ?? Date.now();
  const rows = loadSelectedFailureRows(database, {
    queueName: params?.queueName,
    limit: params?.limit ?? 500,
  });
  const fullDetailCutoffs = new Map<string, { failedAt: number; id: string } | undefined>();
  let legacyUnknownCount = 0;
  const actions = rows.flatMap<DeliveryFailurePurgeAction>((row) => {
    const { policy, legacyUnknown } = readDeliveryFailurePolicy(row);
    if (legacyUnknown) {
      legacyUnknownCount += 1;
    }
    if (policy.replay === "owner-managed" && policy.cleanup !== "complete") {
      return [];
    }
    if (!fullDetailCutoffs.has(row.queue_name)) {
      fullDetailCutoffs.set(
        row.queue_name,
        loadDeliveryFailureFullDetailCutoff(database, row.queue_name),
      );
    }
    const expiry = resolveDeliveryFailureExpiry({
      database,
      row,
      policy,
      now,
      fullDetailCutoff: fullDetailCutoffs.get(row.queue_name),
    });
    if (
      expiry.boundedExpired ||
      ((expiry.detailExpired || expiry.immediateTerminal) && policy.fence.kind === "none")
    ) {
      return [{ kind: "delete" as const, row, policy }];
    }
    if (
      legacyUnknown ||
      (policy.detail === "full" && (policy.fence.kind !== "none" || policy.owner !== undefined))
    ) {
      return [{ kind: "compact" as const, row, policy }];
    }
    return [];
  });
  const result: DeliveryFailureMaintenanceResult = {
    scanned: rows.length,
    compacted: actions.filter((action) => action.kind === "compact").length,
    deleted: actions.filter((action) => action.kind === "delete").length,
    legacyUnknown: legacyUnknownCount,
    errors: 0,
  };
  if (!params?.apply) {
    return result;
  }
  result.compacted = 0;
  result.deleted = 0;
  for (const action of actions) {
    let applied: boolean;
    try {
      applied =
        action.kind === "delete"
          ? deleteDeliveryFailureRow(database, action.row)
          : runSqliteImmediateTransactionSync(
              database.db,
              () =>
                compactFailedDeliveryQueueEntryInDatabase({
                  database,
                  queueName: action.row.queue_name,
                  id: action.row.id,
                  expected: action.row,
                  policy: action.policy,
                  now,
                }),
              { databaseLabel: "openclaw-state", operationLabel: "purge delivery failure" },
            );
    } catch {
      result.errors += 1;
      continue;
    }
    if (!applied) {
      result.errors += 1;
      continue;
    }
    if (action.kind === "delete") {
      result.deleted += 1;
    } else {
      result.compacted += 1;
    }
    try {
      await params?.afterApply?.({
        kind: action.kind,
        queueName: action.row.queue_name,
        entryJson: action.row.entry_json,
        ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      });
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

export function loadFailedDeliveryRowInDatabase(
  database: OpenClawStateDatabase,
  queueName: string,
  id: string,
): DeliveryFailureRow | undefined {
  const row = selectFailedRow(database, queueName, id);
  return row?.status === "failed" ? row : undefined;
}
