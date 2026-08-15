// Delivery queue recovery drains pending outbound sends with backoff, crash
// replay protection, unknown-send reconciliation, and failed-entry pruning.
import type {
  ChannelMessageSendCommitContext,
  ChannelMessageUnknownSendReconciliationResult,
} from "../../channels/message/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  createDeliveryRecoveryCoordinator,
  createEmptyDeliveryRecoverySummary,
  findPlatformMessageRejectedError,
  getErrnoCode,
  isDeliveryRecoveryRetryEligible,
  isProvenDeliveryNotSentError,
  resolveDeliveryRecoveryDeadlineMs,
  type ActiveDeliveryRecoveryClaimResult,
  type DeliveryRecoveryDrainDecision,
  type DeliveryRecoverySummary,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { resolveOutboundChannelMessageAdapter } from "./channel-resolution.js";
import { resolveDeferredDeliveryAdmission } from "./deferred-delivery-admission.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import { buildPayloadSummary } from "./deliver-payload.js";
import {
  createQueuedDeliveryOwner,
  persistQueuedPostSendState,
  type QueuedPostSendState,
} from "./deliver-queue-state.js";
import {
  isOutboundDeliveryError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import {
  isOutboundDeliveryResultArray,
  runOutboundDeliveryCommitHooks,
} from "./delivery-commit-hooks.js";
import {
  completeDurableDelivery,
  failDurableDelivery,
  markDurableDeliveryQueued,
  rejectDurableDelivery,
  suppressDurableDelivery,
} from "./delivery-completion.js";
import { collectEntrySpoolPaths, releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
import {
  cancelDeliveryQueueMediaRetention,
  createDeliveryQueueMediaRetention,
} from "./delivery-queue-media-staging.js";
import {
  buildUnknownSendContext,
  reconcileUnknownQueuedDelivery,
} from "./delivery-queue-reconciliation.js";
import {
  claimDeliveryPlatformSendAttempt,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  failPendingDelivery,
  loadPendingDelivery,
  loadPendingDeliveries,
  moveToFailed,
  reserveDeliveryAttempt,
  type QueuedDelivery,
  type QueuedDeliveryPayload,
} from "./delivery-queue-storage.js";
import { createMessageSentEmitter, type MessageSentEvent } from "./message-sent-hook.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export type DeliverFn = (
  params: {
    cfg: OpenClawConfig;
  } & QueuedDeliveryPayload & {
      payloads: ReturnType<typeof queuedDeliveryPayloads>;
      deliveryQueueId?: string;
      deliveryQueueStateDir?: string;
      deliveryProducerClaimId?: string;
      deliveryProducerLeaseRequired?: boolean;
      skipQueue?: boolean;
      deferredDeliveryAdmissionPassed?: true;
      deferCommitHooks?: boolean;
      onMessageSentEvent?: (event: MessageSentEvent, sourceIndex: number) => void;
      onPayloadDeliveryOutcome?: (outcome: OutboundPayloadDeliveryOutcome) => void;
      onDeliveryResult?: (result: OutboundDeliveryResult) => Promise<void> | void;
    },
) => Promise<unknown>;

export interface RecoveryLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

const DEFAULT_MAX_RETRIES = 5;

const PERMANENT_ERROR_PATTERNS: readonly RegExp[] = [
  /no conversation reference found/i,
  /chat not found/i,
  /user not found/i,
  /bot.*not.*member/i,
  /bot was blocked by the user/i,
  /forbidden: bot was kicked/i,
  /chat_id is empty/i,
  /recipient is not a valid/i,
  /outbound not configured for channel/i,
  /ambiguous .* recipient/i,
  /User .* not in room/i,
];

const recoveryCoordinator = createDeliveryRecoveryCoordinator<QueuedDelivery>();

const queuedDeliveryPayloads = (entry: QueuedDelivery) =>
  acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => prepared.payload);

function queuedPayloadCount(entry: QueuedDelivery): number {
  return entry.preparedBatch.sourcePayloadCount;
}

function emitRecoveredMessageSentEvents(
  entry: QueuedDelivery,
  events: readonly MessageSentEvent[],
): void {
  const { emitMessageSent } = createMessageSentEmitter({
    hookRunner: getGlobalHookRunner(),
    channel: entry.channel,
    to: entry.to,
    accountId: entry.accountId,
    sessionKeyForInternalHooks: entry.mirror?.sessionKey ?? entry.session?.key,
    isGroup: entry.mirror?.isGroup,
    groupId: entry.mirror?.groupId,
    runId: entry.preparedBatch.runId,
    logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
  });
  for (const event of events) {
    emitMessageSent(event);
  }
}

type IndexedMessageSentEvent = {
  sourceIndex: number;
  event: MessageSentEvent;
};

function queuedTerminalFailureEvents(
  entry: QueuedDelivery,
  error: string,
): IndexedMessageSentEvent[] {
  return acceptedPreparedOutboundEntries(entry.preparedBatch).map((prepared) => {
    const summary = buildPayloadSummary(prepared.payload);
    return {
      sourceIndex: prepared.sourceIndex,
      event: {
        success: false,
        content: summary.hookContent ?? summary.text,
        error,
      },
    };
  });
}

function emitRecoveredTerminalFailure(
  entry: QueuedDelivery,
  error: string,
  collected: readonly IndexedMessageSentEvent[] = [],
): void {
  if (entry.legacyPreparedContentUnavailable) {
    return;
  }
  const fallbackEvents = queuedTerminalFailureEvents(entry, error);
  // Rendering can suppress an accepted payload before later payloads settle.
  // Reconcile by source index so a gap cannot duplicate or misattribute events.
  const collectedBySourceIndex = new Map(
    collected.map(({ sourceIndex, event }) => [sourceIndex, event] as const),
  );
  const terminalEvents = fallbackEvents.map(
    ({ sourceIndex, event }) => collectedBySourceIndex.get(sourceIndex) ?? event,
  );
  emitRecoveredMessageSentEvents(entry, terminalEvents);
}

