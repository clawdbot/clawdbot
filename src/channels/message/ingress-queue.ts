/**
 * Durable channel ingress queue.
 *
 * Stores, claims, completes, and tombstones inbound channel events in OpenClaw state.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Selectable } from "kysely";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import type {
  ChannelIngressEvents,
  DB as OpenClawStateKyselyDatabase,
} from "../../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../../state/openclaw-state-db.js";

/** Pending or retryable inbound channel event stored in the durable ingress queue. */
export type ChannelIngressQueueRecord<TPayload, TMetadata = unknown> = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  payload: TPayload;
  metadata?: TMetadata;
  receivedAt: number;
  updatedAt: number;
  laneKey?: string;
  attempts: number;
  lastAttemptAt?: number;
  lastError?: string;
};

/** Pending ingress event currently claimed by a worker. */
export type ChannelIngressQueueClaim<TPayload, TMetadata = unknown> = ChannelIngressQueueRecord<
  TPayload,
  TMetadata
> & {
  claim: {
    token: string;
    ownerId: string;
    claimedAt: number;
  };
};

/** Minimal claim reference used to guard completion/release/failure with a claim token. */
export type ChannelIngressQueueClaimRef = {
  id: string;
  claim: {
    token: string;
  };
};

/** Claim identity available when a stale row's payload cannot be decoded. */
export type ChannelIngressQueueCorruptClaim = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  laneKey?: string;
  reason: "corrupt_payload";
  claim: {
    token: string;
    ownerId: string;
    claimedAt: number;
  };
};

/** Completed ingress event tombstone retained for duplicate detection. */
export type ChannelIngressQueueCompletedRecord<TCompletedMetadata = unknown> = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  completedAt: number;
  metadata?: TCompletedMetadata;
};

/** Failed ingress event tombstone retained for duplicate detection and diagnostics. */
export type ChannelIngressQueueFailedRecord = {
  id: string;
  channelId: string;
  accountId: string;
  queueName: string;
  failedAt: number;
  reason: string;
  message?: string;
};

/** Retention options for pending, completed, and failed ingress queue rows. */
export type ChannelIngressQueuePruneOptions = {
  pendingTtlMs?: number;
  completedTtlMs?: number;
  failedTtlMs?: number;
  pendingMaxEntries?: number;
  completedMaxEntries?: number;
  failedMaxEntries?: number;
  protectIds?: Iterable<string>;
  now?: number;
};

/** Result of enqueueing a possibly duplicate ingress event id. */
export type ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata> =
  | {
      kind: "accepted";
      duplicate: false;
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
    }
  | {
      kind: "pending";
      duplicate: true;
      record: ChannelIngressQueueRecord<TPayload, TMetadata>;
    }
  | {
      kind: "claimed";
      duplicate: true;
      record: ChannelIngressQueueClaim<TPayload, TMetadata>;
    }
  | {
      kind: "completed";
      duplicate: true;
      record: ChannelIngressQueueCompletedRecord<TCompletedMetadata>;
    }
  | {
      kind: "failed";
      duplicate: true;
      record: ChannelIngressQueueFailedRecord;
    };

/** Durable FIFO-ish ingress queue with claims, duplicate detection, and retention pruning. */
export type ChannelIngressQueue<TPayload, TMetadata = unknown, TCompletedMetadata = unknown> = {
  enqueue(
    id: string,
    payload: TPayload,
    options?: {
      metadata?: TMetadata;
      receivedAt?: number;
      laneKey?: string;
    },
  ): Promise<ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata>>;
  listPending(options?: {
    limit?: number | "all";
    orderBy?: "received" | "id";
  }): Promise<Array<ChannelIngressQueueRecord<TPayload, TMetadata>>>;
  listClaims(): Promise<Array<ChannelIngressQueueClaim<TPayload, TMetadata>>>;
  claimNext(options?: {
    ownerId?: string;
    blockedLaneKeys?: Iterable<string>;
    staleMs?: number;
    orderBy?: "received" | "id";
    scanLimit?: number;
    candidateIds?: Iterable<string>;
    deriveLaneKey?: (record: ChannelIngressQueueRecord<TPayload, TMetadata>) => string | undefined;
  }): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
  claim(
    id: string,
    options?: { ownerId?: string },
  ): Promise<ChannelIngressQueueClaim<TPayload, TMetadata> | null>;
  refreshClaim?(
    claim: ChannelIngressQueueClaimRef,
    options?: { refreshedAt?: number },
  ): Promise<boolean>;
  complete(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: { metadata?: TCompletedMetadata; completedAt?: number },
  ): Promise<boolean>;
  release(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options?: { lastError?: string; releasedAt?: number; recordAttempt?: boolean },
  ): Promise<boolean>;
  fail(
    idOrClaim: string | ChannelIngressQueueClaimRef,
    options: { reason: string; message?: string; failedAt?: number },
  ): Promise<boolean>;
  delete(
    idOrClaim:
      | string
      | ChannelIngressQueueRecord<TPayload, TMetadata>
      | ChannelIngressQueueClaimRef,
  ): Promise<boolean>;
  recoverStaleClaims(options?: {
    staleMs?: number;
    now?: number;
    shouldRecover?: (
      claim: ChannelIngressQueueClaim<TPayload, TMetadata>,
    ) => boolean | Promise<boolean>;
    shouldRecoverCorrupt?: (claim: ChannelIngressQueueCorruptClaim) => boolean | Promise<boolean>;
  }): Promise<number>;
  prune(options?: ChannelIngressQueuePruneOptions): Promise<number>;
};

