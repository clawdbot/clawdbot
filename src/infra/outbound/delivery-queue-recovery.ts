import { assertSessionWriterDeliveryAuthorized } from "../../auto-reply/reply/session-writer-delivery-authority.js";
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
import type { DeliverOutboundPayloadsParams } from "./deliver-contracts.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import { buildPayloadSummary } from "./deliver-payload.js";
import {
  createQueuedDeliveryOwner,
  persistQueuedPostSendState,
  type QueuedPostSendState,
} from "./deliver-queue-state.js";
import {
  areOutboundPayloadsIntentionallySuppressed,
  isOutboundDeliveryError,
  isOutboundDeliveryAdmissionClosedError,
  OutboundDeliveryAdmissionClosedError,
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
  settleDurableDelivery,
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
  finalizeDeliveryFailureSettlement,
  hasActiveDeliveryOwner,
  loadPendingDelivery,
  loadUnfinishedDelivery,
  loadUnfinishedDeliveries,
  stageDeliveryFailureSettlement,
  reserveDeliveryAttempt,
  restoreDeliveryAttemptBeforeDispatch,
  type QueuedDelivery,
} from "./delivery-queue-storage.js";
import type { DeliveryFailureSettlement } from "./delivery-queue-types.js";
import { createMessageSentEmitter, type MessageSentEvent } from "./message-sent-hook.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import { acceptedPreparedOutboundEntries } from "./prepared-batch.js";

export type DeliverFn = (params: DeliverOutboundPayloadsParams) => Promise<unknown>;

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
  const conversationCompletion =
    entry.deliveryCompletion?.kind === "conversation" ? entry.deliveryCompletion : undefined;
  const pendingFinalWriterAuthority =
    entry.deliveryCompletion?.kind === "pending-final"
      ? entry.deliveryCompletion.sessionWriterDeliveryAuthority
      : undefined;
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
    reply: entry.reply,
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
    // Recovery owns terminal completion because nested delivery only reports
    // process-local evidence that cannot survive another restart.
    ...(conversationCompletion
      ? {
          conversationDeliveryAttemptAuthority: {
            agentId: conversationCompletion.agentId,
            operationId: conversationCompletion.operationId,
            ...(conversationCompletion.storePath
              ? { storePath: conversationCompletion.storePath }
              : {}),
            ...(conversationCompletion.routeFingerprint
              ? { routeFingerprint: conversationCompletion.routeFingerprint }
              : {}),
          },
        }
      : {}),
    // Recovery owns durable terminal settlement, so it cannot forward the
    // completion itself. Reconstruct only its writer fence at the two final
    // transport boundaries used by normal live delivery.
    ...(pendingFinalWriterAuthority
      ? {
          onDirectAdapterHandoff: async () => {
            assertSessionWriterDeliveryAuthorized(pendingFinalWriterAuthority);
          },
          assertDirectAdapterHandoff: () => {
            assertSessionWriterDeliveryAuthorized(pendingFinalWriterAuthority);
          },
          onPlatformSendDispatch: async () => {
            assertSessionWriterDeliveryAuthorized(pendingFinalWriterAuthority);
          },
        }
      : {}),
    deliveryQueueId: entry.id,
    deliveryQueueStateDir: stateDir,
    ...(producerClaimId ? { deliveryProducerClaimId: producerClaimId } : {}),
    ...(entry.requiresProducerClaim === true ? { deliveryProducerLeaseRequired: true } : {}),
    skipQueue: true, // Prevent re-enqueueing during recovery.
    deferredDeliveryAdmissionPassed: true,
    deferCommitHooks: true,
  } satisfies Parameters<DeliverFn>[0];
}

