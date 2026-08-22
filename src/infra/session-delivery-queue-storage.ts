import { computeBackoff } from "../../packages/retry/src/index.js";
// Persists queued session deliveries for retry and recovery.
import type { ReplyMediaAttachment } from "../auto-reply/reply-payload.js";
import type { SourceReplyDeliveryMode } from "../auto-reply/source-reply-delivery-mode.types.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  completeDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueCompletionRetention,
} from "./delivery-queue-sqlite.js";
import { generateSecureUuid } from "./secure-random.js";

// Session delivery queue persists session-scoped messages until channel
// delivery acknowledges them or recovery exhausts retry policy.
export const SESSION_DELIVERY_QUEUE_NAME = "session";

type SessionDeliveryOwnerReference = {
  kind: "subagent_completion";
  runId: string;
  taskId: string;
  generation: number;
  deadlineAt: number;
};

type SessionDeliveryContext = {
  channel?: string;
  to?: string;
  accountId?: string;
  threadId?: string | number;
};

type SessionDeliveryRetryPolicy = {
  maxRetries?: number;
  /** Retain terminal ownership when the durable producer can replay forever. */
  completionRetention?: DeliveryQueueCompletionRetention;
};

export type SessionDeliveryRoute = {
  channel: string;
  to: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string;
  chatType: ChatType;
};

export type SessionDeliverySettledOutcome = "recovered" | "moved-to-failed";

/** Payload variants that can be replayed by session delivery recovery. */
export type QueuedSessionDeliveryPayload =
  | ({
      kind: "systemEvent";
      sessionKey: string;
      /** Preserves ownership when a durable event targets the literal global session. */
      agentId?: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & SessionDeliveryRetryPolicy)
  | ({
      kind: "agentTurn";
      sessionKey: string;
      message: string;
      messageId: string;
      expectedSessionId?: string;
      route?: SessionDeliveryRoute;
      deliveryContext?: SessionDeliveryContext;
      inputProvenance?: InputProvenance;
      sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
      expectedMediaUrls?: string[];
      expectedMediaAttachments?: Record<string, ReplyMediaAttachment>;
      preparedMediaBlocks?: Record<string, Array<Record<string, unknown>>>;
      suppressTextDelivery?: true;
      idempotencyKey?: string;
      owner?: SessionDeliveryOwnerReference;
    } & SessionDeliveryRetryPolicy);

export type QueuedSessionDelivery = QueuedSessionDeliveryPayload & {
  id: string;
  enqueuedAt: number;
  agentRunAttempt?: number;
  lastChargedAgentRunAttempt?: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  deliveryStartedAt?: number;
  acknowledgedAt?: number;
  settlementOutcome?: SessionDeliverySettledOutcome;
  availableAt?: number;
  retainOnFailure?: true;
};

export function prepareClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  now = Date.now(),
): QueuedSessionDelivery {
  return {
    ...params,
    retainOnFailure: true,
    id: buildEntryId(params.idempotencyKey),
    enqueuedAt: now,
    retryCount: 0,
    availableAt: now + Math.max(0, initialAttemptLeaseMs),
  };
}

export class SessionDeliveryDeferredError extends Error {
  override name = "SessionDeliveryDeferredError";
}

/** Signals that retry budget was already persisted before a later transition failed. */
export class SessionDeliveryRetryChargedError extends Error {
  override name = "SessionDeliveryRetryChargedError";
}

/** Signals that durable pre-delivery ownership could not be established. */
export class SessionDeliveryAttemptStartError extends Error {
  override name = "SessionDeliveryAttemptStartError";
}

/** Signals that delivery proved no external or transcript side effect committed. */
export class SessionDeliverySafeRetryError extends Error {
  override name = "SessionDeliverySafeRetryError";
}

/** Signals that recovery must settle this pending row as failed without replaying delivery. */
export class SessionDeliveryDeadLetteredError extends Error {
  override name = "SessionDeliveryDeadLetteredError";
}

function buildEntryId(idempotencyKey?: string): string {
  if (!idempotencyKey) {
    return generateSecureUuid();
  }
  return sha256Hex(idempotencyKey);
}