/** Construction options for a channel/account-scoped ingress queue. */
export type CreateChannelIngressQueueOptions = {
  channelId: string;
  accountId?: string;
  stateDir?: string;
  now?: () => number;
};

type ChannelIngressDatabase = Pick<OpenClawStateKyselyDatabase, "channel_ingress_events">;
type ChannelIngressRow = Selectable<ChannelIngressEvents>;

function normalizePart(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  return normalized ? normalized : fallback;
}

// Keep inherited lookups for HOME/etc. without enumerating large Kubernetes service envs.
function createStateDirEnv(
  stateDir: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env = Object.create(baseEnv) as NodeJS.ProcessEnv;
  env.OPENCLAW_STATE_DIR = stateDir;
  return env;
}

function openStateDatabase(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? createStateDirEnv(stateDir) : process.env,
  });
}

function getChannelIngressKysely(db: DatabaseSync) {
  return getNodeSqliteKysely<ChannelIngressDatabase>(db);
}

function affectedRows(result: { numAffectedRows?: bigint }): number {
  return Number(result.numAffectedRows ?? 0n);
}

type ParseJsonResult = { ok: true; value: unknown } | { ok: false };

function parseJson(value: string): ParseJsonResult {
  try {
    return { ok: true, value: JSON.parse(value) };
  } catch {
    return { ok: false };
  }
}

function baseRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueRecord<TPayload, TMetadata> | null {
  const payloadResult = parseJson(row.payload_json);
  if (!payloadResult.ok) {
    return null;
  }
  const metaResult = row.metadata_json === null ? null : parseJson(row.metadata_json);
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    payload: payloadResult.value as TPayload,
    ...(metaResult === null || !metaResult.ok ? {} : { metadata: metaResult.value as TMetadata }),
    receivedAt: row.received_at,
    updatedAt: row.updated_at,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    attempts: row.attempts,
    ...(row.last_attempt_at === null ? {} : { lastAttemptAt: row.last_attempt_at }),
    ...(row.last_error === null ? {} : { lastError: row.last_error }),
  };
}

function claimedRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueClaim<TPayload, TMetadata> | null {
  const base = baseRecord<TPayload, TMetadata>(row);
  if (base === null) {
    return null;
  }
  return {
    ...base,
    claim: {
      token: row.claim_token ?? "",
      ownerId: row.claim_owner ?? "",
      claimedAt: row.claimed_at ?? 0,
    },
  };
}

function corruptClaimRecord(row: ChannelIngressRow): ChannelIngressQueueCorruptClaim {
  const claimValue = row.claim_token ?? "";
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    ...(row.lane_key === null ? {} : { laneKey: row.lane_key }),
    reason: "corrupt_payload",
    claim: {
      token: claimValue,
      ownerId: row.claim_owner ?? "",
      claimedAt: row.claimed_at ?? 0,
    },
  };
}

function completedRecord<TCompletedMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueCompletedRecord<TCompletedMetadata> {
  const metaResult =
    row.completed_metadata_json === null ? null : parseJson(row.completed_metadata_json);
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    completedAt: row.completed_at ?? row.updated_at,
    ...(metaResult === null || !metaResult.ok
      ? {}
      : { metadata: metaResult.value as TCompletedMetadata }),
  };
}

function failedRecord(row: ChannelIngressRow): ChannelIngressQueueFailedRecord {
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    failedAt: row.failed_at ?? row.updated_at,
    reason: row.failed_reason ?? "failed",
    ...(row.last_error === null ? {} : { message: row.last_error }),
  };
}

function selectRow(db: DatabaseSync, queueName: string, id: string) {
  const kysely = getChannelIngressKysely(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    kysely
      .selectFrom("channel_ingress_events")
      .selectAll()
      .where("queue_name", "=", queueName)
      .where("event_id", "=", id),
  );
}

