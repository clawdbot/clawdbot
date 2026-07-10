// Delivery queue storage persists replayable outbound send intents and tracks
// platform-send recovery state in the shared SQLite queue.
import type { ReplyDispatchKind } from "../../auto-reply/reply/reply-dispatcher.types.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import type { RenderedMessageBatchPlanItem } from "../../channels/message/types.js";
import type { ReplyToMode } from "../../config/types.js";
import type { PluginHookReplyPayloadSendingContext } from "../../plugins/hook-types.js";
import {
  deleteDeliveryQueueEntry,
  failPendingDeliveryQueueEntry,
  loadDeliveryQueueEntries,
  loadDeliveryQueueEntry,
  moveDeliveryQueueEntryToFailed,
  updateDeliveryQueueEntry,
  upsertDeliveryQueueEntry,
  type DeliveryQueueRowMetadata,
} from "../delivery-queue-sqlite.js";
import { generateSecureUuid } from "../secure-random.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { OutboundIdentity } from "./identity.js";
import type { OutboundMirror } from "./mirror.js";
import type { OutboundSessionContext } from "./session-context.js";
import type { OutboundChannel } from "./targets.js";

const QUEUE_NAME = "outbound";

export type QueuedRenderedMessageBatchPlan = {
  payloadCount: number;
  textCount: number;
  mediaCount: number;
  voiceCount: number;
  presentationCount: number;
  interactiveCount: number;
  channelDataCount: number;
  items: readonly RenderedMessageBatchPlanItem[];
};

export type QueuedReplyPayloadSendingHook = {
  kind: ReplyDispatchKind;
  channel?: string;
  sessionKey?: string;
  runId?: string;
  context: PluginHookReplyPayloadSendingContext;
};

export type QueuedDeliveryPayload = {
  channel: Exclude<OutboundChannel, "none">;
  to: string;
  accountId?: string;
  /** Original queue durability policy when known. */
  queuePolicy?: "required" | "best_effort";
  /** Caller preflight explicitly required provider unknown-send reconciliation. */
  requireUnknownSendReconciliation?: boolean;
  /**
   * Original payloads before plugin hooks. On recovery, hooks re-run on these
   * payloads — this is intentional since hooks are stateless transforms and
   * should produce the same result on replay.
   */
  payloads: ReplyPayload[];
  /** Replayable projection summary captured when the durable send intent is created. */
  renderedBatchPlan?: QueuedRenderedMessageBatchPlan;
  threadId?: string | number | null;
  replyToId?: string | null;
  replyToMode?: ReplyToMode;
  formatting?: OutboundDeliveryFormattingOptions;
  identity?: OutboundIdentity;
  bestEffort?: boolean;
  gifPlayback?: boolean;
  forceDocument?: boolean;
  /** Replayable reply payload hook context for recovery and live delivery. */
  replyPayloadSendingHook?: QueuedReplyPayloadSendingHook;
  silent?: boolean;
  mirror?: OutboundMirror;
  /** Session context needed to preserve outbound media policy on recovery. */
  session?: OutboundSessionContext;
  /** Gateway caller scopes at enqueue time, preserved for recovery replay. */
  gatewayClientScopes?: readonly string[];
};

export interface QueuedDelivery extends QueuedDeliveryPayload {
  id: string;
  enqueuedAt: number;
  retryCount: number;
  lastAttemptAt?: number;
  lastError?: string;
  platformSendStartedAt?: number;
  /** Canonical reply target after hooks; null records an intentional root send. */
  effectiveReplyToId?: string | null;
  recoveryState?: "send_attempt_started" | "unknown_after_send";
}

function queuedDeliveryMetadata(entry: QueuedDelivery): DeliveryQueueRowMetadata {
  return {
    entryKind: "outbound",
    sessionKey: entry.session?.key,
    channel: entry.channel,
    target: entry.to,
    accountId: entry.accountId,
  };
}