/** Enqueue a session delivery and return its durable id. */
export async function enqueueSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const id = buildEntryId(params.idempotencyKey);

  const entry: QueuedSessionDelivery = {
    ...params,
    ...(params.completionRetention === "permanent" ? { retainOnFailure: true as const } : {}),
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  upsertDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    stateDir,
    insertOnly: true,
  });
  return id;
}

/** Enqueue and lease the first attempt to one caller before recovery can see it as eligible. */
export async function enqueueClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  stateDir?: string,
): Promise<{
  id: string;
  claimed: boolean;
  status: "pending" | "failed" | "completed" | "unknown";
}> {
  const entry = prepareClaimedSessionDelivery(params, initialAttemptLeaseMs);
  const id = entry.id;
  const claimed = upsertDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    stateDir,
    insertOnly: true,
  });
  let status: "pending" | "failed" | "completed" | undefined;
  try {
    status = claimed
      ? "pending"
      : getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, stateDir);
  } catch {
    // The insert-only conflict already proved another durable owner existed.
    // Preserve that ownership when diagnostics are temporarily unreadable.
    return { id, claimed, status: "unknown" };
  }
  // Old databases may still delete an acknowledged row between the conflict
  // and lookup. Treat that race like the explicit completed tombstone.
  return { id, claimed, status: status ?? "completed" };
}

/** Release the initial-attempt lease so runtime recovery can retry immediately. */
export async function releaseSessionDeliveryClaim(id: string, stateDir?: string): Promise<void> {
  updateDeliveryQueueEntry(SESSION_DELIVERY_QUEUE_NAME, id, stateDir, (entry) => ({
    ...entry,
    availableAt: Date.now(),
  }));
}

/** Defer a currently owned delivery without consuming its retry budget. */
export async function deferSessionDelivery(
  id: string,
  delayMs: number,
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(SESSION_DELIVERY_QUEUE_NAME, id, stateDir, (entry) => ({
    ...entry,
    availableAt: Date.now() + Math.max(0, delayMs),
  }));
}

/** Advance only after a completed agent turn proves a fresh run is safe. */
export async function advanceSessionDeliveryAgentRun(
  id: string,
  updates?: { expectedMediaUrls?: string[]; message?: string; suppressTextDelivery?: boolean },
  stateDir?: string,
): Promise<void> {
  updateDeliveryQueueEntry(SESSION_DELIVERY_QUEUE_NAME, id, stateDir, (entry) => {
    const queued = entry as QueuedSessionDelivery;
    if (queued.kind !== "agentTurn") {
      return queued;
    }
    return {
      ...queued,
      agentRunAttempt: (queued.agentRunAttempt ?? 0) + 1,
      deliveryStartedAt: undefined,
      ...(updates?.message ? { message: updates.message } : {}),
      ...(updates?.expectedMediaUrls ? { expectedMediaUrls: updates.expectedMediaUrls } : {}),
      ...(updates?.suppressTextDelivery === true ? { suppressTextDelivery: true as const } : {}),
    };
  });
}

/** Preserve one prepared artifact before transcript persistence or retry transitions. */
export async function mergeSessionDeliveryPreparedMediaBlocks(
  id: string,
  mediaUrl: string,
  blocks: Array<Record<string, unknown>>,
  stateDir?: string,
): Promise<Array<Record<string, unknown>>> {
  let retained = blocks;
  updateDeliveryQueueEntry(SESSION_DELIVERY_QUEUE_NAME, id, stateDir, (entry) => {
    // SAFETY: this queue namespace stores only QueuedSessionDelivery payloads.
    const queued = entry as QueuedSessionDelivery;
    if (queued.kind !== "agentTurn") {
      return queued;
    }
    retained = queued.preparedMediaBlocks?.[mediaUrl] ?? blocks;
    return {
      ...queued,
      // The first durable artifact identity wins if the same attempt is replayed.
      preparedMediaBlocks: { ...queued.preparedMediaBlocks, [mediaUrl]: retained },
    };
  });
  return retained;
}