function emitRecoveredTerminalSuccess(entry: QueuedDelivery, result: OutboundDeliveryResult): void {
  if (entry.legacyPreparedContentUnavailable) {
    return;
  }
  const preparedEntries = acceptedPreparedOutboundEntries(entry.preparedBatch);
  if (preparedEntries.length === 0) {
    return;
  }
  const receiptMessageIds = result.receipt?.parts.length
    ? result.receipt.parts
        .toSorted((left, right) => left.index - right.index)
        .map((part) => part.platformMessageId)
    : result.receipt?.platformMessageIds;
  const messageIds =
    preparedEntries.length === 1
      ? [result.messageId || receiptMessageIds?.[0]]
      : receiptMessageIds?.length === preparedEntries.length
        ? receiptMessageIds
        : [];
  emitRecoveredMessageSentEvents(
    entry,
    preparedEntries.map((prepared, index) => {
      const summary = buildPayloadSummary(prepared.payload);
      const messageId = messageIds[index];
      const event: MessageSentEvent = {
        success: true,
        content: summary.hookContent ?? summary.text,
      };
      if (messageId) {
        event.messageId = messageId;
      }
      return event;
    }),
  );
}

function resolveMaxRetries(entry: QueuedDelivery): number {
  const configured = entry.maxRetries;
  return typeof configured === "number" && Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_RETRIES;
}

function resolveAttemptCount(entry: QueuedDelivery): number {
  const persisted = entry.attemptCount;
  const attemptCount =
    typeof persisted === "number" && Number.isInteger(persisted) && persisted >= 0 ? persisted : 0;
  return Math.max(attemptCount, entry.retryCount);
}

function emitQueuedAuditTerminals(
  entry: QueuedDelivery,
  terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
): void {
  emitOutboundAuditTerminals({
    context: entry,
    terminals,
    startedAt: entry.enqueuedAt,
    queueId: entry.id,
  });
}

function needsUnknownSendReconciliation(entry: QueuedDelivery): boolean {
  return (
    entry.recoveryState === "send_attempt_started" || entry.recoveryState === "unknown_after_send"
  );
}

function hasActiveDeliveryOwner(entry: QueuedDelivery, now: number): boolean {
  return (
    (typeof entry.completionRetention === "object" ||
      entry.completionRetention === "permanent" ||
      entry.requiresProducerClaim === true) &&
    (entry.recoveryState === "producer_claimed" ||
      ((entry.recoveryState === "send_attempt_started" ||
        entry.recoveryState === "unknown_after_send") &&
        entry.requiresProducerClaim === true)) &&
    typeof entry.availableAt === "number" &&
    entry.availableAt > now
  );
}

function queuedDeadLetterAuditTerminals(entry: QueuedDelivery) {
  if (needsUnknownSendReconciliation(entry)) {
    return uniformOutboundAuditTerminals(queuedPayloadCount(entry), {
      outcome: "unknown",
      failureStage: "queue",
    });
  }
  return uniformOutboundAuditTerminals(queuedPayloadCount(entry), {
    outcome: "failed",
    failureStage: "queue",
  });
}

function queuedUnknownAuditTerminals(entry: QueuedDelivery) {
  return uniformOutboundAuditTerminals(queuedPayloadCount(entry), {
    outcome: "unknown",
    failureStage: "queue",
  });
}

export async function withActiveDeliveryClaim<T>(
  entryId: string,
  fn: () => Promise<T>,
): Promise<ActiveDeliveryRecoveryClaimResult<T>> {
  return recoveryCoordinator.withClaim(entryId, fn);
}

function buildRecoveryDeliverParams(
  entry: QueuedDelivery,
  cfg: OpenClawConfig,
  stateDir?: string,
  producerClaimId?: string,
) {
  return {
    cfg,
    channel: entry.channel,
    to: entry.to,
    accountId: entry.accountId,
    ...(entry.queuePolicy !== undefined ? { queuePolicy: entry.queuePolicy } : {}),
    ...(entry.requireUnknownSendReconciliation === true
      ? { requireUnknownSendReconciliation: true }
      : {}),
    payloads: queuedDeliveryPayloads(entry),
    preparedBatch: entry.preparedBatch,
    renderedBatchPlan: entry.renderedBatchPlan,
    threadId: entry.threadId,
    replyToId: entry.replyToId,
    replyToMode: entry.replyToMode,
    formatting: entry.formatting,
    identity: entry.identity,
    bestEffort: entry.bestEffort,
    gifPlayback: entry.gifPlayback,
    forceDocument: entry.forceDocument,
    silent: entry.silent,
    mirror: entry.mirror,
    session: entry.session,
    gatewayClientScopes: entry.gatewayClientScopes,
    preparedMessageId: entry.preparedMessageId,
    deliveryCompletion: entry.deliveryCompletion,
    deliveryQueueId: entry.id,
    deliveryQueueStateDir: stateDir,
    ...(producerClaimId ? { deliveryProducerClaimId: producerClaimId } : {}),
    ...(entry.requiresProducerClaim === true ? { deliveryProducerLeaseRequired: true } : {}),
    skipQueue: true, // Prevent re-enqueueing during recovery.
    deferredDeliveryAdmissionPassed: true,
    deferCommitHooks: true,
  } satisfies Parameters<DeliverFn>[0];
}

async function terminalizeWithMediaRetention(
  params: { entry: QueuedDelivery; cfg: OpenClawConfig; log: RecoveryLogger; stateDir?: string },
  operation: (spoolPaths: string[]) => Promise<readonly string[] | false>,
): Promise<boolean> {
  const spoolPaths = collectEntrySpoolPaths(queuedDeliveryPayloads(params.entry), params.stateDir);
  const leaseId =
    spoolPaths.length > 0
      ? createDeliveryQueueMediaRetention(
          spoolPaths,
          "outbound-media-recovery-lease",
          params.stateDir,
        )
      : undefined;
  try {
    const releasedPaths = await operation(spoolPaths);
    if (releasedPaths === false) {
      return false;
    }
    if (needsUnknownSendReconciliation(params.entry)) {
      const cleanup = resolveOutboundChannelMessageAdapter({
        channel: params.entry.channel,
        cfg: params.cfg,
        agentId: params.entry.session?.agentId,
        allowBootstrap: true,
      })?.durableFinal?.afterUnknownSendTerminal;
      try {
        await cleanup?.(
          buildUnknownSendContext({
            entry: params.entry,
            payloads: queuedDeliveryPayloads(params.entry),
            cfg: params.cfg,
          }),
        );
      } catch (error) {
        params.log.warn(
          `Delivery entry ${params.entry.id} unknown-send terminal cleanup failed: ${formatErrorMessage(error)}`,
        );
      }
    }
    await releaseSpoolArtifacts(releasedPaths, params.stateDir);
    return true;
  } finally {
    cancelDeliveryQueueMediaRetention(leaseId, params.stateDir);
  }
}

