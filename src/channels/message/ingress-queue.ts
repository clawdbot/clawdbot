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
export function createStateDirEnv(
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

function parseJson(value: string): unknown {
  return JSON.parse(value);
}

function baseRecord<TPayload, TMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueRecord<TPayload, TMetadata> {
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    payload: parseJson(row.payload_json) as TPayload,
    ...(row.metadata_json === null ? {} : { metadata: parseJson(row.metadata_json) as TMetadata }),
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
): ChannelIngressQueueClaim<TPayload, TMetadata> {
  return {
    ...baseRecord<TPayload, TMetadata>(row),
    claim: {
      token: row.claim_token ?? "",
      ownerId: row.claim_owner ?? "",
      claimedAt: row.claimed_at ?? 0,
    },
  };
}

function completedRecord<TCompletedMetadata>(
  row: ChannelIngressRow,
): ChannelIngressQueueCompletedRecord<TCompletedMetadata> {
  return {
    id: row.event_id,
    channelId: row.channel_id,
    accountId: row.account_id,
    queueName: row.queue_name,
    completedAt: row.completed_at ?? row.updated_at,
    ...(row.completed_metadata_json === null
      ? {}
      : { metadata: parseJson(row.completed_metadata_json) as TCompletedMetadata }),
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
): ChannelIngressQueueEnqueueResult<TPayload, TMetadata, TCompletedMetadata> {
  if (row.status === "completed") {
    return { kind: "completed", duplicate: true, record: completedRecord(row) };
  }
  if (row.status === "failed") {
    return { kind: "failed", duplicate: true, record: failedRecord(row) };
  }
  if (row.status === "claimed") {
    return { kind: "claimed", duplicate: true, record: claimedRecord(row) };
  }
  return { kind: "pending", duplicate: true, record: baseRecord(row) };
}

function normalizeLimit(limit: number | "all" | undefined): number {
  return limit === "all" ? Number.MAX_SAFE_INTEGER : Math.max(1, Math.floor(limit ?? 100));
}

function normalizeScanLimit(limit: number | undefined): number {
  return Math.max(1, Math.floor(limit ?? 100));
}

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
          return {
            kind: "accepted",
            duplicate: false,
            record: baseRecord<TPayload, TMetadata>(row),
          };
        }
        return rowToEnqueueResult<TPayload, TMetadata, TCompletedMetadata>(row);
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
    const baseQuery = kysely
      .selectFrom("channel_ingress_events")
      .selectAll()
      .where("queue_name", "=", queueName)
      .where("status", "=", "pending")
      .limit(normalizeLimit(listOptions?.limit));
    const query =
      listOptions?.orderBy === "id"
        ? baseQuery.orderBy("event_id", "asc")
        : baseQuery.orderBy("received_at", "asc").orderBy("event_id", "asc");
    const rows = executeSqliteQuerySync(db, query).rows;
    return rows.map((row) => baseRecord<TPayload, TMetadata>(row));
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
    return rows.map((row) => claimedRecord<TPayload, TMetadata>(row));
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
            .map((row) => row.lane_key ?? claimOptions?.deriveLaneKey?.(baseRecord(row)))
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
        orderedSelect =
          claimOptions?.deriveLaneKey === undefined
            ? orderedSelect.limit(1)
            : orderedSelect.limit(normalizeScanLimit(claimOptions.scanLimit));
        const rows = executeSqliteQuerySync(tx.db, orderedSelect).rows;
        const selected = rows.find((row) => {
          const laneKey = row.lane_key ?? claimOptions?.deriveLaneKey?.(baseRecord(row));
          return !laneKey || !effectiveBlocked.has(laneKey);
        });
        if (!selected) {
          return null;
        }
        const derivedLaneKey =
          selected.lane_key ?? claimOptions?.deriveLaneKey?.(baseRecord(selected));
        const token = randomUUID();
        const claimedAt = now();
        const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "claimed",
              claim_token: token,
              claim_owner: ownerId,
              claimed_at: claimedAt,
              ...(derivedLaneKey ? { lane_key: derivedLaneKey } : {}),
              updated_at: claimedAt,
            })
            .where("queue_name", "=", queueName)
            .where("event_id", "=", selected.event_id)
            .where("status", "=", "pending"),
        );
        if (affectedRows(result) === 0) {
          return null;
        }
        const row = selectRow(tx.db, queueName, selected.event_id);
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
        const token = randomUUID();
        const claimedAt = now();
        const ownerId = normalizePart(claimOptions?.ownerId, `${process.pid}`);
        const result = executeSqliteQuerySync(
          tx.db,
          kysely
            .updateTable("channel_ingress_events")
            .set({
              status: "claimed",
              claim_token: token,
              claim_owner: ownerId,
              claimed_at: claimedAt,
              updated_at: claimedAt,
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
    const staleClaims = (await listClaims()).filter((claimed) => claimed.claim.claimedAt <= cutoff);
    let recovered = 0;
    for (const staleClaim of staleClaims) {
      if (recoverOptions?.shouldRecover && !(await recoverOptions.shouldRecover(staleClaim))) {
        continue;
      }
      if (await releaseClaimIfStillStale(staleClaim, { cutoff, releasedAt: current })) {
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