async function settleQueuedFailure(params: {
  entry: QueuedDelivery;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  error: string;
  claimedAttemptId?: string;
  rejectionError?: string;
  events?: readonly IndexedMessageSentEvent[];
  terminals?: ReturnType<typeof failedOutboundAuditTerminals>;
}): Promise<"moved-to-failed" | "failed" | "already-gone"> {
  let terminalized = false;
  try {
    const unknownSend = needsUnknownSendReconciliation(params.entry);
    const settlement: DeliveryFailureSettlement = params.entry.settlement ?? {
      error: params.error,
      ...(params.terminals ? { terminals: params.terminals } : {}),
      ...(unknownSend ? { unknownSendCleanup: true as const } : {}),
      ...(params.rejectionError !== undefined
        ? { outcome: "failed" as const, rejectionError: params.rejectionError }
        : { outcome: unknownSend ? ("unknown" as const) : ("failed" as const) }),
    };
    const entry = await stageDeliveryFailureSettlement(
      params.entry,
      settlement,
      params.stateDir,
      params.claimedAttemptId,
    );
    if (!entry) {
      return "already-gone";
    }
    // Failed custody forbids sends even after a restart. Keep the completion
    // payload until its idempotent owner projection succeeds, then compact once.
    if (entry.deliveryCompletion) {
      await (settlement.outcome === "failed" && settlement.rejectionError !== undefined
        ? rejectDurableDelivery(
            entry.deliveryCompletion,
            settlement.rejectionError,
            params.stateDir,
          )
        : failDurableDelivery(entry.deliveryCompletion, params.stateDir));
    }
    const spoolPaths = collectEntrySpoolPaths(queuedDeliveryPayloads(entry), params.stateDir);
    const leaseId =
      spoolPaths.length > 0
        ? createDeliveryQueueMediaRetention(
            spoolPaths,
            "outbound-media-recovery-lease",
            params.stateDir,
          )
        : undefined;
    try {
      if (!finalizeDeliveryFailureSettlement(entry, params.stateDir)) {
        return "already-gone";
      }
      terminalized = true;
      emitRecoveredTerminalFailure(entry, settlement.error, params.events);
      emitQueuedAuditTerminals(
        entry,
        settlement.terminals ??
          (() =>
            uniformOutboundAuditTerminals(queuedPayloadCount(entry), {
              outcome: settlement.outcome,
              failureStage: "queue",
            })),
      );
      if (settlement.unknownSendCleanup) {
        const cleanup = resolveOutboundChannelMessageAdapter({
          channel: entry.channel,
          cfg: params.cfg,
          agentId: entry.session?.agentId,
          allowBootstrap: true,
        })?.durableFinal?.afterUnknownSendTerminal;
        try {
          await cleanup?.(
            buildUnknownSendContext({
              entry,
              payloads: queuedDeliveryPayloads(entry),
              cfg: params.cfg,
            }),
          );
        } catch (error) {
          params.log.warn(
            `Delivery entry ${entry.id} unknown-send terminal cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      await releaseSpoolArtifacts(spoolPaths, params.stateDir);
    } finally {
      cancelDeliveryQueueMediaRetention(leaseId, params.stateDir);
    }
  } catch (error) {
    params.log.warn(
      `Delivery entry ${params.entry.id} ${terminalized ? "terminal cleanup failed" : "settlement pending"}: ${formatErrorMessage(error)}`,
    );
  }
  return terminalized ? "moved-to-failed" : "failed";
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
        : params.entry.reply?.replyToId,
    replyToMode: params.entry.reply?.source === "implicit" ? params.entry.reply.mode : undefined,
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
  if (operation.state === "prepared" || operation.state === "queued") {
    return "continue";
  }
  if (operation.state === "unknown") {
    const settled = await settleQueuedFailure({
      ...opts,
      error: "delivery owner state is unknown",
    });
    return settled === "already-gone" ? "failed" : settled;
  }
  try {
    const suppressReceipt =
      operation.state !== "delivered" && typeof opts.entry.completionRetention === "object";
    await ackRecoveredDelivery(
      opts.entry,
      opts.stateDir,
      suppressReceipt ? { suppressCompletionReceipt: true } : undefined,
    );
  } catch (error) {
    const errMsg = `failed to ack owner-${operation.state} delivery: ${formatErrorMessage(error)}`;
    opts.onFailed?.(opts.entry, errMsg);
    opts.log.warn(`Delivery entry ${opts.entry.id} ${errMsg}`);
    return "failed";
  }
  if (operation.state === "delivered") {
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
  } else if (operation.state === "rejected") {
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
  } else if (operation.state === "suppressed") {
    // A restart can separate owner suppression from queue ack. Publish only
    // after custody ends; a stale/missing owner proves no suppression.
    emitQueuedAuditTerminals(opts.entry, () =>
      uniformOutboundAuditTerminals(queuedPayloadCount(opts.entry), {
        outcome: "suppressed",
        reasonCode: "no_visible_payload",
      }),
    );
  }
  opts.onRecovered?.(opts.entry);
  return "recovered";
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
  shouldContinue?: () => boolean;
  onRecovered?: (entry: QueuedDelivery) => void;
  onFailed?: (entry: QueuedDelivery, errMsg: string) => void;
}): Promise<"recovered" | "failed" | "moved-to-failed" | "already-gone" | "stopped"> {
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
      return settleQueuedFailure({ ...opts, error: errMsg });
    }
  }
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  // Deliberately process-local: a crash may lose best-effort observers, but
  // persisting plugin callbacks must never become part of delivery custody.
  const messageSentEvents: IndexedMessageSentEvent[] = [];
  let postSendState: QueuedPostSendState | undefined;
  let platformSendStarted = false;
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
    opts.onFailed?.(entry, errMsg);
    return settleQueuedFailure({ ...opts, error: errMsg, claimedAttemptId: producerClaimId });
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
    const deliveryParams = buildRecoveryDeliverParams(
      entry,
      opts.cfg,
      opts.stateDir,
      producerClaimId,
    );
    let dispatchAdmitted = false;
    const result = await opts.deliver({
      ...deliveryParams,
      onPayloadDeliveryOutcome: collectPayloadOutcome,
      onMessageSentEvent: (event, sourceIndex) => messageSentEvents.push({ sourceIndex, event }),
      onPlatformSendStart: async () => {
        platformSendStarted = true;
      },
      onDeliveryResult: async (deliveryResult) => {
        collectResults([deliveryResult]);
        postSendState ??= await persistRecoveredPostSendState({
          entry,
          log: opts.log,
          stateDir: opts.stateDir,
          ...(producerClaimId ? { producerClaimId } : {}),
        });
      },
      onPlatformSendDispatch: async () => {
        await deliveryParams.onPlatformSendDispatch?.();
        if (dispatchAdmitted) {
          return;
        }
        if (opts.shouldContinue?.() === false) {
          throw new OutboundDeliveryAdmissionClosedError();
        }
        // One admitted attempt owns its complete adapter fanout. Later parts
        // must settle even when shutdown starts after the first dispatch.
        dispatchAdmitted = true;
      },
    });
    const results = isOutboundDeliveryResultArray(result) ? result : [];
    const failedOutcomes = payloadOutcomes.filter((outcome) => outcome.status === "failed");
    const adapterReturnedNoIdentity = payloadOutcomes.some(
      (outcome) =>
        outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
    );
    if (
      adapterReturnedNoIdentity ||
      (results.length === 0 &&
        // Reported failures carry dispatch evidence and own retry classification.
        // Adapter handoff alone cannot override a proven pre-send failure.
        failedOutcomes.length === 0 &&
        platformSendStarted &&
        !areOutboundPayloadsIntentionallySuppressed(payloadOutcomes))
    ) {
      const error = "recovered platform send returned no delivery identity";
      await recordRecoveredFailure(
        failDeliveryAfterPlatformSend,
        entry,
        error,
        opts.stateDir,
        producerClaimId,
      );
      if (entry.deliveryCompletion) {
        await settleDurableDelivery(
          entry.deliveryCompletion,
          { platformSendStarted: true },
          opts.stateDir,
        );
      }
      opts.onFailed?.(entry, error);
      opts.log.warn(`Delivery entry ${entry.id} ${error}; preserving unknown_after_send`);
      // The pending row still owns reconciliation. Emit its one stable terminal
      // only when recovery later acks or dead-letters that durable custody.
      return "failed";
    }
    if (results.length > 0) {
      deliveredResults = [...results];
    }
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
      const terminalResult = results.at(-1);
      await settleDurableDelivery(
        entry.deliveryCompletion,
        terminalResult ? { result: terminalResult } : { platformSendStarted: false },
        opts.stateDir,
      );
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
          // Proven omission clears the handoff marker so a restart can safely retry.
          await recordRecoveredFailure(
            areOutboundPayloadsIntentionallySuppressed(payloadOutcomes)
              ? failDeliveryBeforePlatformSend
              : failDelivery,
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
    if (isOutboundDeliveryAdmissionClosedError(err)) {
      restoreDeliveryAttemptBeforeDispatch(
        entry,
        reservation.attemptCount,
        opts.stateDir,
        producerClaimId,
      );
      return "stopped";
    }
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
      return settleQueuedFailure({
        ...opts,
        error: errMsg,
        claimedAttemptId: producerClaimId,
        ...(permanentPlatformRejection
          ? { rejectionError: permanentPlatformRejection.message }
          : {}),
        events: messageSentEvents,
        // Identified results already exited through hasSendEvidence. These
        // canonical no-send decisions retain suppression reasons across restart.
        terminals: failedOutboundAuditTerminals({
          payloadCount: queuedPayloadCount(entry),
          results: deliveredResults,
          payloadOutcomes,
          failureStage: "queue",
        }),
      });
    }
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
    return "failed";
  } finally {
    // Early fallback acks make the row non-replayable before the adapter has
    // necessarily finished reading every payload. Release only after the whole
    // recovered attempt settles, and only if no pending row still owns it.
    cancelDeliveryQueueMediaRetention(mediaRecoveryLeaseId, opts.stateDir);
    const pending = await loadUnfinishedDelivery(entry.id, opts.stateDir).catch(() => entry);
    if (!pending) {
      await releaseSpoolArtifacts(recoverySpoolPaths, opts.stateDir);
    }
  }
}

type QueuedRecoveryContext =
  | {
      kind: "startup";
      summary: DeliveryRecoverySummary;
      deadline: number;
      onDeadlineExceeded: () => void;
      shouldContinue?: () => boolean;
    }
  | {
      kind: "drain";
      logLabel: string;
      selectEntry: (entry: QueuedDelivery, now: number) => DeliveryRecoveryDrainDecision;
      shouldContinue?: () => boolean;
    };

/** Startup and reconnect share custody, admission, retry, and settlement ordering. */
async function processQueuedRecovery(
  opts: Parameters<typeof drainQueuedEntry>[0],
  context: QueuedRecoveryContext,
): Promise<"continue" | "stop"> {
  const { entry, log } = opts;
  if (context.shouldContinue?.() === false) {
    return "stop";
  }
  const label =
    context.kind === "startup" ? `Delivery ${entry.id}` : `${context.logLabel}: entry ${entry.id}`;
  if (entry.settlement) {
    await settleQueuedFailure({ ...opts, error: entry.settlement.error });
    return "continue";
  }
  if (hasActiveDeliveryOwner(entry, Date.now())) {
    if (context.kind === "startup") {
      log.info(`Recovery skipped for delivery ${entry.id}: active platform owner`);
    }
    return "continue";
  }
  const admission = resolveDeferredDeliveryAdmission(
    {
      cfg: opts.cfg,
      channel: entry.channel,
      to: entry.to,
      accountId: entry.accountId,
      phase: "recovery",
    },
    { agentId: entry.session?.agentId },
  );
  if (admission.status !== "allowed") {
    const settled = await settleQueuedFailure({ ...opts, error: admission.reason });
    const logLabel = context.kind === "startup" ? "Recovery" : context.logLabel;
    if (settled === "already-gone") {
      log.info(
        `${logLabel}: entry ${entry.id} changed ownership before admission failure was persisted`,
      );
    } else {
      if (context.kind === "startup") {
        context.summary.failed += 1;
      }
      log.warn(
        `${logLabel}: entry ${entry.id} permanently rejected before recovery: ${admission.reason}`,
      );
    }
    return "continue";
  }
  const decision =
    context.kind === "drain" ? context.selectEntry(entry, Date.now()) : { match: true };
  if (!decision.match) {
    log.info(`${label} no longer matches, skipping`);
    return "continue";
  }
  const maxRetries = resolveMaxRetries(entry);
  const attemptCount = resolveAttemptCount(entry);
  if (attemptCount >= maxRetries && !needsUnknownSendReconciliation(entry)) {
    if (context.kind === "startup") {
      log.warn(`${label} exceeded max retries (${attemptCount}/${maxRetries}) — moving to failed/`);
      context.summary.skippedMaxRetries += 1;
    }
    const settled = await settleQueuedFailure({
      ...opts,
      error: "delivery retry budget exhausted",
    });
    if (context.kind === "drain" && settled === "moved-to-failed") {
      log.warn(`${label} exceeded max retries and was moved to failed/`);
    }
    return "continue";
  }
  const eligibility = isDeliveryRecoveryRetryEligible(entry, Date.now());
  if (!decision.bypassBackoff && !eligibility.eligible) {
    if (context.kind === "startup") {
      context.summary.deferredBackoff += 1;
    }
    log.info(
      `${label} not ready for retry yet — backoff ${eligibility.remainingBackoffMs}ms remaining`,
    );
    return "continue";
  }
  if (
    (await recoveryCoordinator.waitForReplay(
      context.kind === "startup" ? context.deadline : undefined,
    )) === "deadline-exceeded"
  ) {
    if (context.kind === "startup") {
      context.onDeadlineExceeded();
    }
    return "stop";
  }
  // Pacing is the final await before a new durable attempt is admitted. A
  // lifecycle fence here leaves the untouched row and retry metadata intact.
  if (context.shouldContinue?.() === false) {
    return "stop";
  }
  const result = await drainQueuedEntry({
    ...opts,
    ...(context.shouldContinue ? { shouldContinue: context.shouldContinue } : {}),
    onRecovered: (recovered) => {
      if (context.kind === "startup") {
        context.summary.recovered += 1;
        log.info(`Recovered delivery ${recovered.id} on ${recovered.channel}`);
      } else {
        log.info(`${context.logLabel}: drained delivery ${recovered.id} on ${recovered.channel}`);
      }
    },
    onFailed: (failed, error) => {
      if (context.kind === "startup") {
        context.summary.failed += 1;
      }
      if (isPermanentDeliveryError(error)) {
        log.warn(`${label} hit permanent error — moving to failed/: ${error}`);
      } else {
        log.warn(
          context.kind === "startup"
            ? `Retry failed for delivery ${failed.id}: ${error}`
            : `${context.logLabel}: retry failed for entry ${failed.id}: ${error}`,
        );
      }
    },
  });
  return result === "stopped" ? "stop" : "continue";
}

export async function drainPendingDeliveriesCore(opts: {
  drainKey: string;
  logLabel: string;
  cfg: OpenClawConfig;
  log: RecoveryLogger;
  stateDir?: string;
  deliver: DeliverFn;
  selectEntry: (entry: QueuedDelivery, now: number) => DeliveryRecoveryDrainDecision;
  shouldContinue?: () => boolean;
}): Promise<void> {
  const drained = await recoveryCoordinator.withDrain(opts.drainKey, async () => {
    const now = Date.now();
    const matchingEntries = (await loadUnfinishedDeliveries(opts.stateDir)).filter(
      (entry) => entry.settlement || opts.selectEntry(entry, now).match,
    );
    await recoveryCoordinator.scan({
      entries: matchingEntries,
      loadEntry: (id) => loadUnfinishedDelivery(id, opts.stateDir),
      onMissingEntry: (entry) => {
        opts.log.info(`${opts.logLabel}: entry ${entry.id} already gone, skipping`);
      },
      // Poll-driven reconnect drains can repeat while a live send owns its
      // claim. Leave conflicts silent so reconnect polling cannot starve it.
      onEntry: (entry) =>
        processQueuedRecovery(
          { ...opts, entry },
          {
            kind: "drain",
            logLabel: opts.logLabel,
            selectEntry: opts.selectEntry,
            ...(opts.shouldContinue ? { shouldContinue: opts.shouldContinue } : {}),
          },
        ),
    });
  });
  if (!drained) {
    opts.log.info(`${opts.logLabel}: already in progress for ${opts.drainKey}, skipping`);
  }
}

/**
 * Scan the canonical delivery queue and retry any pending entries.
 * The gateway startup owner runs legacy migration before invoking this recovery pass.
 * Uses exponential backoff and moves entries that exhaust their retry budget to failed/.
 */
export async function recoverPendingDeliveries(opts: {
  deliver: DeliverFn;
  log: RecoveryLogger;
  cfg: OpenClawConfig;
  stateDir?: string;
  /** Maximum wall-clock time for recovery in ms. Remaining entries are deferred to next startup. Default: 60 000. */
  maxRecoveryMs?: number;
  shouldContinue?: () => boolean;
}): Promise<DeliveryRecoverySummary> {
  const pending = await loadUnfinishedDeliveries(opts.stateDir);
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
    loadEntry: (id) => loadUnfinishedDelivery(id, opts.stateDir),
    deadlineMs: deadline,
    onDeadlineExceeded,
    onClaimConflict: (entry) => {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already being processed`);
    },
    onMissingEntry: (entry) => {
      opts.log.info(`Recovery skipped for delivery ${entry.id}: already gone`);
    },
    onEntry: (entry) =>
      processQueuedRecovery(
        { ...opts, entry },
        {
          kind: "startup",
          summary,
          deadline,
          onDeadlineExceeded,
          ...(opts.shouldContinue ? { shouldContinue: opts.shouldContinue } : {}),
        },
      ),
  });

  opts.log.info(
    `Delivery recovery complete: ${summary.recovered} recovered, ${summary.failed} failed, ${summary.skippedMaxRetries} skipped (max retries), ${summary.deferredBackoff} deferred (backoff)`,
  );
  return summary;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