/** Mark an agent turn before it can commit transcript or channel side effects. */
export async function markSessionDeliveryAttemptStarted(
  entry: QueuedSessionDelivery,
  stateDir?: string,
): Promise<void> {
  try {
    const started = upsertDeliveryQueueEntry({
      queueName: SESSION_DELIVERY_QUEUE_NAME,
      entry: {
        ...entry,
        deliveryStartedAt: entry.deliveryStartedAt ?? Date.now(),
      } as QueuedSessionDelivery,
      stateDir,
      updatePendingOnly: true,
    });
    if (!started) {
      throw new Error(`Session delivery ${entry.id} is no longer pending`);
    }
  } catch (error) {
    throw new SessionDeliveryAttemptStartError(
      `Session delivery ${entry.id} could not persist attempt ownership`,
      { cause: error },
    );
  }
}

/** Signals that a delivered result still needs durable settlement finalization. */
export class SessionDeliveryAcknowledgementFinalizeError extends Error {
  constructor(id: string, options?: ErrorOptions) {
    super(`Session delivery ${id} still needs settlement finalization`, options);
    this.name = "SessionDeliveryAcknowledgementFinalizeError";
  }
}

/** Persist terminal delivery state while retaining settlement cleanup metadata. */
export async function markSessionDeliverySettlement(
  entry: QueuedSessionDelivery,
  outcome: SessionDeliverySettledOutcome,
  stateDir?: string,
): Promise<void> {
  try {
    const settled = upsertDeliveryQueueEntry({
      queueName: SESSION_DELIVERY_QUEUE_NAME,
      entry: {
        ...entry,
        settlementOutcome: outcome,
        ...(outcome === "recovered" ? { acknowledgedAt: entry.acknowledgedAt ?? Date.now() } : {}),
      } as QueuedSessionDelivery,
      stateDir,
      updatePendingOnly: true,
    });
    if (settled) {
      return;
    }
    if (
      getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, entry.id, stateDir) === "completed"
    ) {
      return;
    }
    throw new Error(`Session delivery ${entry.id} is no longer pending`);
  } catch (error) {
    try {
      if (
        getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, entry.id, stateDir) === "completed"
      ) {
        return;
      }
    } catch {
      // Unprovable state remains settlement finalization, never a delivery retry.
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(entry.id, { cause: error });
  }
}

/** Replace a settled pending row with its completed idempotency tombstone. */
export async function completeSessionDelivery(id: string, stateDir?: string): Promise<void> {
  try {
    completeDeliveryQueueEntry(SESSION_DELIVERY_QUEUE_NAME, id, stateDir);
  } catch (error) {
    try {
      if (getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, stateDir) === "completed") {
        return;
      }
    } catch {
      // Unprovable state remains settlement finalization, never a delivery retry.
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
}

/** Record a failed delivery attempt and increment retry metadata. */
export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
  options?: { releaseAttemptOwnership?: boolean },
): Promise<void> {
  updateDeliveryQueueEntry(SESSION_DELIVERY_QUEUE_NAME, id, stateDir, (entry) => {
    const queued = entry as QueuedSessionDelivery;
    const retryCount = queued.retryCount + 1;
    const now = Date.now();
    return {
      ...queued,
      retryCount,
      ...(queued.kind === "agentTurn"
        ? { lastChargedAgentRunAttempt: queued.agentRunAttempt ?? 0 }
        : {}),
      ...(options?.releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
      lastAttemptAt: now,
      ...(queued.kind === "agentTurn" && queued.owner?.kind === "subagent_completion"
        ? {
            availableAt:
              now +
              computeBackoff(
                { initialMs: 15_000, factor: 2, maxMs: 5 * 60_000, jitter: 0.2 },
                retryCount,
              ),
          }
        : {}),
      lastError: error,
    };
  });
}

/** Load one pending session delivery by durable id. */
export async function loadPendingSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedSessionDelivery | null> {
  return loadDeliveryQueueEntry(
    SESSION_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedSessionDelivery | null;
}

/** Load all pending session deliveries in retry order. */
export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  return loadDeliveryQueueEntries(SESSION_DELIVERY_QUEUE_NAME, stateDir) as QueuedSessionDelivery[];
}

/** Move an exhausted session delivery out of the pending queue. */
export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  try {
    moveDeliveryQueueEntryToFailed(SESSION_DELIVERY_QUEUE_NAME, id, stateDir);
  } catch (error) {
    try {
      if (getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, stateDir) === "failed") {
        return;
      }
    } catch {
      // Preserve the original transition failure when durable state is unreadable.
    }
    throw error;
  }
}
