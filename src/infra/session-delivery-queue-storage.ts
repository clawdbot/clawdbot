// Persists queued session deliveries for retry and recovery.
import { z } from "zod";
import type { SourceReplyDeliveryMode } from "../auto-reply/source-reply-delivery-mode.types.js";
import type { ChatType } from "../channels/chat-type.js";
import type { SessionPostCompactionDelegate } from "../config/sessions/types.js";
import type { InputProvenance } from "../sessions/input-provenance.js";
import {
  parseInlineAttachmentMountPath,
  type InlineAttachment,
  type InlineAttachmentMount,
} from "../shared/inline-attachments.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { openOpenClawStateDatabase } from "../state/openclaw-state-db.js";
import { sha256Hex } from "./crypto-digest.js";
import {
  completeDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  getDeliveryQueueEntryStatus,
  loadDeliveryQueueEntryResult,
  loadDeliveryQueueEntryResults,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueCompletionRetention,
  type DeliveryQueueEntryLoadResult,
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

type QueuedSessionDeliveryCommonMetadata = Omit<
  QueuedSessionDeliveryPayloadMetadata,
  "attachments"
>;

/**
 * Durable payloads whose metadata can contain only descriptor references.
 * Inline attachment bytes are deliberately excluded from generic delivery
 * records: they are accepted only by the post-compaction handoff below.
 */
type QueuedSessionDeliveryGenericPayload =
  | ({
      kind: "systemEvent";
      sessionKey: string;
      text: string;
      deliveryContext?: SessionDeliveryContext;
      idempotencyKey?: string;
    } & QueuedSessionDeliveryPayloadMetadata)
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
    } & QueuedSessionDeliveryPayloadMetadata);

/**
 * The sole durable queue payload permitted to retain raw inline attachments.
 * It is consumed at the post-compaction seam and must not be widened into the
 * generic system-event/agent-turn metadata contract.
 */
type QueuedPostCompactionDelegatePayload = {
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
  attachments?: InlineAttachment[];
  attachAs?: InlineAttachmentMount;
  sourceFlowId?: string;
  sourceExpectedRevision?: number;
  deliveryContext?: SessionDeliveryContext;
  idempotencyKey?: string;
} & QueuedSessionDeliveryCommonMetadata;

export type QueuedSessionDeliveryPayload = (
  | QueuedSessionDeliveryGenericPayload
  | QueuedPostCompactionDelegatePayload
) &
  SessionDeliveryRetryPolicy;

export type QueuedSessionDeliveryPayloadWithRetry = QueuedSessionDeliveryPayload &
  SessionDeliveryRetryPolicy;

export type QueuedSessionDelivery = QueuedSessionDeliveryPayloadWithRetry & {
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
};

const QueuedInlineAttachmentSchema = z
  .object({
    name: z.string(),
    content: z.string(),
    encoding: z.enum(["utf8", "base64"]).optional(),
    mimeType: z.string().optional(),
  })
  .strict();

const QueuedInlineAttachmentMountSchema = z
  .object({
    mountPath: z.string().optional(),
  })
  .strict()
  .transform((mount, ctx) => {
    const parsed = parseInlineAttachmentMountPath(mount.mountPath);
    if (parsed.status === "invalid") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "invalid attachment mount path",
      });
      return z.NEVER;
    }
    return parsed.status === "valid" ? { mountPath: parsed.mountPath } : undefined;
  });

const QueuedPostCompactionDelegateSchema = z
  .object({
    kind: z.literal("postCompactionDelegate"),
    sessionKey: z.string().min(1),
    task: z.string(),
    createdAt: z.number(),
    firstArmedAt: z.number().optional(),
    silent: z.boolean().optional(),
    silentWake: z.boolean().optional(),
    targetSessionKey: z.string().optional(),
    targetSessionKeys: z.array(z.string()).optional(),
    fanoutMode: z.enum(["tree", "all"]).optional(),
    model: z.string().optional(),
    attachments: z
      .array(QueuedInlineAttachmentSchema)
      .max(50)
      .transform((attachments) => (attachments.length > 0 ? attachments : undefined))
      .optional(),
    attachAs: QueuedInlineAttachmentMountSchema.optional(),
    sourceFlowId: z.string().optional(),
    sourceExpectedRevision: z.number().int().optional(),
    deliveryContext: z
      .object({
        channel: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().optional(),
        threadId: z.union([z.string(), z.number()]).optional(),
      })
      .strict()
      .optional(),
    idempotencyKey: z.string().optional(),
    traceparent: z.string().optional(),
    traceparentProvenance: z.literal("internal").optional(),
    maxRetries: z.number().optional(),
    completionRetention: z.literal("permanent").optional(),
    id: z.string().min(1),
    enqueuedAt: z.number(),
    retryCount: z.number(),
    agentRunAttempt: z.number().optional(),
    lastChargedAgentRunAttempt: z.number().optional(),
    lastAttemptAt: z.number().optional(),
    lastError: z.string().optional(),
    deliveryStartedAt: z.number().optional(),
    acknowledgedAt: z.number().optional(),
    settlementOutcome: z.enum(["recovered", "moved-to-failed"]).optional(),
    availableAt: z.number().optional(),
  })
  .passthrough();

