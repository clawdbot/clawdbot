import type { DeliveryFailureResubmitReason } from "../../packages/gateway-protocol/src/index.js";
import { computeBackoff } from "../../packages/retry/src/index.js";
// Persists queued session deliveries for retry and recovery.
import type { SourceReplyDeliveryMode } from "../auto-reply/source-reply-delivery-mode.types.js";
import type { ChatType } from "../channels/chat-type.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { sha256Hex } from "./crypto-digest.js";
import { compactFailedDeliveryQueueEntry } from "./delivery-queue-failures.js";
import {
  completeDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  loadDeliveryQueueEntryAnyStatus,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueCompletionRetention,
} from "./delivery-queue-sqlite.js";
import type {
  DeliveryQueueFailureRetention,
  DeliveryQueueTerminalPolicy,
  DeliveryQueueTerminalReason,
} from "./delivery-queue-sqlite.types.js";
import {
  classifySessionFailureReplay,
  deliveryTerminalFence,
  SUBAGENT_COMPLETION_DETAIL_RETENTION_MS,
} from "./delivery-queue-terminal-policy.js";
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
  terminalPolicy?: DeliveryQueueTerminalPolicy;
  failureRetention?: DeliveryQueueFailureRetention;
};

export function prepareClaimedSessionDelivery(
  params: QueuedSessionDeliveryPayload,
  initialAttemptLeaseMs: number,
  now = Date.now(),
): QueuedSessionDelivery {
  return {
    ...params,
    failureRetention: "permanent",
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

class SessionDeliveryProducerRevivalError extends Error {
  readonly code = "SESSION_DELIVERY_REVIVAL_FAILED";
  override name = "SessionDeliveryProducerRevivalError";

  constructor(
    id: string,
    readonly reason: DeliveryFailureResubmitReason,
  ) {
    super(
      `Session delivery ${id} could not replace failed ownership: ${producerRevivalMessage(reason)}`,
    );
  }
}

function producerRevivalMessage(reason: DeliveryFailureResubmitReason): string {
  switch (reason) {
    case "ambiguous":
      return "delivery side effects are ambiguous";
    case "compacted":
      return "sensitive delivery detail was compacted";
    case "owner_managed":
      return "recovery is owner-managed";
    case "fenced":
      return "failed ownership is retained by its authored fence";
    case "ownership_changed":
      return "ownership changed during replacement";
    default:
      return "entry cannot be replaced";
  }
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
    failureRetention: params.completionRetention ?? "none",
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  };
  const inserted = upsertDeliveryQueueEntry({
    queueName: SESSION_DELIVERY_QUEUE_NAME,
    entry,
    stateDir,
    insertOnly: true,
  });
  if (!inserted && params.idempotencyKey && params.completionRetention !== "permanent") {
    const revival = replaceFailedSessionDelivery(id, entry, "producer", stateDir);
    if (!revival.ok) {
      throw new SessionDeliveryProducerRevivalError(id, revival.reason);
    }
  }
  return id;
}

type SessionDeliveryResubmitResult =
  | { ok: true }
  | { ok: false; reason: DeliveryFailureResubmitReason };

function replaceFailedSessionDelivery(
  id: string,
  replacement: QueuedSessionDelivery,
  mode: "operator" | "producer",
  stateDir?: string,
  expected?: QueuedSessionDelivery,
): SessionDeliveryResubmitResult {
  return runOpenClawStateWriteTransaction(
    () => {
      const status = getDeliveryQueueEntryStatus(SESSION_DELIVERY_QUEUE_NAME, id, stateDir);
      const current = loadDeliveryQueueEntryAnyStatus(
        SESSION_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
      ) as QueuedSessionDelivery | null;
      if (mode === "producer") {
        if (status === "completed" || (status === "pending" && current)) {
          return { ok: true };
        }
        if (status === "failed") {
          const replay = classifySessionFailureReplay(current, id);
          if (!replay.ok) {
            return replay;
          }
        }
        const replaceable =
          status === "failed" ||
          ((status === "pending" || status === undefined) && current === null);
        if (!replaceable) {
          return { ok: false, reason: status === undefined ? "ownership_changed" : "not_failed" };
        }
      } else if (status !== "failed") {
        return { ok: false, reason: "not_failed" };
      } else {
        if (expected && JSON.stringify(current) !== JSON.stringify(expected)) {
          return { ok: false, reason: "ownership_changed" };
        }
        const replay = classifySessionFailureReplay(current, id);
        if (!replay.ok) {
          return replay;
        }
        if (replay.source !== "canonical") {
          return { ok: false, reason: "legacy_unknown" };
        }
      }
      const revived = upsertDeliveryQueueEntry({
        queueName: SESSION_DELIVERY_QUEUE_NAME,
        entry: replacement,
        stateDir,
        reviveFailedOrCorruptPending: true,
      });
      if (!revived) {
        return { ok: false, reason: "ownership_changed" };
      }
      return { ok: true };
    },
    { env: stateDir ? { ...process.env, OPENCLAW_STATE_DIR: stateDir } : process.env },
    { operationLabel: `${mode} session delivery replacement` },
  );
}

/** Validates and atomically resubmits one ownerless, pre-side-effect session failure. */
export async function resubmitSessionDelivery(
  id: string,
  stateDir?: string,
): Promise<SessionDeliveryResubmitResult> {
  const current = loadDeliveryQueueEntryAnyStatus(
    SESSION_DELIVERY_QUEUE_NAME,
    id,
    stateDir,
  ) as QueuedSessionDelivery | null;
  if (!current) {
    return { ok: false, reason: "not_found" };
  }
  const {
    terminalPolicy: _terminalPolicy,
    lastError: _lastError,
    lastAttemptAt: _lastAttemptAt,
    deliveryStartedAt: _deliveryStartedAt,
    settlementOutcome: _settlementOutcome,
    acknowledgedAt: _acknowledgedAt,
    availableAt: _availableAt,
    ...payload
  } = current;
  return replaceFailedSessionDelivery(
    id,
    { ...payload, enqueuedAt: Date.now(), retryCount: 0 },
    "operator",
    stateDir,
    current,
  );
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
    const entry = (await loadPendingSessionDelivery(id, stateDir)) as QueuedSessionDelivery | null;
    if (!entry) {
      throw new Error(`No pending session delivery queue entry ${id}`);
    }
    const ownerManaged = entry.kind === "agentTurn" && entry.owner?.kind === "subagent_completion";
    const settlementOutcome = entry.settlementOutcome;
    const replay = ownerManaged
      ? "owner-managed"
      : entry.deliveryStartedAt !== undefined ||
          settlementOutcome !== undefined ||
          entry.acknowledgedAt !== undefined
        ? "ambiguous"
        : "safe";
    const failureRetention = entry.failureRetention ?? entry.completionRetention;
    const authoredFence = deliveryTerminalFence(
      failureRetention === "none" ? undefined : failureRetention,
    );
    const terminalPolicy: DeliveryQueueTerminalPolicy = {
      version: 1,
      detail: "full",
      replay,
      fence: ownerManaged && authoredFence.kind === "none" ? { kind: "permanent" } : authoredFence,
      reason: (ownerManaged
        ? Date.now() >= entry.owner!.deadlineAt
          ? "owner_expired"
          : "owner_settled"
        : "retry_exhausted") satisfies DeliveryQueueTerminalReason,
      payload: "present",
      cleanup: "complete",
      evidence: ownerManaged
        ? "owner_managed"
        : settlementOutcome !== undefined || entry.acknowledgedAt !== undefined
          ? "settled"
          : entry.deliveryStartedAt !== undefined
            ? "delivery_started"
            : "pre_side_effect",
      ...(settlementOutcome ? { settlementOutcome } : {}),
      ...(ownerManaged
        ? {
            owner: "subagent_completion" as const,
            detailExpiresAt: Date.now() + SUBAGENT_COMPLETION_DETAIL_RETENTION_MS,
          }
        : {}),
    };
    moveDeliveryQueueEntryToFailed(SESSION_DELIVERY_QUEUE_NAME, id, terminalPolicy, stateDir);
    if (replay === "ambiguous") {
      compactFailedDeliveryQueueEntry({
        queueName: SESSION_DELIVERY_QUEUE_NAME,
        id,
        stateDir,
        policy: terminalPolicy,
      });
    }
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