function tombstoneCorruptPayloadRow(params: {
  db: DatabaseSync;
  row: ChannelIngressRow;
  expectedStatus: "pending" | "claimed";
  failedAt: number;
  staleCutoff?: number;
}): boolean {
  const kysely = getChannelIngressKysely(params.db);
  const baseUpdate = kysely
    .updateTable("channel_ingress_events")
    .set({
      status: "failed",
      failed_at: params.failedAt,
      failed_reason: "corrupt_payload",
      last_error: null,
      payload_json: "null",
      metadata_json: null,
      claim_token: null,
      claim_owner: null,
      claimed_at: null,
      updated_at: params.failedAt,
    })
    .where("queue_name", "=", params.row.queue_name)
    .where("event_id", "=", params.row.event_id)
    .where("status", "=", params.expectedStatus);
  if (params.expectedStatus === "pending") {
    return affectedRows(executeSqliteQuerySync(params.db, baseUpdate)) > 0;
  }
  const claimGuardedUpdate =
    params.row.claim_token === null
      ? baseUpdate.where("claim_token", "is", null)
      : baseUpdate.where("claim_token", "=", params.row.claim_token);
  const staleGuardedUpdate =
    params.staleCutoff === undefined
      ? claimGuardedUpdate
      : claimGuardedUpdate.where("claimed_at", "<=", params.staleCutoff);
  return affectedRows(executeSqliteQuerySync(params.db, staleGuardedUpdate)) > 0;
}

function idFrom(idOrRecord: string | { id: string }): string {
  const id = normalizePart(typeof idOrRecord === "string" ? idOrRecord : idOrRecord.id, "");
  if (!id) {
    throw new Error("Channel ingress event id cannot be empty");
  }
  return id;
}

function claimTokenFrom(
  idOrClaim: string | { id: string; claim?: { token: string } },
): string | null {
  return typeof idOrClaim === "string" ? null : (idOrClaim.claim?.token ?? null);
}

function rowToEnqueueResult<TPayload, TMetadata, TCompletedMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata> | null {
  if (row.status === "completed") {
    return { kind: "completed", duplicate: true, record: completedRecord(row) };
  }
  if (row.status === "failed") {
    return { kind: "failed", duplicate: true, record: failedRecord(row) };
  }
  if (row.status === "claimed") {
    const rec = claimedRecord<TPayload, TMetadata>(row);
    return rec ? { kind: "claimed", duplicate: true, record: rec } : null;
  }
  const rec = baseRecord<TPayload, TMetadata>(row);
  return rec ? { kind: "pending", duplicate: true, record: rec } : null;
}

function normalizeLimit(limit: number | "all" | undefined): number {
  return limit === "all" ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(limit ?? 100));
}

function normalizeScanLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? 100));
}

// Materialize pending rows in bounded chunks because SQLite's json_valid()
// rejects some payloads accepted by the queue's JSON.stringify/JSON.parse contract.
const LIST_PENDING_BATCH_SIZE = 100;
// Keep repair work bounded under one SQLite write lock; later calls continue
// from the durable failed tombstones left by this call.
const MAX_CORRUPT_RECONCILIATIONS_PER_CLAIM = 100;

function normalizeMaxEntries(value: number | undefined): number | null {
  return value === undefined ? null : Math.max(0, Math.floor(value));
}

function normalizedProtectedIds(ids: Iterable<string> | undefined): string[] {
  return [...(ids ?? [])].map((id) => id.trim()).filter(Boolean);
}

function normalizedCandidateIds(ids: Iterable<string> | undefined): string[] | undefined {
  return ids === undefined ? undefined : [...ids].map((id) => id.trim()).filter(Boolean);
}

function queueNameForParts(channelId: string, accountId: string): string {
  // JSON tuple encoding keeps channel/account scopes unambiguous even when ids contain separators.
  return JSON.stringify([channelId, accountId]);
}

/** Creates a durable channel/account-scoped ingress queue backed by the OpenClaw state database. */
export function createChannelIngressQueue<
  TPayload,
  TMetadata = unknown,
  TCompletedMetadata = unknown,