const INVALID_POST_COMPACTION_DELIVERY_JSON =
  "invalid postCompactionDelegate delivery payload: invalid JSON";
const INVALID_POST_COMPACTION_DELIVERY_SHAPE =
  "invalid postCompactionDelegate delivery payload: invalid shape";

function failInvalidPostCompactionDelivery(params: {
  entry: { id: string; enqueuedAt: number; retryCount: number };
  error: string;
  stateDir?: string;
}): void {
  failPendingDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    id: params.entry.id,
    expectedStatus: "pending",
    lastError: params.error,
    entry: {
      id: params.entry.id,
      enqueuedAt: params.entry.enqueuedAt,
      retryCount: params.entry.retryCount,
    },
    stateDir: params.stateDir,
  });
}

function decodeLoadedSessionDelivery(
  result: Extract<DeliveryQueueEntryLoadResult, { status: "loaded" }>,
  stateDir?: string,
): QueuedSessionDelivery | null {
  const item = result.entry as typeof result.entry & { kind?: unknown };
  const isPostCompaction =
    result.entryKind === "postCompactionDelegate" || item.kind === "postCompactionDelegate";
  if (!isPostCompaction) {
    return result.entry as QueuedSessionDelivery;
  }
  const parsed = QueuedPostCompactionDelegateSchema.safeParse(result.entry);
  if (parsed.success) {
    return parsed.data as QueuedSessionDelivery;
  }
  failInvalidPostCompactionDelivery({
    entry: result.entry,
    error: INVALID_POST_COMPACTION_DELIVERY_SHAPE,
    stateDir,
  });
  return null;
}

function decodeSessionDeliveryResult(
  result: DeliveryQueueEntryLoadResult,
  stateDir?: string,
): QueuedSessionDelivery | null {
  if (result.status === "loaded") {
    return decodeLoadedSessionDelivery(result, stateDir);
  }
  if (result.entry.entryKind === "postCompactionDelegate") {
    failInvalidPostCompactionDelivery({
      entry: result.entry,
      error: INVALID_POST_COMPACTION_DELIVERY_JSON,
      stateDir,
    });
  }
  return null;
}

function normalizeSessionDeliveryForPersistence(
  entry: QueuedSessionDelivery,
): QueuedSessionDelivery {
  if (entry.kind !== "postCompactionDelegate") {
    return entry;
  }
  const parsed = QueuedPostCompactionDelegateSchema.safeParse(entry);
  if (!parsed.success) {
    throw new Error(INVALID_POST_COMPACTION_DELIVERY_SHAPE);
  }
  return parsed.data as QueuedSessionDelivery;
}

// Strip trailing whitespace per line and at end-of-string before hashing the
// idempotency key, so same-intent keys that differ only by trailing whitespace
// produce the same sha256 taskHash and the replay-dedupe path stays robust.
function canonicalizeIdempotencyKey(key: string): string {
  return key.replace(/[ \t\r\f\v]+(?=\n|$)/g, "").replace(/\s+$/, "");
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
    ...(params.delegate.attachments && params.delegate.attachments.length > 0
      ? { attachments: params.delegate.attachments }
      : {}),
    ...(params.delegate.attachAs ? { attachAs: params.delegate.attachAs } : {}),
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

  const entry = normalizeSessionDeliveryForPersistence({
    ...payload,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
  } as QueuedSessionDelivery);
  upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedSessionDeliveryMetadata(entry),
    stateDir,
    ...(params.completionRetention === "permanent"
      ? { insertOnly: true }
      : { reviveFailedOrCorruptPending: Boolean(params.idempotencyKey) }),
  });
  return id;
}