async function applyRecoveryDeliveryAdmission(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  logLabel: string;
}): Promise<"allowed" | "failed" | "not_pending"> {
  const admission = resolveDeferredDeliveryAdmission(
    {
      cfg: params.cfg,
      channel: params.entry.channel,
      to: params.entry.to,
      accountId: params.entry.accountId,
      phase: "recovery",
    },
    { agentId: params.entry.session?.agentId },
  );
  if (admission.status === "allowed") {
    return "allowed";
  }
  await markDurableDeliveryFailedBestEffort(params.entry, params.log, params.stateDir);
  const failed = await terminalizeWithMediaRetention(params, async (spoolPaths) => {
    const result = await failPendingDelivery(
      { id: params.entry.id, entry: params.entry, retainSpoolArtifacts: true },
      params.stateDir,
    );
    return result.status === "failed" ? spoolPaths : false;
  });
  if (!failed) {
    params.log.info(
      `${params.logLabel}: entry ${params.entry.id} changed status before admission failure was persisted`,
    );
    return "not_pending";
  }
  emitRecoveredTerminalFailure(params.entry, admission.reason);
  emitQueuedAuditTerminals(params.entry, () => queuedDeadLetterAuditTerminals(params.entry));
  params.log.warn(
    `${params.logLabel}: entry ${params.entry.id} permanently rejected before recovery: ${admission.reason}`,
  );
  return "failed";
}

async function moveEntryToFailedAndCleanup(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  attemptId?: string | null;
}): Promise<void> {
  await terminalizeWithMediaRetention(params, async () =>
    params.attemptId !== undefined
      ? moveToFailed(params.entry.id, params.stateDir, params.attemptId)
      : moveToFailed(params.entry.id, params.stateDir),
  );
}

function buildReconciledSentResult(
  entry: QueuedDelivery,
  reconciliation: Extract<ChannelMessageUnknownSendReconciliationResult, { status: "sent" }>,
): OutboundDeliveryResult {
  return {
    channel: entry.channel,
    messageId:
      reconciliation.messageId ??
      reconciliation.receipt.primaryPlatformMessageId ??
      reconciliation.receipt.platformMessageIds[0] ??
      "",
    receipt: reconciliation.receipt,
  };
}

function buildReconciledCommitContext(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  result: OutboundDeliveryResult;
}): ChannelMessageSendCommitContext {
  const payload = queuedDeliveryPayloads(params.entry)[0] ?? {};
  const result = {
    messageId: params.result.messageId,
    receipt: params.result.receipt ?? {
      platformMessageIds: [params.result.messageId].filter(Boolean),
      parts: [],
      sentAt: Date.now(),
    },
  };
  const base = {
    cfg: params.cfg,
    to: params.entry.to,
    deliveryQueueId: params.entry.id,
    accountId: params.entry.accountId,
    replyToId:
      params.entry.effectiveReplyToId !== undefined
        ? params.entry.effectiveReplyToId
        : params.entry.replyToId,
    replyToMode: params.entry.replyToMode,
    threadId: params.entry.threadId,
    silent: params.entry.silent,
    result,
  };
  if (
    payload.presentation !== undefined ||
    payload.delivery !== undefined ||
    payload.interactive !== undefined ||
    (payload.channelData !== undefined && Object.keys(payload.channelData).length > 0)
  ) {
    return {
      ...base,
      kind: "payload",
      text: payload.text ?? "",
      mediaUrl: payload.mediaUrl,
      payload,
    };
  }
  const mediaUrl = payload.mediaUrl ?? payload.mediaUrls?.find((url) => url);
  if (mediaUrl) {
    return {
      ...base,
      kind: "media",
      text: payload.text ?? "",
      mediaUrl,
      audioAsVoice: payload.audioAsVoice,
      gifPlayback: params.entry.gifPlayback,
      forceDocument: params.entry.forceDocument,
    };
  }
  return {
    ...base,
    kind: "text",
    text: payload.text ?? "",
  };
}

async function runReconciledSentCommitHooks(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  reconciliation: Extract<ChannelMessageUnknownSendReconciliationResult, { status: "sent" }>;
  log: RecoveryLogger;
}): Promise<void> {
  if (params.entry.legacyPreparedContentUnavailable) {
    return;
  }
  const adapter = resolveOutboundChannelMessageAdapter({
    channel: params.entry.channel,
    cfg: params.cfg,
    agentId: params.entry.session?.agentId,
    allowBootstrap: true,
  });
  const afterCommit = adapter?.send?.lifecycle?.afterCommit;
  if (!afterCommit) {
    return;
  }
  const result = buildReconciledSentResult(params.entry, params.reconciliation);
  try {
    await afterCommit(
      buildReconciledCommitContext({
        entry: params.entry,
        cfg: params.cfg,
        result,
      }),
    );
  } catch (err) {
    params.log.warn(
      `Delivery entry ${params.entry.id} reconciled sent afterCommit hook failed: ${formatErrorMessage(err)}`,
    );
  }
}

async function moveEntryToFailedWithLogging(
  entry: QueuedDelivery,
  cfg: OpenClawConfig,
  log: RecoveryLogger,
  stateDir?: string,
): Promise<boolean> {
  await markDurableDeliveryFailedBestEffort(entry, log, stateDir);
  try {
    const attemptId = recoveryPlatformAttemptId(entry);
    await moveEntryToFailedAndCleanup({ entry, cfg, log, stateDir, attemptId });
    emitRecoveredTerminalFailure(entry, "delivery retry budget exhausted");
    return true;
  } catch (err) {
    log.error(`Failed to move entry ${entry.id} to failed/: ${String(err)}`);
    return false;
  }
}

function recoveryPlatformAttemptId(
  entry: QueuedDelivery,
  claimedAttemptId?: string,
): string | null | undefined {
  return claimedAttemptId !== undefined
    ? claimedAttemptId
    : typeof entry.platformSendAttemptId === "string"
      ? entry.platformSendAttemptId
      : typeof entry.completionRetention === "object" || entry.requiresProducerClaim === true
        ? null
        : undefined;
}

async function ackRecoveredDelivery(
  entry: QueuedDelivery,
  stateDir?: string,
  options?: { retainSpoolArtifacts?: boolean; suppressCompletionReceipt?: boolean },
  claimedAttemptId?: string,
): Promise<void> {
  await createQueuedDeliveryOwner({
    queueId: entry.id,
    stateDir,
    expectedPlatformSendAttemptId: recoveryPlatformAttemptId(entry, claimedAttemptId),
  }).ack(options);
}