/** Persist a delivery entry before attempting send. Returns the entry ID. */
export async function enqueueDelivery(
  params: QueuedDeliveryPayload,
  stateDir?: string,
): Promise<string> {
  const id = generateSecureUuid();
  const entry: QueuedDelivery = {
    id,
    enqueuedAt: Date.now(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    queuePolicy: params.queuePolicy,
    requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
    payloads: params.payloads,
    renderedBatchPlan: params.renderedBatchPlan,
    threadId: params.threadId,
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
    formatting: params.formatting,
    identity: params.identity,
    bestEffort: params.bestEffort,
    gifPlayback: params.gifPlayback,
    forceDocument: params.forceDocument,
    replyPayloadSendingHook: params.replyPayloadSendingHook,
    silent: params.silent,
    mirror: params.mirror,
    session: params.session,
    gatewayClientScopes: params.gatewayClientScopes,
    retryCount: 0,
  };
  upsertDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    entry,
    metadata: queuedDeliveryMetadata(entry),
    stateDir,
  });
  return id;
}

/** Remove a successfully delivered entry from the queue. */
export async function ackDelivery(id: string, stateDir?: string): Promise<void> {
  deleteDeliveryQueueEntry(QUEUE_NAME, id, stateDir);
}

/** Update a queue entry after a failed delivery attempt. */
export async function failDelivery(id: string, error: string, stateDir?: string): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
  }));
}

/** Record a failed attempt whose retry provably cannot duplicate a recipient-visible send. */
export async function failDeliveryBeforePlatformSend(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    // Clear both fields together; retaining either would preserve false send evidence.
    platformSendStartedAt: undefined,
    recoveryState: undefined,
  }));
}

/** Record a failed attempt without losing evidence that platform delivery may have completed. */
export async function failDeliveryAfterPlatformSend(
  id: string,
  error: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    retryCount: entry.retryCount + 1,
    lastAttemptAt: Date.now(),
    lastError: error,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    recoveryState: "unknown_after_send",
  }));
}

function updateQueuedDelivery(
  id: string,
  stateDir: string | undefined,
  update: (entry: QueuedDelivery) => QueuedDelivery,
): void {
  updateDeliveryQueueEntry(QUEUE_NAME, id, stateDir, (entry) => update(entry as QueuedDelivery));
}

export async function markDeliveryPlatformSendAttemptStarted(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
  }));
}

/** Refresh the attempt timestamp before recipient-visible or finalizing platform I/O. */
export async function markDeliveryPlatformSendDispatched(
  id: string,
  stateDir?: string,
  route?: { replyToId?: string | null },
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: Date.now(),
    ...(route && "replyToId" in route ? { effectiveReplyToId: route.replyToId ?? null } : {}),
    recoveryState: "send_attempt_started",
  }));
}

export async function markDeliveryPlatformOutcomeUnknown(
  id: string,
  stateDir?: string,
): Promise<void> {
  updateQueuedDelivery(id, stateDir, (entry) => ({
    ...entry,
    platformSendStartedAt: entry.platformSendStartedAt ?? Date.now(),
    recoveryState: "unknown_after_send",
  }));
}

/** Load a single pending delivery entry by ID from the queue directory. */
export async function loadPendingDelivery(
  id: string,
  stateDir?: string,
): Promise<QueuedDelivery | null> {
  return loadDeliveryQueueEntry(QUEUE_NAME, id, stateDir) as QueuedDelivery | null;
}

/** Load all pending delivery entries from the queue. */
export async function loadPendingDeliveries(stateDir?: string): Promise<QueuedDelivery[]> {
  return loadDeliveryQueueEntries(QUEUE_NAME, stateDir) as QueuedDelivery[];
}

/** Move a queue entry out of the pending retry set. */
export async function moveToFailed(id: string, stateDir?: string): Promise<void> {
  moveDeliveryQueueEntryToFailed(QUEUE_NAME, id, stateDir);
}

export type FailPendingDeliveryResult = { status: "failed" } | { status: "not_pending" };

/** Conditionally dead-letter a freshly re-read pending entry without a claimed state. */
export async function failPendingDelivery(
  params: {
    id: string;
    expectedStatus: "pending";
    lastError: string;
    entry: QueuedDelivery;
  },
  stateDir?: string,
): Promise<FailPendingDeliveryResult> {
  return failPendingDeliveryQueueEntry({
    queueName: QUEUE_NAME,
    ...params,
    stateDir,
  });
}
