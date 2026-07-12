// Persists queued session deliveries for retry and recovery.
import type { ChatType } from "../channels/chat-type.js";
import type { SessionPostCompactionDelegate } from "../config/sessions/types.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  deleteDeliveryQueueEntry,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueRowMetadata,
} from "./delivery-queue-sqlite.js";
import { normalizeDiagnosticTraceparent } from "./diagnostic-trace-context.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { generateSecureUuid } from "./secure-random.js";

// Session delivery queue persists session-scoped messages until channel
// delivery acknowledges them or recovery exhausts retry policy.
const QUEUE_NAME = "session";

/** Default age threshold for purging failed entries (14 days). */
export const DEFAULT_FAILED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

type DeliveryQueueDatabase = Pick<OpenClawStateKyselyDatabase, "delivery_queue_entries">;

function openStateDatabaseForSession(stateDir?: string) {
  return openOpenClawStateDatabase({
    env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env,
  });
}

/**
 * Prune failed session-delivery entries older than maxAgeMs.
 * Returns scanned + removed counts for caller logging.
 */
export async function pruneFailedOlderThan(
  maxAgeMs: number,
  now: number = Date.now(),
  stateDir?: string,
): Promise<{ scanned: number; removed: number }> {
  const cutoff = now - maxAgeMs;
  const database = openStateDatabaseForSession(stateDir);
  const queueDb = getNodeSqliteKysely<DeliveryQueueDatabase>(database.db);
  const scannedRow = executeSqliteQueryTakeFirstSync(
    database.db,
    queueDb
      .selectFrom("delivery_queue_entries")
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("queue_name", "=", QUEUE_NAME)
      .where("status", "=", "failed"),
  ) as { count: number | bigint } | undefined;
  const scanned = scannedRow ? Number(scannedRow.count) : 0;
  const deleteResult = executeSqliteQuerySync(
    database.db,
    queueDb
      .deleteFrom("delivery_queue_entries")
      .where("queue_name", "=", QUEUE_NAME)
      .where("status", "=", "failed")
      .where("failed_at", "<", cutoff),
  );
  const removed = Number(deleteResult.numAffectedRows ?? 0n);
  return { scanned, removed };
}