async function recordRecoveredFailure(
  record: typeof failDelivery | typeof failDeliveryAfterPlatformSend,
  entry: QueuedDelivery,
  error: string,
  stateDir?: string,
  claimedAttemptId?: string,
): Promise<void> {
  await createQueuedDeliveryOwner({
    queueId: entry.id,
    stateDir,
    expectedPlatformSendAttemptId: recoveryPlatformAttemptId(entry, claimedAttemptId),
  }).fail(record, error);
}

async function markDurableDeliveryFailedBestEffort(
  entry: QueuedDelivery,
  log: RecoveryLogger,
  stateDir?: string,
): Promise<void> {
  if (!entry.deliveryCompletion) {
    return;
  }
  try {
    await failDurableDelivery(entry.deliveryCompletion, stateDir);
  } catch (error) {
    // Queue ownership is authoritative for replay safety. Missing owner state
    // must not leave a dead-lettered delivery permanently replayable.
    log.warn(
      `Delivery entry ${entry.id} owner state could not be marked unknown: ${formatErrorMessage(error)}`,
    );
  }
}

async function resolveCompletedOwnerBeforeRecovery(opts: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  onRecovered?: (entry: QueuedDelivery) => void;
  onFailed?: (entry: QueuedDelivery, errMsg: string) => void;
}): Promise<"continue" | "recovered" | "failed" | "moved-to-failed"> {
  const completion = opts.entry.deliveryCompletion;
  if (!completion) {
    return "continue";
  }
  let operation: Awaited<ReturnType<typeof markDurableDeliveryQueued>>;
  try {
    operation = await markDurableDeliveryQueued(completion, opts.entry.id);
  } catch (error) {
    const errMsg = `delivery owner state unavailable: ${formatErrorMessage(error)}`;
    await recordRecoveredFailure(failDelivery, opts.entry, errMsg, opts.stateDir).catch(
      () => undefined,
    );
    opts.onFailed?.(opts.entry, errMsg);
    opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
    return "failed";
  }
  if (operation.state === "delivered") {
    try {
      await ackRecoveredDelivery(opts.entry, opts.stateDir);
    } catch (error) {
      const errMsg = `failed to ack owner-completed delivery: ${formatErrorMessage(error)}`;
      opts.onFailed?.(opts.entry, errMsg);
      opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
      return "failed";
    }
    const messageId = operation.platformMessageId;
    if (messageId) {
      const result: OutboundDeliveryResult = { channel: opts.entry.channel, messageId };
      emitRecoveredTerminalSuccess(opts.entry, result);
      await runOutboundDeliveryCommitHooks([result]);
      emitQueuedAuditTerminals(opts.entry, () =>
        completedOutboundAuditTerminals({
          payloadCount: queuedPayloadCount(opts.entry),
          results: [result],
          payloadOutcomes: [],
        }),
      );
    }
    opts.onRecovered?.(opts.entry);
    return "recovered";
  }
  if (operation.state === "suppressed" || operation.state === "stale") {
    try {
      await (typeof opts.entry.completionRetention === "object"
        ? ackRecoveredDelivery(opts.entry, opts.stateDir, { suppressCompletionReceipt: true })
        : ackRecoveredDelivery(opts.entry, opts.stateDir));
    } catch (error) {
      const errMsg = `failed to ack owner-suppressed delivery: ${formatErrorMessage(error)}`;
      opts.onFailed?.(opts.entry, errMsg);
      opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
      return "failed";
    }
    opts.onRecovered?.(opts.entry);
    return "recovered";
  }
  if (operation.state === "rejected") {
    try {
      await (typeof opts.entry.completionRetention === "object"
        ? ackRecoveredDelivery(opts.entry, opts.stateDir, { suppressCompletionReceipt: true })
        : ackRecoveredDelivery(opts.entry, opts.stateDir));
    } catch (error) {
      const errMsg = `failed to ack owner-rejected delivery: ${formatErrorMessage(error)}`;
      opts.onFailed?.(opts.entry, errMsg);
      opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
      return "failed";
    }
    emitQueuedAuditTerminals(opts.entry, () =>
      failedOutboundAuditTerminals({
        payloadCount: queuedPayloadCount(opts.entry),
        results: [],
        payloadOutcomes: [],
        failureStage: "platform_send",
      }),
    );
    const error =
      operation.rejectionError ?? "delivery permanently rejected before platform dispatch";
    emitRecoveredTerminalFailure(opts.entry, error);
    opts.onFailed?.(opts.entry, error);
    return "failed";
  }
  if (operation.state === "unknown") {
    const moved = await moveEntryToFailedWithLogging(opts.entry, opts.cfg, opts.log, opts.stateDir);
    return moved ? "moved-to-failed" : "failed";
  }
  return "continue";
}

function isPermanentDeliveryError(error: string): boolean {
  return PERMANENT_ERROR_PATTERNS.some((re) => re.test(error));
}

async function persistRecoveredPostSendState(opts: {
  entry: QueuedDelivery;
  log: RecoveryLogger;
  stateDir?: string;
  producerClaimId?: string;
}): Promise<QueuedPostSendState> {
  // Recovery keeps its media lease until the adapter settles, even if the
  // canonical post-send marker has to finalize the queue with a direct ack.
  return persistQueuedPostSendState({
    queueId: opts.entry.id,
    queuePolicy: opts.entry.queuePolicy ?? "best_effort",
    stateDir: opts.stateDir,
    producerClaimId: opts.producerClaimId,
    expectedPlatformSendAttemptId: recoveryPlatformAttemptId(opts.entry, opts.producerClaimId),
    retainSpoolArtifacts: true,
    onPostSendMarkerError: (error) => {
      opts.log.warn(
        `Delivery entry ${opts.entry.id} failed to persist post-send state; falling back to direct ack: ${formatErrorMessage(error)}`,
      );
    },
  });
}

