// Owns queued delivery execution, custody transitions, and terminal cleanup.
import { hasTrustedMessageAuditListeners } from "../../audit/message-audit-events.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsParams, PlatformSendRoute } from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import {
  createQueuedDeliveryOwner,
  isDeliveryAbortError,
  persistQueuedPostSendState,
  persistQueuedPreSendState,
  type QueuedPostSendState,
  type QueuedPreSendState,
} from "./deliver-queue-state.js";
import {
  OutboundDeliveryError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { runOutboundDeliveryCommitHooks } from "./delivery-commit-hooks.js";
import { rejectDurableDelivery, settleDurableDelivery } from "./delivery-completion.js";
import {
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformSendDispatched,
  moveToFailed,
} from "./delivery-queue-storage.js";
import { createMessageSentEmitter, type MessageSentEvent } from "./message-sent-hook.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");

export async function deliverOutboundPayloadsWithQueueCleanup(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
  auditStartedAt: number,
  producerClaimId?: string,
  producerLeaseSignal?: AbortSignal,
): Promise<OutboundDeliveryResult[]> {
  // Lease loss revokes queue mutation authority. Caller cancellation still
  // follows the normal abort cleanup path through the combined signal.
  const throwIfProducerLeaseLost = (): void => {
    if (producerLeaseSignal?.aborted) {
      throw producerLeaseSignal.reason;
    }
  };
  const payloadCount = params.preparedBatch?.sourcePayloadCount ?? params.payloads.length;
  // Wrap onError to detect partial failures under bestEffort mode.
  // When bestEffort is true, per-payload errors are caught and passed to onError
  // without throwing — so the outer try/catch never fires. We track whether any
  // payload failed so we can call failDelivery instead of ackDelivery.
  let hadPartialFailure = false;
  let lastPayloadError: unknown;
  let partialFailuresAreProvenNotSent = true;
  const ownsAuditTerminal = params.deliveryQueueId === undefined;
  const auditPayloadOutcomes =
    ownsAuditTerminal && hasTrustedMessageAuditListeners()
      ? ([] as OutboundPayloadDeliveryOutcome[])
      : undefined;
  const reusableProducerClaimId = params.reusePendingDeliveryIntent ? producerClaimId : undefined;
  // Reusable producer custody must observe ambiguous adapter outcomes even when
  // no audit listener is installed; audit subscriptions are not delivery proof.
  const stablePayloadOutcomes = reusableProducerClaimId
    ? ([] as OutboundPayloadDeliveryOutcome[])
    : undefined;
  const queuePolicy = params.queuePolicy ?? "best_effort";
  const platformQueueId = queueId ?? params.deliveryQueueId;
  const platformQueuePolicy = queueId ? queuePolicy : (params.queuePolicy ?? "required");
  const platformQueueStateDir = queueId ? undefined : params.deliveryQueueStateDir;
  const exactReconciliationRequired =
    params.requireUnknownSendReconciliation === true && platformQueueId !== undefined;
  let queuedPreSendState: QueuedPreSendState | undefined;
  let queuedPostSendState: QueuedPostSendState | undefined;
  let platformSendStarted = false;
  let platformSendRoute: PlatformSendRoute | undefined;
  let deliveredResults: OutboundDeliveryResult[] = [];
  let commitHooksRun = false;
  const settleDeliveryCompletion = async (
    result: OutboundDeliveryResult | undefined,
  ): Promise<void> => {
    if (!params.deliveryCompletion) {
      return;
    }
    await settleDurableDelivery(
      params.deliveryCompletion,
      result ? { result } : { platformSendStarted },
      platformQueueStateDir,
    );
  };
  // Deliberately process-local: message_sent is best-effort after queue
  // settlement, not a durable plugin outbox or a reason to retry delivery.
  const messageSentEvents: MessageSentEvent[] = [];
  const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
  const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
    hookRunner: getGlobalHookRunner(),
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    sessionKeyForInternalHooks,
    isGroup: params.mirror?.isGroup,
    groupId: params.mirror?.groupId,
    runId: params.preparedBatch?.runId,
    logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
  });
  if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) {
    log.warn(
      `${OUTBOUND_DELIVERY_LOG_SCOPE}: session.agentId present without session key; internal message:sent hook will be skipped`,
      { channel: params.channel, to: params.to, agentId: params.session.agentId },
    );
  }
  const flushMessageSentEvents = (): void => {
    if (params.deferCommitHooks) {
      return;
    }
    for (const event of messageSentEvents) {
      emitMessageSent(event);
    }
    messageSentEvents.length = 0;
  };
  const queueOwner = queueId
    ? createQueuedDeliveryOwner({
        queueId,
        expectedPlatformSendAttemptId: () => producerClaimId,
      })
    : undefined;
  const ackOwnedQueue = (options?: { suppressCompletionReceipt?: boolean }) => {
    throwIfProducerLeaseLost();
    if (!queueOwner) {
      throw new Error("Queued delivery acknowledgement requires a queue id");
    }
    return queueOwner.ack(options);
  };
  const recordOwnedQueueFailure = (
    record: typeof failDelivery | typeof failDeliveryAfterPlatformSend,
    error: string,
  ) => {
    throwIfProducerLeaseLost();
    if (!queueOwner) {
      throw new Error("Queued delivery failure requires a queue id");
    }
    return queueOwner.fail(record, error);
  };
  const persistOwnedPostSendState = () => {
    throwIfProducerLeaseLost();
    if (!queueId) {
      throw new Error("Queued delivery post-send state requires a queue id");
    }
    return persistQueuedPostSendState({
      queueId,
      queuePolicy,
      ...(reusableProducerClaimId ? { producerClaimId: reusableProducerClaimId } : {}),
      ...(producerClaimId ? { expectedPlatformSendAttemptId: producerClaimId } : {}),
    });
  };
  const emitTerminals = (
    terminals: Parameters<typeof emitOutboundAuditTerminals>[0]["terminals"],
  ): void => {
    if (!ownsAuditTerminal) {
      return;
    }
    emitOutboundAuditTerminals({
      context: params,
      terminals,
      startedAt: auditStartedAt,
      ...(queueId ? { queueId } : {}),
    });
  };
  const runCommitHooksAfterAck = async (): Promise<void> => {
    if (queuedPostSendState !== "acked" || params.deferCommitHooks || commitHooksRun) {
      return;
    }
    commitHooksRun = true;
    flushMessageSentEvents();
    if (deliveredResults.length > 0) {
      await runOutboundDeliveryCommitHooks(deliveredResults);
    }
  };
  const wrappedParams: DeliverOutboundPayloadsParams = {
    ...params,
    // A provider marker can represent the whole durable intent only when one payload owns it.
    // Adapters must narrow further when one payload can fan out into multiple platform sends.
    ...(exactReconciliationRequired && params.payloads.length === 1
      ? { deliveryQueueId: platformQueueId }
      : { deliveryQueueId: undefined }),
    requiredUnknownSendReconciliation: exactReconciliationRequired,
    onPlatformSendStart: async (route) => {
      params.abortSignal?.throwIfAborted();
      platformSendRoute = route;
      if (platformQueueId && !exactReconciliationRequired && queuedPreSendState === undefined) {
        queuedPreSendState = await persistQueuedPreSendState({
          queueId: platformQueueId,
          queuePolicy: platformQueuePolicy,
          stateDir: platformQueueStateDir,
          route,
          producerClaimId,
          // Recovery sends read queue-owned media. Removing the row prevents a
          // duplicate replay, but the active adapter still needs the files.
          retainSpoolArtifacts: queueId === null && params.deliveryQueueId !== undefined,
        });
        if (queueId && queuedPreSendState === "acked") {
          queuedPostSendState = "acked";
        }
      }
      params.abortSignal?.throwIfAborted();
      await params.onPlatformSendStart?.(route);
      params.abortSignal?.throwIfAborted();
      platformSendStarted = true;
    },
    onPlatformSendDispatch: async () => {
      params.abortSignal?.throwIfAborted();
      // Once any payload returns an identity, unknown-after-send protects the whole batch.
      // A later payload dispatch must not regress that durable evidence to attempt-started.
      if (platformQueueId && queuedPreSendState !== "acked" && queuedPostSendState === undefined) {
        try {
          if (producerClaimId) {
            await markDeliveryPlatformSendDispatched(
              platformQueueId,
              platformQueueStateDir,
              platformSendRoute,
              producerClaimId,
            );
          } else {
            await markDeliveryPlatformSendDispatched(
              platformQueueId,
              platformQueueStateDir,
              platformSendRoute,
            );
          }
          queuedPreSendState ??= "marked";
        } catch (dispatchMarkError) {
          // Any SQLite-fenced live producer must prove it still owns the row at
          // dispatch. Continuing after a failed refresh can outlive the lease and
          // let recovery duplicate a recipient-visible send.
          if (exactReconciliationRequired || producerClaimId) {
            throw dispatchMarkError;
          }
          log.warn(
            `failed to refresh queued delivery ${platformQueueId} at platform dispatch; continuing best-effort send: ${formatErrorMessage(dispatchMarkError)}`,
          );
        }
      }
      params.abortSignal?.throwIfAborted();
      await params.onPlatformSendDispatch?.();
      params.abortSignal?.throwIfAborted();
    },
    onError: (err: unknown, payload: NormalizedOutboundPayload) => {
      throwIfProducerLeaseLost();
      hadPartialFailure = true;
      lastPayloadError = err;
      partialFailuresAreProvenNotSent &&= isProvenDeliveryNotSentError(err);
      params.onError?.(err, payload);
    },
    ...(auditPayloadOutcomes || stablePayloadOutcomes
      ? {
          onPayloadDeliveryOutcome: (outcome: OutboundPayloadDeliveryOutcome) => {
            auditPayloadOutcomes?.push(outcome);
            stablePayloadOutcomes?.push(outcome);
            params.onPayloadDeliveryOutcome?.(outcome);
          },
        }
      : {}),
    onDeliveryResult: async (result) => {
      deliveredResults.push(result);
      if (queueId && queuedPostSendState === undefined) {
        queuedPostSendState = await persistOwnedPostSendState();
      }
      await params.onDeliveryResult?.(result);
    },
    onMessageSentEvent: (event, sourceIndex) => {
      messageSentEvents.push(event);
      params.onMessageSentEvent?.(event, sourceIndex);
    },
  };
  let platformResultsReturned = false;

  try {
    throwIfProducerLeaseLost();
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    // Core reconciles adapter progress objects with hook-bearing final results.
    deliveredResults = results;
    throwIfProducerLeaseLost();
    platformResultsReturned = true;
    if (
      queueId &&
      results.length > 0 &&
      stablePayloadOutcomes?.some(
        (outcome) =>
          outcome.status === "suppressed" && outcome.reason === "adapter_returned_no_identity",
      )
    ) {
      const error = "platform send returned no delivery identity for part of the delivery batch";
      await recordOwnedQueueFailure(failDeliveryAfterPlatformSend, error);
      queuedPostSendState = "failed";
      throw new OutboundDeliveryError(error, {
        cause: new Error(error),
        results,
        payloadOutcomes: stablePayloadOutcomes,
        stage: "platform_send",
      });
    }
    if (!queueId) {
      await settleDeliveryCompletion(results.at(-1));
      if (!params.deferCommitHooks) {
        flushMessageSentEvents();
        await runOutboundDeliveryCommitHooks(results);
      }
      emitTerminals(() =>
        hadPartialFailure
          ? failedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "platform_send",
            })
          : completedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
            }),
      );
      return results;
    }
    if (queueId) {
      if (hadPartialFailure) {
        const partialSendEvidence =
          results.length > 0 ||
          (lastPayloadError instanceof OutboundDeliveryError && lastPayloadError.sentBeforeError);
        const postSendState =
          queuedPostSendState ??
          (partialSendEvidence ? await persistOwnedPostSendState() : undefined);
        const error = "partial delivery failure (bestEffort)";
        if (postSendState === undefined || postSendState === "marked") {
          if (!partialSendEvidence && partialFailuresAreProvenNotSent) {
            // Proven-not-sent partial failures must not be recovered by the queue drain.
            // The caller has already received the error and owns the retry.
            await moveToFailed(queueId, platformQueueStateDir, producerClaimId ?? null).catch(
              (err: unknown) => {
                log.warn(
                  `failed to remove queued delivery ${queueId} after proven-not-sent partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`,
                );
              },
            );
          } else {
            await recordOwnedQueueFailure(failDelivery, error).catch((err: unknown) => {
              log.warn(
                `failed to mark queued delivery ${queueId} as failed after partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`,
              );
            });
          }
        } else if (postSendState === "acked") {
          // Direct ack is the fallback when the post-send marker cannot be
          // written. Once the row is gone, recovery cannot run these hooks.
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "platform_send",
            }),
          );
        }
      } else {
        const postSendState =
          queuedPostSendState ??
          (results.length > 0 || queuedPreSendState === "marked"
            ? await persistOwnedPostSendState()
            : queuedPreSendState === "acked"
              ? "acked"
              : undefined);
        await settleDeliveryCompletion(results.at(-1));
        if (results.length === 0 && postSendState === "marked") {
          // The provider was invoked but returned no recipient-visible identity;
          // never convert that ambiguous platform outcome into a success receipt.
          await recordOwnedQueueFailure(
            failDeliveryAfterPlatformSend,
            "platform send returned no delivery identity",
          );
          queuedPostSendState = "failed";
          emitTerminals(() =>
            uniformOutboundAuditTerminals(payloadCount, {
              outcome: "unknown",
              failureStage: "platform_send",
            }),
          );
          return results;
        }
        const acked =
          postSendState === "acked"
            ? true
            : postSendState === "failed"
              ? false
              : await (
                  results.length === 0 && typeof params.completionRetention === "object"
                    ? ackOwnedQueue({ suppressCompletionReceipt: true })
                    : ackOwnedQueue()
                )
                  .then(() => true)
                  .catch(async (err: unknown) => {
                    const hasSendEvidence =
                      deliveredResults.length > 0 || queuedPreSendState !== undefined;
                    try {
                      if (hasSendEvidence) {
                        await recordOwnedQueueFailure(
                          failDeliveryAfterPlatformSend,
                          `failed to ack sent delivery: ${formatErrorMessage(err)}`,
                        );
                        queuedPostSendState = "failed";
                      } else {
                        await recordOwnedQueueFailure(
                          failDelivery,
                          `failed to ack unsent delivery: ${formatErrorMessage(err)}`,
                        );
                      }
                    } catch (persistErr: unknown) {
                      log.warn(
                        `failed to preserve queued delivery ${queueId} after ack failure: ${formatErrorMessage(persistErr)}`,
                      );
                    }
                    if (queuePolicy === "required") {
                      throw err;
                    }
                    log.warn(
                      hasSendEvidence
                        ? `failed to ack queued delivery ${queueId}; preserved unknown-after-send state: ${formatErrorMessage(err)}`
                        : `failed to ack unsent queued delivery ${queueId}; retained it for retry: ${formatErrorMessage(err)}`,
                    );
                    return false;
                  });
        if (acked) {
          queuedPostSendState = "acked";
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            completedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
            }),
          );
        }
      }
    }
    return results;
  } catch (err) {
    throwIfProducerLeaseLost();
    if (err instanceof OutboundDeliveryError && err.results.length > 0) {
      deliveredResults = err.results;
    }
    const hasPlatformSendEvidence =
      deliveredResults.length > 0 ||
      queuedPreSendState === "marked" ||
      queuedPostSendState === "marked" ||
      (err instanceof OutboundDeliveryError && err.sentBeforeError) ||
      stablePayloadOutcomes?.some((outcome) => outcome.status === "sent") === true;
    if (queueId) {
      if (queuedPreSendState === "acked") {
        // Best-effort fallback removed durable custody before provider I/O.
        // This process is now the only owner that can publish terminal observers.
        await runCommitHooksAfterAck();
        emitTerminals(() =>
          failedOutboundAuditTerminals({
            payloadCount,
            results: deliveredResults,
            payloadOutcomes: auditPayloadOutcomes ?? [],
            failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
          }),
        );
      } else if (isDeliveryAbortError(err)) {
        if (hasPlatformSendEvidence) {
          if (queuedPostSendState !== "failed") {
            await recordOwnedQueueFailure(
              failDeliveryAfterPlatformSend,
              `delivery aborted after platform send: ${formatErrorMessage(err)}`,
            );
            queuedPostSendState = "failed";
          }
          emitTerminals(() =>
            uniformOutboundAuditTerminals(payloadCount, {
              outcome: "unknown",
              failureStage: "platform_send",
            }),
          );
        } else if (params.abortSignal?.aborted !== true) {
          await recordOwnedQueueFailure(failDelivery, formatErrorMessage(err)).catch(
            (failErr: unknown) => {
              log.warn(
                `failed to preserve queued delivery ${queueId} after provider abort: ${formatErrorMessage(failErr)}`,
              );
            },
          );
        } else if (
          await (
            producerClaimId ? ackOwnedQueue({ suppressCompletionReceipt: true }) : ackOwnedQueue()
          )
            .then(() => true)
            .catch(() => false)
        ) {
          queuedPostSendState = "acked";
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount,
              results: deliveredResults,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "queue",
            }),
          );
        }
      } else if (!platformResultsReturned) {
        const sendEvidence =
          deliveredResults.length > 0 ||
          (err instanceof OutboundDeliveryError && err.sentBeforeError);
        if (sendEvidence) {
          try {
            queuedPostSendState ??= await persistOwnedPostSendState();
            if (queuedPostSendState === "marked") {
              await recordOwnedQueueFailure(failDeliveryAfterPlatformSend, formatErrorMessage(err));
              queuedPostSendState = "failed";
            }
          } catch (persistErr: unknown) {
            // Do not convert concrete send evidence back into a generic retry.
            // All canonical state transitions failed, so retain the original row.
            log.warn(
              `failed to preserve queued delivery ${queueId} post-send evidence: ${formatErrorMessage(persistErr)}`,
            );
          }
          await runCommitHooksAfterAck();
          if (queuedPostSendState === "acked") {
            emitTerminals(() =>
              failedOutboundAuditTerminals({
                payloadCount,
                results: deliveredResults,
                payloadOutcomes: auditPayloadOutcomes ?? [],
                failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
              }),
            );
          }
        } else {
          const permanentRejection = findPlatformMessageRejectedError(err);
          let terminalRejectionHandled = false;
          if (permanentRejection) {
            let ownerRejected = false;
            let queueAcked = false;
            try {
              const ambiguousStableRejection =
                producerClaimId !== undefined &&
                (deliveredResults.length > 0 ||
                  queuedPostSendState === "marked" ||
                  stablePayloadOutcomes?.some((outcome) => outcome.status === "sent"));
              if (ambiguousStableRejection) {
                await recordOwnedQueueFailure(
                  failDeliveryAfterPlatformSend,
                  `delivery partially sent before permanent rejection: ${permanentRejection.message}`,
                );
                queuedPostSendState = "failed";
                terminalRejectionHandled = true;
              } else {
                if (params.deliveryCompletion) {
                  await rejectDurableDelivery(
                    params.deliveryCompletion,
                    permanentRejection.message,
                    platformQueueStateDir,
                  );
                  ownerRejected = true;
                }
                await (producerClaimId
                  ? ackOwnedQueue({ suppressCompletionReceipt: true })
                  : ackOwnedQueue());
                queueAcked = true;
              }
            } catch (rejectionError) {
              log.warn(
                `failed to finalize permanently rejected delivery ${queueId}: ${formatErrorMessage(rejectionError)}`,
              );
            }
            terminalRejectionHandled ||= ownerRejected || queueAcked;
            if (queueAcked) {
              queuedPostSendState = "acked";
              await runCommitHooksAfterAck();
              emitTerminals(() =>
                failedOutboundAuditTerminals({
                  payloadCount,
                  results: deliveredResults,
                  payloadOutcomes: auditPayloadOutcomes ?? [],
                  failureStage: "platform_send",
                }),
              );
            }
          }
          if (!terminalRejectionHandled) {
            const recordFailure = isProvenDeliveryNotSentError(err)
              ? failDeliveryBeforePlatformSend
              : failDelivery;
            await recordOwnedQueueFailure(recordFailure, formatErrorMessage(err)).catch(
              (failErr: unknown) => {
                log.warn(
                  `failed to mark queued delivery ${queueId} as failed: ${formatErrorMessage(failErr)}`,
                );
              },
            );
          }
        }
      }
    } else {
      flushMessageSentEvents();
      emitTerminals(() =>
        failedOutboundAuditTerminals({
          payloadCount,
          results: deliveredResults,
          payloadOutcomes: auditPayloadOutcomes ?? [],
          failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
        }),
      );
    }
    throw err;
  }
}

/** Core delivery logic (extracted for queue wrapper). */