>(
  options: CreateChannelIngressQueueOptions,
): ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata> {
  const channelId = normalizePart(options.channelId, "unknown");
  const accountId = normalizePart(options.accountId, "default");
  const queueName = queueNameForParts(channelId, accountId);
  const now = options.now ?? Date.now;

  const enqueue: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["enqueue"] = async (
    id,
    payload,
    enqueueOptions,
  ) => {
    const eventId = normalizePart(id, "");
    if (!eventId) {
      throw new Error("Channel ingress event id cannot be empty");
    }
    const receivedAt = enqueueOptions?.receivedAt ?? now();
    const updatedAt = now();
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const insert = executeSqliteQuerySync(
          tx.db,
          kysely
            .insertInto("channel_ingress_events")
            .values({
              queue_name: queueName,
              event_id: eventId,
              channel_id: channelId,
              account_id: accountId,
              status: "pending",
              lane_key: enqueueOptions?.laneKey ?? null,
              payload_json: JSON.stringify(payload),
              metadata_json:
                enqueueOptions?.metadata === undefined
                  ? null
                  : JSON.stringify(enqueueOptions.metadata),
              received_at: receivedAt,
              updated_at: updatedAt,
              attempts: 0,
            })
            .onConflict((conflict) => conflict.columns(["queue_name", "event_id"]).doNothing()),
        );
        const row = selectRow(tx.db, queueName, eventId);
        if (!row) {
          throw new Error(`Failed to read channel ingress event ${queueName}/${eventId}`);
        }
        if (affectedRows(insert) > 0) {
          const fresh = baseRecord<TPayload, TMetadata>(row);
          if (fresh === null) {
            throw new Error(
              `Corrupt payload_json in channel ingress event ${queueName}/${eventId}`,
            );
          }
          return {
            kind: "accepted",
            duplicate: false,
            record: fresh,
          };
        }
        const dup = rowToEnqueueResult<TPayload, TMetadata, TCompletedMetadata>(row);
        if (dup === null) {
          // A live claimant may already be producing external side effects.
          // Duplicate enqueue cannot prove ownership is stale, so leave claimed
          // corruption for the ownership-aware recovery path.
          if (row.status === "claimed") {
            throw new Error(
              `Corrupt payload_json in claimed channel ingress event ${queueName}/${eventId}`,
            );
          }
          if (
            !tombstoneCorruptPayloadRow({
              db: tx.db,
              row,
              expectedStatus: "pending",
              failedAt: updatedAt,
            })
          ) {
            throw new Error(`Failed to tombstone corrupt ingress event ${queueName}/${eventId}`);
          }
          return {
            kind: "failed",
            duplicate: true,
            record: {
              id: row.event_id,
              channelId: row.channel_id,
              accountId: row.account_id,
              queueName: row.queue_name,
              failedAt: updatedAt,
              reason: "corrupt_payload",
            },
          };
        }
        return dup;
      },
      { path: database.path },
    );
  };

  const listPending: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["listPending"] = async (listOptions) => {
    const { db } = openStateDatabase(options.stateDir);
    const kysely = getChannelIngressKysely(db);
    const limit = normalizeLimit(listOptions?.limit);
    const records: Array<ChannelIngressQueueRecord<TPayload, TMetadata>> = [];
    let lastRow: ChannelIngressRow | undefined;
    while (records.length < limit) {
      let pageQuery = kysely
        .selectFrom("channel_ingress_events")
        .selectAll()
        .where("queue_name", "=", queueName)
        .where("status", "=", "pending");
      if (lastRow) {
        const cursor = lastRow;
        pageQuery =
          listOptions?.orderBy === "id"
            ? pageQuery.where("event_id", ">", cursor.event_id)
            : pageQuery.where((eb) =>
                eb.or([
                  eb("received_at", ">", cursor.received_at),
                  eb.and([
                    eb("received_at", "=", cursor.received_at),
                    eb("event_id", ">", cursor.event_id),
                  ]),
                ]),
              );
      }
      const orderedQuery =
        listOptions?.orderBy === "id"
          ? pageQuery.orderBy("event_id", "asc")
          : pageQuery.orderBy("received_at", "asc").orderBy("event_id", "asc");
      const rows = executeSqliteQuerySync(db, orderedQuery.limit(LIST_PENDING_BATCH_SIZE)).rows;
      for (const row of rows) {
        const record = baseRecord<TPayload, TMetadata>(row);
        if (record) {
          records.push(record);
          if (records.length === limit) {
            break;
          }
        }
      }
      if (rows.length < LIST_PENDING_BATCH_SIZE) {
        break;
      }
      lastRow = rows.at(-1);
    }
    return records;
  };

  const listClaims: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["listClaims"] = async () => {
    const { db } = openStateDatabase(options.stateDir);
    const kysely = getChannelIngressKysely(db);
    const rows = executeSqliteQuerySync(
      db,
      kysely
        .selectFrom("channel_ingress_events")
        .selectAll()
        .where("queue_name", "=", queueName)
        .where("status", "=", "claimed")
        .orderBy("claimed_at", "asc")
        .orderBy("received_at", "asc")
        .orderBy("event_id", "asc"),
    ).rows;
    return rows
      .map((row) => claimedRecord<TPayload, TMetadata>(row))
      .filter((rec): rec is ChannelIngressQueueClaim<TPayload, TMetadata> => rec !== null);
  };

  const claimNext: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["claimNext"] = async (claimOptions) => {
    if (claimOptions?.staleMs !== undefined) {
      await recoverStaleClaims({ staleMs: claimOptions.staleMs });
    }
    const blocked = new Set(
      [...(claimOptions?.blockedLaneKeys ?? [])].map((key) => key.trim()).filter(Boolean),
    );
    const candidateIds = normalizedCandidateIds(claimOptions?.candidateIds);
    if (candidateIds?.length === 0) {
      return null;
    }
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        let effectiveBlocked = blocked;
        if (candidateIds && candidateIds.length > 0) {
          // Candidate snapshots can race a sibling drainer. If an earlier
          // candidate is now claimed, its lane must block later same-lane rows.
          const claimedCandidateRows = executeSqliteQuerySync(
            tx.db,
            kysely
              .selectFrom("channel_ingress_events")
              .selectAll()
              .where("queue_name", "=", queueName)
              .where("status", "=", "claimed")
              .where("event_id", "in", candidateIds),
          ).rows;
          const claimedCandidateLaneKeys = claimedCandidateRows
            .map((row) => {
              if (row.lane_key) {
                return row.lane_key;
              }
              if (!claimOptions?.deriveLaneKey) {
                return undefined;
              }
              const rec = baseRecord<TPayload, TMetadata>(row);
              return rec ? claimOptions.deriveLaneKey(rec) : undefined;
            })
            .filter((laneKey): laneKey is string => Boolean(laneKey));
          if (claimedCandidateLaneKeys.length > 0) {
            effectiveBlocked = new Set([...blocked, ...claimedCandidateLaneKeys]);
          }
        }
        const baseSelect = kysely
          .selectFrom("channel_ingress_events")
          .selectAll()
          .where("queue_name", "=", queueName)
          .where("status", "=", "pending");
        let select = baseSelect;
        if (candidateIds) {
          select = select.where("event_id", "in", candidateIds);
        }
        if (effectiveBlocked.size > 0 && !claimOptions?.deriveLaneKey) {
          select = select.where((eb) =>
            eb.or([eb("lane_key", "is", null), eb("lane_key", "not in", [...effectiveBlocked])]),
          );
        }
        let orderedSelect =
          claimOptions?.orderBy === "id"
            ? select.orderBy("event_id", "asc")
            : select.orderBy("received_at", "asc").orderBy("event_id", "asc");
        orderedSelect = orderedSelect.limit(normalizeScanLimit(claimOptions?.scanLimit));
        const transitionAt = now();
        let corruptReconciliations = 0;
        let selected:
          | { row: ChannelIngressRow; record: ChannelIngressQueueRecord<TPayload, TMetadata> }
          | undefined;
        while (!selected) {
          const rows = executeSqliteQuerySync(tx.db, orderedSelect).rows;
          let tombstonedCorruptRow = false;
          for (const row of rows) {
            const rec = baseRecord<TPayload, TMetadata>(row);
            if (rec === null) {
              if (corruptReconciliations >= MAX_CORRUPT_RECONCILIATIONS_PER_CLAIM) {
                continue;
              }
              const didTombstone = tombstoneCorruptPayloadRow({
                db: tx.db,
                row,
                expectedStatus: "pending",
                failedAt: transitionAt,
              });
              tombstonedCorruptRow = didTombstone || tombstonedCorruptRow;
              if (didTombstone) {
                corruptReconciliations += 1;
              }
              continue;
            }
            const laneKey =
              row.lane_key ??
              (claimOptions?.deriveLaneKey ? claimOptions.deriveLaneKey(rec) : undefined);
            if (!laneKey || !effectiveBlocked.has(laneKey)) {
              selected = { row, record: rec };
              break;
            }
          }
          if (
            selected ||
            !tombstonedCorruptRow ||
            corruptReconciliations >= MAX_CORRUPT_RECONCILIATIONS_PER_CLAIM
          ) {
            break;
          }
        }
        if (!selected) {
          return null;
        }
        const derivedLaneKey =
          selected.row.lane_key ??
          (claimOptions?.deriveLaneKey ? claimOptions.deriveLaneKey(selected.record) : undefined);
        const token = randomUUID();
        const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "claimed",
              claim_token: token,
              claim_owner: ownerId,
              claimed_at: transitionAt,
              ...(derivedLaneKey ? { lane_key: derivedLaneKey } : {}),
              updated_at: transitionAt,
            })
            .where("queue_name", "=", queueName)
            .where("event_id", "=", selected.row.event_id)
            .where("status", "=", "pending"),
        );
        if (affectedRows(result) === 0) {
          return null;
        }
        const row = selectRow(tx.db, queueName, selected.row.event_id);
        return row ? claimedRecord<TPayload, TMetadata>(row) : null;
      },
      { path: database.path },
    );
  };

  const claim: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["claim"] = async (
    id,
    claimOptions,
  ) => {
    const eventId = normalizePart(id, "");
    if (!eventId) {
      throw new Error("Channel ingress event id cannot be empty");
    }
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const transitionAt = now();
        const pendingRow = selectRow(tx.db, queueName, eventId);
        if (!pendingRow || pendingRow.status !== "pending") {
          return null;
        }
        if (baseRecord<TPayload, TMetadata>(pendingRow) === null) {
          tombstoneCorruptPayloadRow({
            db: tx.db,
            row: pendingRow,
            expectedStatus: "pending",
            failedAt: transitionAt,
          });
          return null;
        }
        const token = randomUUID();
        const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "claimed",
              claim_token: token,
              claim_owner: ownerId,
              claimed_at: transitionAt,
              updated_at: transitionAt,
            })
            .where("queue_name", "=", queueName)
            .where("event_id", "=", eventId)
            .where("status", "=", "pending"),
        );
        if (affectedRows(result) === 0) {
          return null;
        }
        const row = selectRow(tx.db, queueName, eventId);
        return row ? claimedRecord<TPayload, TMetadata>(row) : null;
      },
      { path: database.path },
    );
  };

  const refreshClaim: NonNullable<
    ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["refreshClaim"]
  > = async (claimRef, refreshOptions) => {
    const eventId = idFrom(claimRef);
    const refreshedAt = refreshOptions?.refreshedAt ?? now();
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              claimed_at: refreshedAt,
              updated_at: refreshedAt,
            })
            .where("queue_name", "=", queueName)
            .where("event_id", "=", eventId)
            .where("status", "=", "claimed")
            .where("claim_token", "=", claimRef.claim.token),
        );
        return affectedRows(result) > 0;
      },
      { path: database.path },
    );
  };

  const releaseClaimIfStillStale = async (
    claimRef: ChannelIngressQueueClaimRef,
    releaseOptions: { cutoff: number; releasedAt: number },
  ): Promise<boolean> => {
    const eventId = idFrom(claimRef);
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set((eb) => ({
              status: "pending",
              claim_token: null,
              claim_owner: null,
              claimed_at: null,
              attempts: eb("attempts", "+", 1),
              last_attempt_at: releaseOptions.releasedAt,
              updated_at: releaseOptions.releasedAt,
            }))
            .where("queue_name", "=", queueName)
            .where("event_id", "=", eventId)
            .where("status", "=", "claimed")
            .where("claim_token", "=", claimRef.claim.token)
            .where("claimed_at", "<=", releaseOptions.cutoff),
        );
        return affectedRows(result) > 0;
      },
      { path: database.path },
    );
  };

  const recoverStaleClaims: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["recoverStaleClaims"] = async (recoverOptions) => {
    const current = recoverOptions?.now ?? now();
    const staleMs = Math.max(0, Math.floor(recoverOptions?.staleMs ?? 0));
    const cutoff = current - staleMs;
    const database = openStateDatabase(options.stateDir);
    const claimedRows = executeSqliteQuerySync(
      database.db,
      getChannelIngressKysely(database.db)
        .selectFrom("channel_ingress_events")
        .selectAll()
        .where("queue_name", "=", queueName)
        .where("status", "=", "claimed")
        .where("claimed_at", "<=", cutoff),
    ).rows;
    let recovered = 0;
    for (const row of claimedRows) {
      const claimRec = claimedRecord<TPayload, TMetadata>(row);
      if (claimRec === null) {
        const shouldRecoverCorrupt = recoverOptions?.shouldRecoverCorrupt;
        if (shouldRecoverCorrupt) {
          if (!(await shouldRecoverCorrupt(corruptClaimRecord(row)))) {
            continue;
          }
        } else if (recoverOptions?.shouldRecover) {
          // Existing payload-aware policies cannot safely decide on corrupt
          // data. Preserve ownership unless the caller opts into the raw claim
          // identity contract above.
          continue;
        }
        const tombstoned = runOpenClawStateWriteTransaction(
          (tx) =>
            tombstoneCorruptPayloadRow({
              db: tx.db,
              row,
              expectedStatus: "claimed",
              failedAt: current,
              staleCutoff: cutoff,
            }),
          { path: database.path },
        );
        if (tombstoned) {
          recovered += 1;
        }
        continue;
      }
      if (recoverOptions?.shouldRecover && !(await recoverOptions.shouldRecover(claimRec))) {
        continue;
      }
      if (await releaseClaimIfStillStale(claimRec, { cutoff, releasedAt: current })) {
        recovered += 1;
      }
    }
    return recovered;
  };

  const complete: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["complete"] = async (
    idOrClaim,
    completeOptions,
  ) => {
    const eventId = idFrom(idOrClaim);
    const token = claimTokenFrom(idOrClaim);
    const completedAt = completeOptions?.completedAt ?? now();
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const baseUpdate = kysely
          .updateTable("channel_ingress_events")
          .set({
            status: "completed",
            completed_at: completedAt,
            completed_metadata_json:
              completeOptions?.metadata === undefined
                ? null
                : JSON.stringify(completeOptions.metadata),
            payload_json: "null",
            metadata_json: null,
            claim_token: null,
            claim_owner: null,
            claimed_at: null,
            last_attempt_at: null,
            last_error: null,
            updated_at: completedAt,
          })
          .where("queue_name", "=", queueName)
          .where("event_id", "=", eventId);
        const update =
          token === null
            ? baseUpdate.where("status", "=", "pending")
            : baseUpdate.where("status", "=", "claimed").where("claim_token", "=", token);
        const result = executeSqliteQuerySync(tx.db, update);
        if (affectedRows(result) > 0) {
          return true;
        }
        if (token !== null) {
          return false;
        }
        const insert = executeSqliteQuerySync(
          tx.db,
          kysely
            .insertInto("channel_ingress_events")
            .values({
              queue_name: queueName,
              event_id: eventId,
              channel_id: channelId,
              account_id: accountId,
              status: "completed",
              lane_key: null,
              payload_json: "null",
              metadata_json: null,
              received_at: completedAt,
              updated_at: completedAt,
              attempts: 0,
              completed_at: completedAt,
              completed_metadata_json:
                completeOptions?.metadata === undefined
                  ? null
                  : JSON.stringify(completeOptions.metadata),
            })
            .onConflict((conflict) => conflict.columns(["queue_name", "event_id"]).doNothing()),
        );
        return affectedRows(insert) > 0;
      },
      { path: database.path },
    );
  };

  const release: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["release"] = async (
    idOrClaim,
    releaseOptions,
  ) => {
    const eventId = idFrom(idOrClaim);
    const token = claimTokenFrom(idOrClaim);
    const releasedAt = releaseOptions?.releasedAt ?? now();
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const baseUpdate = kysely
          .updateTable("channel_ingress_events")
          .set((eb) => ({
            status: "pending",
            claim_token: null,
            claim_owner: null,
            claimed_at: null,
            // A claim can lose its owner before processing starts. Returning it
            // must not consume retry budget or erase the previous real failure.
            ...(releaseOptions?.recordAttempt === false
              ? {}
              : {
                  attempts: eb("attempts", "+", 1),
                  last_attempt_at: releasedAt,
                }),
            ...(releaseOptions?.lastError === undefined
              ? {}
              : { last_error: releaseOptions.lastError }),
            updated_at: releasedAt,
          }))
          .where("queue_name", "=", queueName)
          .where("event_id", "=", eventId);
        const update =
          token === null
            ? baseUpdate.where("status", "=", "pending")
            : baseUpdate.where("status", "=", "claimed").where("claim_token", "=", token);
        return affectedRows(executeSqliteQuerySync(tx.db, update)) > 0;
      },
      { path: database.path },
    );
  };

  const fail: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["fail"] = async (
    idOrClaim,
    failOptions,
  ) => {
    const eventId = idFrom(idOrClaim);
    const token = claimTokenFrom(idOrClaim);
    const failedAt = failOptions.failedAt ?? now();
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const baseUpdate = kysely
          .updateTable("channel_ingress_events")
          .set({
            status: "failed",
            failed_at: failedAt,
            failed_reason: failOptions.reason,
            last_error: failOptions.message ?? null,
            payload_json: "null",
            metadata_json: null,
            claim_token: null,
            claim_owner: null,
            claimed_at: null,
            updated_at: failedAt,
          })
          .where("queue_name", "=", queueName)
          .where("event_id", "=", eventId);
        const update =
          token === null
            ? baseUpdate.where("status", "=", "pending")
            : baseUpdate.where("status", "=", "claimed").where("claim_token", "=", token);
        return affectedRows(executeSqliteQuerySync(tx.db, update)) > 0;
      },
      { path: database.path },
    );
  };

  const deleteEntry: ChannelIngressQueue<
    TPayload,
    TMetadata,
    TCompletedMetadata
  >["delete"] = async (idOrRecord) => {
    const eventId = idFrom(idOrRecord);
    const token = claimTokenFrom(idOrRecord);
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        const baseDelete = kysely
          .deleteFrom("channel_ingress_events")
          .where("queue_name", "=", queueName)
          .where("event_id", "=", eventId);
        const deleteQuery =
          token === null
            ? baseDelete.where("status", "=", "pending")
            : baseDelete.where("status", "=", "claimed").where("claim_token", "=", token);
        return affectedRows(executeSqliteQuerySync(tx.db, deleteQuery)) > 0;
      },
      { path: database.path },
    );
  };

  const prune: ChannelIngressQueue<TPayload, TMetadata, TCompletedMetadata>["prune"] = async (
    pruneOptions,
  ) => {
    const current = pruneOptions?.now ?? now();
    const pendingCutoff =
      pruneOptions?.pendingTtlMs === undefined ? null : current - pruneOptions.pendingTtlMs;
    const completedCutoff =
      pruneOptions?.completedTtlMs === undefined ? null : current - pruneOptions.completedTtlMs;
    const failedCutoff =
      pruneOptions?.failedTtlMs === undefined ? null : current - pruneOptions.failedTtlMs;
    const pendingMaxEntries = normalizeMaxEntries(pruneOptions?.pendingMaxEntries);
    const completedMaxEntries = normalizeMaxEntries(pruneOptions?.completedMaxEntries);
    const failedMaxEntries = normalizeMaxEntries(pruneOptions?.failedMaxEntries);
    const protectIds = normalizedProtectedIds(pruneOptions?.protectIds);
    if (
      pendingCutoff === null &&
      completedCutoff === null &&
      failedCutoff === null &&
      pendingMaxEntries === null &&
      completedMaxEntries === null &&
      failedMaxEntries === null
    ) {
      return 0;
    }
    const database = openStateDatabase(options.stateDir);
    return runOpenClawStateWriteTransaction(
      (tx) => {
        const kysely = getChannelIngressKysely(tx.db);
        let deleted = 0;
        if (pendingCutoff !== null) {
          let deleteQuery = kysely
            .deleteFrom("channel_ingress_events")
            .where("queue_name", "=", queueName)
            .where("status", "=", "pending")
            .where("updated_at", "<", pendingCutoff);
          if (protectIds.length > 0) {
            deleteQuery = deleteQuery.where("event_id", "not in", protectIds);
          }
          deleted += affectedRows(executeSqliteQuerySync(tx.db, deleteQuery));
        }
        if (completedCutoff !== null) {
          let deleteQuery = kysely
            .deleteFrom("channel_ingress_events")
            .where("queue_name", "=", queueName)
            .where("status", "=", "completed")
            .where("completed_at", "<", completedCutoff);
          if (protectIds.length > 0) {
            deleteQuery = deleteQuery.where("event_id", "not in", protectIds);
          }
          deleted += affectedRows(executeSqliteQuerySync(tx.db, deleteQuery));
        }
        if (failedCutoff !== null) {
          let deleteQuery = kysely
            .deleteFrom("channel_ingress_events")
            .where("queue_name", "=", queueName)
            .where("status", "=", "failed")
            .where("failed_at", "<", failedCutoff);
          if (protectIds.length > 0) {
            deleteQuery = deleteQuery.where("event_id", "not in", protectIds);
          }
          deleted += affectedRows(executeSqliteQuerySync(tx.db, deleteQuery));
        }
        const pruneMaxEntries = (status: string, maxEntries: number | null) => {
          if (maxEntries === null) {
            return;
          }
          const batchSize = 500;
          const protectedSet = new Set(protectIds);
          while (true) {
            const rowsToDelete = executeSqliteQuerySync(
              tx.db,
              kysely
                .selectFrom("channel_ingress_events")
                .select("event_id")
                .where("queue_name", "=", queueName)
                .where("status", "=", status)
                .orderBy("updated_at", "desc")
                .orderBy("event_id", "desc")
                .limit(maxEntries + batchSize),
            ).rows.slice(maxEntries);
            const ids = rowsToDelete
              .map((row) => row.event_id)
              .filter((id) => !protectedSet.has(id));
            if (ids.length === 0) {
              return;
            }
            deleted += affectedRows(
              executeSqliteQuerySync(
                tx.db,
                kysely
                  .deleteFrom("channel_ingress_events")
                  .where("queue_name", "=", queueName)
                  .where("status", "=", status)
                  .where("event_id", "in", ids),
              ),
            );
          }
        };
        pruneMaxEntries("pending", pendingMaxEntries);
        pruneMaxEntries("completed", completedMaxEntries);
        pruneMaxEntries("failed", failedMaxEntries);
        return deleted;
      },
      { path: database.path },
    );
  };

  return {
    enqueue,
    listPending,
    listClaims,
    claimNext,
    claim,
    refreshClaim,
    complete,
    release,
    fail,
    delete: deleteEntry,
    recoverStaleClaims,
    prune,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