async function drainQueuedEntry(opts: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  deliver: DeliverFn;
  log: RecoveryLogger;
  stateDir?: string;
  onRecovered?: (entry: QueuedDelivery) => void;
  onFailed?: (entry: QueuedDelivery, errMsg: string) => void;
}): Promise<"recovered" | "failed" | "moved-to-failed" | "already-gone"> {
  const { entry } = opts;
  const maxRetries = resolveMaxRetries(entry);
  const attemptBudgetExhausted = resolveAttemptCount(entry) >= maxRetries;
  let reconciledPlatformSendAttemptId: string | undefined;
  let reconciledPlatformSendStartedAt: number | undefined;
  const ownerState = await resolveCompletedOwnerBeforeRecovery(opts);
  if (ownerState !== "continue") {
    return ownerState;
  }
  if (needsUnknownSendReconciliation(entry)) {
    // A crash after platform send start cannot be blindly replayed; adapters
    // must reconcile whether the platform already committed the message.
    const reconciliation =
      entry.legacyUnknownSendReconciliation ??
      (await reconcileUnknownQueuedDelivery({
        entry,
        payloads: queuedDeliveryPayloads(entry),
        cfg: opts.cfg,
        warn: (message) => opts.log.warn(message),
      }));
    if (reconciliation?.status === "sent") {
      try {
        const result = buildReconciledSentResult(entry, reconciliation);
        if (entry.deliveryCompletion) {
          await completeDurableDelivery(entry.deliveryCompletion, result, opts.stateDir);
        }
        await ackRecoveredDelivery(entry, opts.stateDir, undefined, entry.platformSendAttemptId);
        emitRecoveredTerminalSuccess(entry, result);
        await runReconciledSentCommitHooks({
          entry,
          cfg: opts.cfg,
          reconciliation,
          log: opts.log,
        });
        emitQueuedAuditTerminals(entry, () =>
          completedOutboundAuditTerminals({
            payloadCount: queuedPayloadCount(entry),
            results: [result],
            payloadOutcomes: [],
          }),
        );
        opts.onRecovered?.(entry);
        opts.log.info(`Delivery entry ${entry.id} reconciled unknown_after_send as already sent`);
        return "recovered";
      } catch (ackErr) {
        if (getErrnoCode(ackErr) === "ENOENT") {
          return "already-gone";
        }
        const errMsg = `failed to ack reconciled sent delivery: ${formatErrorMessage(ackErr)}`;
        opts.log.warn(`Delivery entry ${entry.id} ${errMsg}`);
        opts.onFailed?.(entry, errMsg);
        try {
          await recordRecoveredFailure(
            failDelivery,
            entry,
            errMsg,
            opts.stateDir,
            entry.platformSendAttemptId,
          );
          return "failed";
        } catch (failErr) {
          if (getErrnoCode(failErr) === "ENOENT") {
            return "already-gone";
          }
        }
        return "failed";
      }
    }
    const reconciliationProvedPreSendFailure =
      reconciliation?.status === "not_sent" && entry.recoveryState === "send_attempt_started";
    if (reconciliationProvedPreSendFailure) {
      reconciledPlatformSendAttemptId = entry.platformSendAttemptId;
      reconciledPlatformSendStartedAt = entry.platformSendStartedAt;
      opts.log.info(
        `Delivery entry ${entry.id} reconciled ${entry.recoveryState} as not sent; replaying`,
      );
    } else {
      let errMsg = `delivery state is ${entry.recoveryState}; refusing blind replay without adapter reconciliation`;
      if (reconciliation?.status === "not_sent") {
        errMsg = `delivery state is ${entry.recoveryState}; refusing full replay after post-send evidence`;
      } else if (reconciliation?.status === "unresolved" && reconciliation.error) {
        errMsg = `delivery state is ${entry.recoveryState} and reconciliation is unresolved: ${reconciliation.error}`;
      }
      opts.log.warn(`Delivery entry ${entry.id} ${errMsg}`);
      opts.onFailed?.(entry, errMsg);
      if (
        reconciliation?.status === "unresolved" &&
        reconciliation.retryable === true &&
        !attemptBudgetExhausted
      ) {
        try {
          await recordRecoveredFailure(failDelivery, entry, errMsg, opts.stateDir);
          return "failed";
        } catch (failErr) {
          if (getErrnoCode(failErr) === "ENOENT") {
            return "already-gone";
          }
        }
        return "failed";
      }
      try {
        await markDurableDeliveryFailedBestEffort(entry, opts.log, opts.stateDir);
        const attemptId = recoveryPlatformAttemptId(entry);
        await moveEntryToFailedAndCleanup({
          entry,
          cfg: opts.cfg,
          log: opts.log,
          stateDir: opts.stateDir,
          attemptId,
        });
        emitRecoveredTerminalFailure(entry, errMsg);
        emitQueuedAuditTerminals(entry, () => queuedUnknownAuditTerminals(entry));
        return "moved-to-failed";
      } catch (moveErr) {
        if (getErrnoCode(moveErr) === "ENOENT") {
          return "already-gone";
        }
      }
      return "failed";
    }
  }
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  // Deliberately process-local: a crash may lose best-effort observers, but
  // persisting plugin callbacks must never become part of delivery custody.
  const messageSentEvents: IndexedMessageSentEvent[] = [];
  let postSendState: QueuedPostSendState | undefined;
  let deliveredResults: OutboundDeliveryResult[] = [];
  let commitHooksRun = false;
  const collectResults = (results: readonly OutboundDeliveryResult[]): void => {
    for (const result of results) {
      if (!deliveredResults.includes(result)) {
        deliveredResults.push(result);
      }
    }
  };
  const collectPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
    if (!payloadOutcomes.includes(outcome)) {
      payloadOutcomes.push(outcome);
    }
  };
  const runCommitHooksAfterAck = async (): Promise<void> => {
    if (postSendState !== "acked" || commitHooksRun) {
      return;
    }
    commitHooksRun = true;
    emitRecoveredMessageSentEvents(
      entry,
      messageSentEvents.map(({ event }) => event),
    );
    if (deliveredResults.length > 0) {
      await runOutboundDeliveryCommitHooks(deliveredResults);
    }
  };
  // Live producer rows can be observed between enqueue and platform I/O.
  // Fence recovery at the same SQLite claim before consuming an attempt;
  // an active live producer keeps its original renewable lease.
  const requiresProducerClaim =
    typeof entry.completionRetention === "object" ||
    entry.requiresProducerClaim === true ||
    typeof entry.producerClaimId === "string" ||
    typeof entry.platformSendAttemptId === "string";
  const producerClaimId = requiresProducerClaim
    ? await claimDeliveryPlatformSendAttempt(
        entry.id,
        opts.stateDir,
        reconciledPlatformSendStartedAt,
        reconciledPlatformSendAttemptId,
      )
    : undefined;
  if (requiresProducerClaim && !producerClaimId) {
    opts.log.info(`Recovery skipped for delivery ${entry.id}: producer ownership already claimed`);
    return "already-gone";
  }
  const reservation = producerClaimId
    ? await reserveDeliveryAttempt(entry.id, maxRetries, opts.stateDir, producerClaimId)
    : await reserveDeliveryAttempt(entry.id, maxRetries, opts.stateDir);
  if (reservation.status === "exhausted") {
    const errMsg = `delivery retry budget exhausted (${reservation.attemptCount}/${maxRetries})`;
    await markDurableDeliveryFailedBestEffort(entry, opts.log, opts.stateDir);
    try {
      await moveEntryToFailedAndCleanup({
        entry,
        cfg: opts.cfg,
        log: opts.log,
        stateDir: opts.stateDir,
        attemptId: producerClaimId,
      });
      emitRecoveredTerminalFailure(entry, errMsg);
    } catch (moveErr) {
      if (getErrnoCode(moveErr) === "ENOENT") {
        return "already-gone";
      }
      throw moveErr;
    }
    emitQueuedAuditTerminals(entry, () => queuedDeadLetterAuditTerminals(entry));
    opts.onFailed?.(entry, errMsg);
    return "moved-to-failed";
  }
  const recoverySpoolPaths = collectEntrySpoolPaths(queuedDeliveryPayloads(entry), opts.stateDir);
  let mediaRecoveryLeaseId: string | undefined;
  try {
    // The pending row owns these artifacts until the lease exists. Fallback
    // acks may then remove replay intent without exposing active media to GC.
    mediaRecoveryLeaseId =
      recoverySpoolPaths.length > 0
        ? createDeliveryQueueMediaRetention(
            recoverySpoolPaths,
            "outbound-media-recovery-lease",
            opts.stateDir,
          )
        : undefined;
    const result = await opts.deliver({
      ...buildRecoveryDeliverParams(entry, opts.cfg, opts.stateDir, producerClaimId),
      onPayloadDeliveryOutcome: collectPayloadOutcome,
      onMessageSentEvent: (event, sourceIndex) => messageSentEvents.push({ sourceIndex, event }),
      onDeliveryResult: async (deliveryResult) => {
        collectResults([deliveryResult]);
        postSendState ??= await persistRecoveredPostSendState({
          entry,
          log: opts.log,
          stateDir: opts.stateDir,
          ...(producerClaimId ? { producerClaimId } : {}),
        });
      },
    });
    const results = isOutboundDeliveryResultArray(result) ? result : [];
    if (
      producerClaimId !== undefined &&
      payloadOutcomes.some(
        (outcome) =>
          outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
      )
    ) {
      const error = "recovered platform send returned no delivery identity";
      await recordRecoveredFailure(
        failDeliveryAfterPlatformSend,
        entry,
        error,
        opts.stateDir,
        producerClaimId,
      );
      opts.onFailed?.(entry, error);
      opts.log.warn(`Delivery entry ${entry.id} ${error}; preserving unknown_after_send`);
      emitQueuedAuditTerminals(entry, () => queuedUnknownAuditTerminals(entry));
      return "failed";
    }
    if (results.length > 0) {
      deliveredResults = [...results];
    }
    const failedOutcomes = payloadOutcomes.filter((outcome) => outcome.status === "failed");
    const failedOutcome = failedOutcomes[0];
    if (failedOutcome) {
      const errMsg = formatErrorMessage(failedOutcome.error);
      opts.onFailed?.(entry, errMsg);
      if (results.length > 0 || failedOutcomes.some((outcome) => outcome.sentBeforeError)) {
        postSendState ??= await persistRecoveredPostSendState({
          entry,
          log: opts.log,
          stateDir: opts.stateDir,
          ...(producerClaimId ? { producerClaimId } : {}),
        });
        opts.log.warn(
          `Delivery entry ${entry.id} partially sent before best-effort recovery failed; preserving unknown_after_send`,
        );
        if (postSendState === "acked") {
          await runCommitHooksAfterAck();
          emitQueuedAuditTerminals(entry, () =>
            failedOutboundAuditTerminals({
              payloadCount: queuedPayloadCount(entry),
              results: deliveredResults,
              payloadOutcomes,
              failureStage: "platform_send",
            }),
          );
        }
      } else {
        const recordFailure = failedOutcomes.every((outcome) =>
          isProvenDeliveryNotSentError(outcome.error),
        )
          ? failDeliveryBeforePlatformSend
          : failDelivery;
        await recordRecoveredFailure(recordFailure, entry, errMsg, opts.stateDir, producerClaimId);
      }
      return "failed";
    }
    if (entry.deliveryCompletion) {
      if (results.length > 0) {
        await completeDurableDelivery(entry.deliveryCompletion, results.at(-1)!, opts.stateDir);
      } else {
        await suppressDurableDelivery(entry.deliveryCompletion, opts.stateDir);
      }
    }
    postSendState ??=
      results.length > 0
        ? await persistRecoveredPostSendState({
            entry,
            log: opts.log,
            stateDir: opts.stateDir,
            ...(producerClaimId ? { producerClaimId } : {}),
          })
        : undefined;
    if (postSendState === "failed") {
      const errMsg = "recovered send completed but queue finalization failed";
      opts.onFailed?.(entry, errMsg);
      opts.log.warn(`Delivery entry ${entry.id} ${errMsg}; preserving unknown_after_send`);
      return "failed";
    }
    if (postSendState !== "acked") {
      try {
        await (results.length === 0 && typeof entry.completionRetention === "object"
          ? ackRecoveredDelivery(
              entry,
              opts.stateDir,
              { suppressCompletionReceipt: true },
              producerClaimId,
            )
          : ackRecoveredDelivery(entry, opts.stateDir, undefined, producerClaimId));
        postSendState = "acked";
      } catch (ackErr) {
        const ackError = `failed to ack recovered delivery: ${formatErrorMessage(ackErr)}`;
        if (results.length > 0) {
          await recordRecoveredFailure(
            failDeliveryAfterPlatformSend,
            entry,
            ackError,
            opts.stateDir,
            producerClaimId,
          );
          postSendState = "failed";
        } else {
          await recordRecoveredFailure(
            failDelivery,
            entry,
            ackError,
            opts.stateDir,
            producerClaimId,
          );
        }
        opts.onFailed?.(entry, ackError);
        opts.log.warn(`Delivery entry ${entry.id} ${ackError}`);
        return "failed";
      }
    }
    await runCommitHooksAfterAck();
    emitQueuedAuditTerminals(entry, () =>
      completedOutboundAuditTerminals({
        payloadCount: queuedPayloadCount(entry),
        results,
        payloadOutcomes,
      }),
    );
    opts.onRecovered?.(entry);
    return "recovered";
  } catch (err) {
    const errMsg = formatErrorMessage(err);
    opts.onFailed?.(entry, errMsg);
    if (isOutboundDeliveryError(err) && err.results.length > 0) {
      deliveredResults = [...err.results];
    }
    const hasSendEvidence =
      deliveredResults.length > 0 ||
      postSendState !== undefined ||
      (isOutboundDeliveryError(err) && err.sentBeforeError);
    if (hasSendEvidence) {
      // A rejected batch can still contain successful earlier sends. Preserve
      // that concrete evidence so reconnect recovery never replays the batch.
      try {
        postSendState ??= await persistRecoveredPostSendState({
          entry,
          log: opts.log,
          stateDir: opts.stateDir,
          ...(producerClaimId ? { producerClaimId } : {}),
        });
      } catch (persistErr) {
        // Never overwrite concrete send evidence with a generic retry state.
        opts.log.error(
          `Delivery entry ${entry.id} could not persist post-send evidence: ${formatErrorMessage(persistErr)}`,
        );
      }
      if (postSendState === "acked") {
        await runCommitHooksAfterAck();
        emitQueuedAuditTerminals(entry, () =>
          failedOutboundAuditTerminals({
            payloadCount: queuedPayloadCount(entry),
            results: deliveredResults,
            payloadOutcomes,
            failureStage: isOutboundDeliveryError(err) ? err.stage : "platform_send",
          }),
        );
      }
      opts.log.warn(
        `Delivery entry ${entry.id} partially sent before recovery failed; preserving unknown_after_send`,
      );
      return "failed";
    }
    if (!(await loadPendingDelivery(entry.id, opts.stateDir))) {
      // A best-effort pre-send marker fallback may ack the row before provider
      // I/O. Recovery then owns the stable queue terminal on provider rejection.
      emitQueuedAuditTerminals(entry, () =>
        failedOutboundAuditTerminals({
          payloadCount: queuedPayloadCount(entry),
          results: deliveredResults,
          payloadOutcomes,
          failureStage: isOutboundDeliveryError(err) ? err.stage : "platform_send",
        }),
      );
      return "failed";
    }
    const permanentPlatformRejection = findPlatformMessageRejectedError(err);
    if (permanentPlatformRejection || isPermanentDeliveryError(errMsg)) {
      try {
        if (permanentPlatformRejection && entry.deliveryCompletion) {
          await rejectDurableDelivery(
            entry.deliveryCompletion,
            permanentPlatformRejection.message,
            opts.stateDir,
          );
        } else {
          await markDurableDeliveryFailedBestEffort(entry, opts.log, opts.stateDir);
        }
        await moveEntryToFailedAndCleanup({
          entry,
          cfg: opts.cfg,
          log: opts.log,
          stateDir: opts.stateDir,
          attemptId: producerClaimId,
        });
        emitRecoveredTerminalFailure(entry, errMsg, messageSentEvents);
        emitQueuedAuditTerminals(entry, () =>
          failedOutboundAuditTerminals({
            payloadCount: queuedPayloadCount(entry),
            results: deliveredResults,
            payloadOutcomes,
            failureStage: "queue",
          }),
        );
        return "moved-to-failed";
      } catch (moveErr) {
        if (getErrnoCode(moveErr) === "ENOENT") {
          return "already-gone";
        }
      }
    } else {
      try {
        const recordFailure = isProvenDeliveryNotSentError(err)
          ? failDeliveryBeforePlatformSend
          : failDelivery;
        await recordRecoveredFailure(recordFailure, entry, errMsg, opts.stateDir, producerClaimId);
        return "failed";
      } catch (failErr) {
        if (getErrnoCode(failErr) === "ENOENT") {
          return "already-gone";
        }
      }
    }
    return "failed";
  } finally {
    // Early fallback acks make the row non-replayable before the adapter has
    // necessarily finished reading every payload. Release only after the whole
    // recovered attempt settles, and only if no pending row still owns it.
    cancelDeliveryQueueMediaRetention(mediaRecoveryLeaseId, opts.stateDir);
    const pending = await loadPendingDelivery(entry.id, opts.stateDir).catch(() => entry);
    if (!pending) {
      await releaseSpoolArtifacts(recoverySpoolPaths, opts.stateDir);
    }
  }
}