export type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionDeliveryRetryPolicy = {
  maxRetries?: number;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

/** Payload variants that can be replayed by session delivery recovery. */
export interface AttachmentRef {
  kind: "blob-sha256";
  sha256: string;
  mediaType?: string;
}

type QueuedSessionDeliveryPayloadMetadata = {
  /**
   * W3C trace-context traceparent for chain-correlation runtime. This is the
   * address-recipient shape; broadcast-mode surfaces use the same substrate
   * with a different verb set.
   */
  traceparent?: string;
  /** Runtime-owned provenance marker for post-compaction continuation trace context. */
  traceparentProvenance?: "internal";
  /**
   * Descriptor-stub attachment references for sibling enrichment runtime.
   * This is the address-recipient shape; broadcast mode uses the same substrate
   * with a different verb set.
   */
  attachments?: AttachmentRef[];
};

export type QueuedSessionDeliveryPayload = (
  | {
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
  | {
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      expectedSessionId?: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
  | {
      kind: "postCompactionDelegate";
      sessionKey: string;
      task: string;
      createdAt: number;
      firstArmedAt?: number;
      silent?: boolean;
      silentWake?: boolean;
      targetSessionKey?: string;
      targetSessionKeys?: string[];
      fanoutMode?: "tree" | "all";
      model?: string;
      sourceFlowId?: string;
      sourceExpectedRevision?: number;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    }
) &
  SessionDeliveryRetryPolicy &
  QueuedSessionDeliveryPayloadMetadata;

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
};

// Strip trailing whitespace per line and at end-of-string before hashing the
// idempotency key, so same-intent keys that differ only by trailing whitespace
// produce the same sha256 taskHash and the replay-dedupe path stays robust.
function canonicalizeIdempotencyKey(key: string): string {
  return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(canonicalizeIdempotencyKey(idempotencyKey));
}

function normalizeQueuedTraceparent(
  payload: QueuedSessionDeliveryPayload,
): QueuedSessionDeliveryPayload {
  const normalizedTraceparent =
    payload.kind !== "postCompactionDelegate" || payload.traceparentProvenance === "internal"
      ? normalizeDiagnosticTraceparent(payload.traceparent)
      : undefined;
  const normalizedPayload: QueuedSessionDeliveryPayload = { ...payload };
  if (normalizedTraceparent) {
    normalizedPayload.traceparent = normalizedTraceparent;
    if (payload.kind === "postCompactionDelegate") {
      normalizedPayload.traceparentProvenance = "internal";
    }
  } else {
    delete normalizedPayload.traceparent;
    delete normalizedPayload.traceparentProvenance;
  }
  return normalizedPayload;
}

function buildPostCompactionDelegateIdempotencyKey(params: {
  sessionKey: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
}): string {
  const taskHash = sha256Hex(params.delegate.task).slice(0, 16);
  return [
    "post-compaction-delegate",
    params.sessionKey,
    String(params.compactionCount ?? "unknown"),
    String(params.delegate.firstArmedAt ?? params.delegate.createdAt),
    String(params.sequence),
    taskHash,
  ].join(":");
}

export function buildPostCompactionDelegateDeliveryPayload(params: {
  sessionKey: string;
  delegate: SessionPostCompactionDelegate;
  sequence: number;
  compactionCount?: number;
  deliveryContext?: SessionDeliveryContext;
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  return {
    kind: "postCompactionDelegate",
    sessionKey: params.sessionKey,
    task: params.delegate.task,
    createdAt: params.delegate.createdAt,
    firstArmedAt: params.delegate.firstArmedAt ?? params.delegate.createdAt,
    ...(params.delegate.silent != null ? { silent: params.delegate.silent } : {}),
    ...(params.delegate.silentWake != null ? { silentWake: params.delegate.silentWake } : {}),
    ...(params.delegate.targetSessionKey
      ? { targetSessionKey: params.delegate.targetSessionKey }
      : {}),
    ...(params.delegate.targetSessionKeys && params.delegate.targetSessionKeys.length > 0
      ? { targetSessionKeys: params.delegate.targetSessionKeys }
      : {}),
    ...(params.delegate.fanoutMode ? { fanoutMode: params.delegate.fanoutMode } : {}),
    ...(params.delegate.model ? { model: params.delegate.model } : {}),
    ...(params.delegate.traceparentProvenance === "internal" && params.delegate.traceparent
      ? {
          traceparent: params.delegate.traceparent,
          traceparentProvenance: "internal" as const,
        }
      : {}),
    ...(params.delegate.flowId ? { sourceFlowId: params.delegate.flowId } : {}),
    ...(params.delegate.expectedRevision !== undefined
      ? { sourceExpectedRevision: params.delegate.expectedRevision }
      : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey:
      params.idempotencyKey ??
      buildPostCompactionDelegateIdempotencyKey({
        sessionKey: params.sessionKey,
        delegate: params.delegate,
        sequence: params.sequence,
        compactionCount: params.compactionCount,
      }),
  };
}

function queuedSessionDeliveryMetadata(entry: QueuedSessionDelivery): DeliveryQueueRowMetadata {
  const route = entry.kind === "agentTurn" ? entry.route : undefined;
  return {
    entryKind: entry.kind,
    sessionKey: entry.sessionKey,
    channel: route?.channel ?? entry.deliveryContext?.channel,
    target: route?.to ?? entry.deliveryContext?.to,
    accountId: route?.accountId ?? entry.deliveryContext?.accountId,
  };
}

/** Enqueue a session delivery and return its durable id. */
export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const payload = normalizeQueuedTraceparent(params);
  const id = buildEntryId(payload.idempotencyKey);

  if (payload.idempotencyKey && loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir)) {
    return id;
  }

  const entry: QueuedSessionDelivery = {
    ...payload,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedSessionDeliveryMetadata(entry),
    stateDir,
  });
  return id;
}

/** Acknowledge a successfully delivered session entry. */
export async function enqueuePostCompactionDelegateDelivery(
  params: {
    sessionKey: string;
    delegate: SessionPostCompactionDelegate;
    sequence: number;
    compactionCount?: number;
    deliveryContext?: SessionDeliveryContext;
    idempotencyKey?: string;
  },
  stateDir?: string,
): Promise<string> {
  return await enqueueSessionDelivery(buildPostCompactionDelegateDeliveryPayload(params), stateDir);
}

/** Acknowledge a successfully delivered session entry. */
export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  deleteDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
}

/** Record a failed delivery attempt and increment retry metadata. */
export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => {
    const queued = entry as QueuedSessionDelivery;
    return {
      ...queued,
      retryCount: queued.retryCount + 1,
      lastAttemptAt: Date.now(),
      lastError: error,
    };
  });
}

/** Load one pending session delivery by durable id. */
export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  return loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir) as QueuedSessionDelivery | null;
}

/** Load all pending session deliveries in retry order. */
export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  return loadDeliveryQueueEntries(QUEUE_NAME, stateDir) as QueuedSessionDelivery[];
}

/** Move an exhausted session delivery out of the pending queue. */
export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  moveDeliveryQueueEntryToFailed(QUEUE_NAME, id, stateDir);
}