/** Enqueue a post-compaction delegate through the shared durable queue. */
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
  const id = buildEntryId(params.idempotencyKey);
  const payload = normalizeQueuedTraceparent(params);
  const entry = normalizeSessionDeliveryForPersistence({
    ...payload,
    id,
    enqueuedAt: Date.now(),
    retryCount: 0,
    availableAt: Date.now() + Math.max(0, initialAttemptLeaseMs),
  } as QueuedSessionDelivery);
  const claimed = upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedSessionDeliveryMetadata(entry),
    stateDir,
    insertOnly: true,
  });
  let status: "pending" | "failed" | "completed" | undefined;
  try {
    status = claimed ? "pending" : getDeliveryQueueEntryStatus(QUEUE_NAME, id, stateDir);
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
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => ({
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
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => ({
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
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => {
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
      queueName: QUEUE_NAME,
      entry: {
        ...entry,
        deliveryStartedAt: entry.deliveryStartedAt ?? Date.now(),
      } as QueuedSessionDelivery,
      metadata: queuedSessionDeliveryMetadata(entry),
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
      queueName: QUEUE_NAME,
      entry: {
        ...entry,
        settlementOutcome: outcome,
        ...(outcome === "recovered" ? { acknowledgedAt: entry.acknowledgedAt ?? Date.now() } : {}),
      } as QueuedSessionDelivery,
      metadata: queuedSessionDeliveryMetadata(entry),
      stateDir,
      updatePendingOnly: true,
    });
    if (settled) {
      return;
    }
    if (getDeliveryQueueEntryStatus(QUEUE_NAME, entry.id, stateDir) === "completed") {
      return;
    }
    throw new Error(`Session delivery ${entry.id} is no longer pending`);
  } catch (error) {
    try {
      if (getDeliveryQueueEntryStatus(QUEUE_NAME, entry.id, stateDir) === "completed") {
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
    completeDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
  } catch (error) {
    try {
      if (getDeliveryQueueEntryStatus(QUEUE_NAME, id, stateDir) === "completed") {
        return;
      }
    } catch {
      // Unprovable state remains settlement finalization, never a delivery retry.
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(id, { cause: error });
  }
}

/** Acknowledge a delivered row and retain its completed idempotency tombstone. */
export async function ackSessionDelivery(id: string, stateDir?: string): Promise<void> {
  const entry = await loadPendingSessionDelivery(id, stateDir);
  if (!entry) {
    if (getDeliveryQueueEntryStatus(QUEUE_NAME, id, stateDir) === "completed") {
      return;
    }
    throw new SessionDeliveryAcknowledgementFinalizeError(id);
  }
  await markSessionDeliverySettlement(entry, "recovered", stateDir);
  await completeSessionDelivery(id, stateDir);
}

/** Record a failed delivery attempt and increment retry metadata. */
export async function failSessionDelivery(
  id: string,
  error: string,
  stateDir?: string,
  options?: { releaseAttemptOwnership?: boolean },
): Promise<void> {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => {
    const queued = entry as QueuedSessionDelivery;
    return {
      ...queued,
      retryCount: queued.retryCount + 1,
      ...(queued.kind === "agentTurn"
        ? { lastChargedAgentRunAttempt: queued.agentRunAttempt ?? 0 }
        : {}),
      ...(options?.releaseAttemptOwnership === true ? { deliveryStartedAt: undefined } : {}),
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
  const result = loadDeliveryQueueEntryResult(QUEUE_NAME, id, stateDir);
  return result ? decodeSessionDeliveryResult(result, stateDir) : null;
}

/** Load all pending session deliveries in retry order. */
export async function loadPendingSessionDeliveries(
  stateDir?: string,
): Promise<QueuedSessionDelivery[]> {
  return loadDeliveryQueueEntryResults(QUEUE_NAME, stateDir).flatMap((result) => {
    const entry = decodeSessionDeliveryResult(result, stateDir);
    return entry ? [entry] : [];
  });
}

/** Move an exhausted session delivery out of the pending queue. */
export async function moveSessionDeliveryToFailed(id: string, stateDir?: string): Promise<void> {
  try {
    moveDeliveryQueueEntryToFailed(QUEUE_NAME, id, stateDir);
  } catch (error) {
    try {
      if (getDeliveryQueueEntryStatus(QUEUE_NAME, id, stateDir) === "failed") {
        return;
      }
    } catch {
      // Preserve the original transition failure when durable state is unreadable.
    }
    throw error;
  }
}