export async function drainPendingDeliveriesCore(opts: {
  drainKey: string;
  logLabel: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  deliver: DeliverFn;
  selectEntry: (entry: QueuedDelivery, now: number) => DeliveryRecoveryDrainDecision;
}): Promise<void> {
  const drained = await recoveryCoordinator.withDrain(opts.drainKey, async () => {
    const now = Date.now();
    const matchingEntries = (await loadPendingDeliveries(opts.stateDir)).filter(
      (entry) => opts.selectEntry(entry, now).match,
    );
    await recoveryCoordinator.scan({
      entries: matchingEntries,
      loadEntry: (id) => loadPendingDelivery(id, opts.stateDir),
      onMissingEntry: (entry) => {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} already gone, skipping`);
      },
      // Poll-driven reconnect drains can repeat while a live send owns its
      // claim. Leave conflicts silent so reconnect polling cannot starve it.
      onEntry: async (currentEntry) => {
        if (hasActiveDeliveryOwner(currentEntry, Date.now())) {
          return;
        }
        const admission = await applyRecoveryDeliveryAdmission({
          entry: currentEntry,
          cfg: opts.cfg,
          log: opts.log,
          stateDir: opts.stateDir,
          logLabel: opts.logLabel,
        });
        if (admission !== "allowed") {
          return;
        }

        const currentDecision = opts.selectEntry(currentEntry, Date.now());
        if (!currentDecision.match) {
          opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} no longer matches, skipping`);
          return;
        }

        const maxRetries = resolveMaxRetries(currentEntry);
        if (
          resolveAttemptCount(currentEntry) >= maxRetries &&
          !needsUnknownSendReconciliation(currentEntry)
        ) {
          try {
            await markDurableDeliveryFailedBestEffort(currentEntry, opts.log, opts.stateDir);
            const attemptId = recoveryPlatformAttemptId(currentEntry);
            await moveEntryToFailedAndCleanup({
              entry: currentEntry,
              cfg: opts.cfg,
              log: opts.log,
              stateDir: opts.stateDir,
              attemptId,
            });
            emitRecoveredTerminalFailure(currentEntry, "delivery retry budget exhausted");
          } catch (err) {
            if (getErrnoCode(err) === "ENOENT") {
              opts.log.info(`${opts.logLabel}: entry ${currentEntry.id} already gone, skipping`);
              return;
            }
            throw err;
          }
          emitQueuedAuditTerminals(currentEntry, () =>
            queuedDeadLetterAuditTerminals(currentEntry),
          );
          opts.log.warn(
            `${opts.logLabel}: entry ${currentEntry.id} exceeded max retries and was moved to failed/`,
          );
          return;
        }

        if (!currentDecision.bypassBackoff) {
          const retryEligibility = isDeliveryRecoveryRetryEligible(currentEntry, Date.now());
          if (!retryEligibility.eligible) {
            opts.log.info(
              `${opts.logLabel}: entry ${currentEntry.id} not ready for retry yet — backoff ${retryEligibility.remainingBackoffMs}ms remaining`,
            );
            return;
          }
        }

        await recoveryCoordinator.waitForReplay();

        const result = await drainQueuedEntry({
          entry: currentEntry,
          cfg: opts.cfg,
          deliver: opts.deliver,
          log: opts.log,
          stateDir: opts.stateDir,
          onFailed: (failedEntry, errMsg) => {
            if (isPermanentDeliveryError(errMsg)) {
              opts.log.warn(
                `${opts.logLabel}: entry ${failedEntry.id} hit permanent error — moving to failed/: ${errMsg}`,
              );
              return;
            }
            opts.log.warn(`${opts.logLabel}: retry failed for entry ${failedEntry.id}: ${errMsg}`);
          },
        });
        if (result === "recovered") {
          opts.log.info(
            `${opts.logLabel}: drained delivery ${currentEntry.id} on ${currentEntry.channel}`,
          );
        }
      },
    });
  });
  if (!drained) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
  }
}

/**
 * On gateway startup, scan the delivery queue and retry any pending entries.
 * Uses exponential backoff and moves entries that exhaust their retry budget to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next startup. Default: 60 000. */
  maxRecoveryMs?: number;
}): Promise<DeliveryRecoverySummary> {
  const { migrateLegacyPendingOutboundDeliveries } = await import("./delivery-queue-migration.js");
  await migrateLegacyPendingOutboundDeliveries({
    cfg: opts.cfg,
    log: opts.log,
    stateDir: opts.stateDir,
  });
  const pending = await loadPendingDeliveries(opts.stateDir);
  if (pending.length === 0) {
    return createEmptyDeliveryRecoverySummary();
  }

  opts.log.info(`Found ${pending.length} pending delivery entries — starting recovery`);

  const deadline = resolveDeliveryRecoveryDeadlineMs(opts.maxRecoveryMs);
  const summary = createEmptyDeliveryRecoverySummary();
  const onDeadlineExceeded = () => {
    // Budget deferral is not an attempt; preserve pending rows and retry counts.
    opts.log.warn(`Recovery time budget exceeded — remaining entries deferred to next startup`);
  };
  await recoveryCoordinator.scan({
    entries: pending,
    loadEntry: (id) => loadPendingDelivery(id, opts.stateDir),
    deadlineMs: deadline,
    onDeadlineExceeded,
    onClaimConflict: (entry) => {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already being processed`);
    },
    onMissingEntry: (entry) => {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already gone`);
    },
    onEntry: async (currentEntry) => {
      if (hasActiveDeliveryOwner(currentEntry, Date.now())) {
        opts.log.info(`Recovery skipped for delivery ${currentEntry.id}: active platform owner`);
        return "continue";
      }
      const admission = await applyRecoveryDeliveryAdmission({
        entry: currentEntry,
        cfg: opts.cfg,
        log: opts.log,
        stateDir: opts.stateDir,
        logLabel: "Recovery",
      });
      if (admission !== "allowed") {
        if (admission === "failed") {
          summary.failed += 1;
        }
        return "continue";
      }

      const maxRetries = resolveMaxRetries(currentEntry);
      const attemptCount = resolveAttemptCount(currentEntry);
      if (attemptCount >= maxRetries && !needsUnknownSendReconciliation(currentEntry)) {
        opts.log.warn(
          `Delivery ${currentEntry.id} exceeded max retries (${attemptCount}/${maxRetries}) — moving to failed/`,
        );
        const movedToFailed = await moveEntryToFailedWithLogging(
          currentEntry,
          opts.cfg,
          opts.log,
          opts.stateDir,
        );
        if (movedToFailed) {
          emitQueuedAuditTerminals(currentEntry, () =>
            queuedDeadLetterAuditTerminals(currentEntry),
          );
        }
        summary.skippedMaxRetries += 1;
        return "continue";
      }

      const currentRetryEligibility = isDeliveryRecoveryRetryEligible(currentEntry, Date.now());
      if (!currentRetryEligibility.eligible) {
        summary.deferredBackoff += 1;
        opts.log.info(
          `Delivery ${currentEntry.id} not ready for retry yet — backoff ${currentRetryEligibility.remainingBackoffMs}ms remaining`,
        );
        return "continue";
      }

      const paceResult = await recoveryCoordinator.waitForReplay(deadline);
      if (paceResult === "deadline-exceeded") {
        onDeadlineExceeded();
        return "stop";
      }

      await drainQueuedEntry({
        entry: currentEntry,
        cfg: opts.cfg,
        deliver: opts.deliver,
        log: opts.log,
        stateDir: opts.stateDir,
        onRecovered: (recoveredEntry) => {
          summary.recovered += 1;
          opts.log.info(`Recovered delivery ${recoveredEntry.id} on ${recoveredEntry.channel}`);
        },
        onFailed: (failedEntry, errMsg) => {
          summary.failed += 1;
          if (isPermanentDeliveryError(errMsg)) {
            opts.log.warn(
              `Delivery ${failedEntry.id} hit permanent error — moving to failed/: ${errMsg}`,
            );
            return;
          }
          opts.log.warn(`Retry failed for delivery ${failedEntry.id}: ${errMsg}`);
        },
      });
      return "continue";
    },
  });

  opts.log.info(
    `Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skippedMaxRetries} skipped (max retries), ${summary.deferredBackoff} deferred (backoff)`,
  );
  return summary;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
