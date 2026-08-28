// Owns queued delivery execution, custody transitions, and terminal cleanup.
import type { AuditMessageFailureStage } from "../../audit/audit-event-types.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import type { DeliverOutboundPayloadsParams, PlatformSendRoute } from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import { toOutboundDeliveryError } from "./deliver-hooks.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import {
  createQueuedDeliveryOwner,
  hasUnconfirmedOutboundSends,
  isDeliveryAbortError,
  persistQueuedPostSendState,
  persistQueuedPreSendState,
  type QueuedPostSendState,
  type QueuedPreSendState,
} from "./deliver-queue-state.js";
import {
  OutboundDeliveryError,
  PlatformMessageNotDispatchedError,
  type OutboundDeliveryResult,
  type OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import { runOutboundDeliveryCommitHooks } from "./delivery-commit-hooks.js";
import { rejectDurableDelivery, settleDurableDelivery } from "./delivery-completion.js";
import { releaseSpoolArtifacts } from "./delivery-queue-media-spool.js";
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
  emitOutboundAuditLifecycle,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
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
      throw toOutboundDeliveryError({
        error: producerLeaseSignal.reason,
        results: deliveredResults,
        payloadOutcomes,
        stage: "queue",
      });
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
  // Custody accounting must not depend on producer reuse or audit subscriptions.
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
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
  let platformSendSourceIndex: number | undefined;
  const auditPlatformStartedPayloads = new Set<number>();
  const platformDispatchedPayloads = new Set<number>();
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
    onPlatformSendStart: async (route, sourceIndex) => {
      params.abortSignal?.throwIfAborted();
      platformSendRoute = route;
      platformSendSourceIndex = sourceIndex;
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
      if (
        platformQueueId &&
        sourceIndex !== undefined &&
        !auditPlatformStartedPayloads.has(sourceIndex)
      ) {
        auditPlatformStartedPayloads.add(sourceIndex);
        emitOutboundAuditLifecycle({
          context: params,
          outcome: "platform_started",
          queueId: platformQueueId,
          startedAt: auditStartedAt,
          payloadIndexes: [sourceIndex],
        });
      }
      params.abortSignal?.throwIfAborted();
      await params.onPlatformSendStart?.(route);
      params.abortSignal?.throwIfAborted();
      platformSendStarted = true;
    },
    onDirectAdapterHandoff: async () => {
      params.abortSignal?.throwIfAborted();
      await params.onPlatformSendDispatch?.();
      params.abortSignal?.throwIfAborted();
    },
    onPlatformSendDispatch: async () => {
      params.abortSignal?.throwIfAborted();
      // A failed progress marker may mean claim loss. Revalidate before another
      // send; the dispatch owner preserves any stronger unknown-after-send state.
      if (
        platformQueueId &&
        queuedPreSendState !== "acked" &&
        (queuedPostSendState === undefined || queuedPostSendState === "unmarked")
      ) {
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
      if (platformSendSourceIndex !== undefined) {
        platformDispatchedPayloads.add(platformSendSourceIndex);
      }
    },
    onError: (err: unknown, payload: NormalizedOutboundPayload) => {
      throwIfProducerLeaseLost();
      hadPartialFailure = true;
      lastPayloadError = err;
      partialFailuresAreProvenNotSent &&= isProvenDeliveryNotSentError(err);
      params.onError?.(err, payload);
    },
    onPayloadDeliveryOutcome: (outcome) => {
      if (
        outcome.status === "failed" &&
        platformDispatchedPayloads.has(outcome.index) &&
        !isProvenDeliveryNotSentError(outcome.error)
      ) {
        outcome.sentBeforeError = true;
      }
      payloadOutcomes.push(outcome);
      params.onPayloadDeliveryOutcome?.(outcome);
    },
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
    const conversationAttemptAuthority =
      params.deliveryCompletion?.kind === "conversation"
        ? params.deliveryCompletion
        : params.conversationDeliveryAttemptAuthority;
    if (conversationAttemptAuthority) {
      // Conversation delivery was not stable-shipped before route fingerprints. An unfinished
      // legacy intent cannot be rebound safely after upgrade, so missing authority fails closed.
      if (!conversationAttemptAuthority.routeFingerprint || !params.onDeliveryAttempt) {
        throw new PlatformMessageNotDispatchedError(
          "Conversation delivery is missing its current route authorization",
          { cause: undefined, retryable: false },
        );
      }
      // One durable attempt admits its bounded adapter fanout/retries. A later queue or recovery
      // attempt rechecks from the serialized fingerprint; in-flight revocation is not promised.
      await params.onDeliveryAttempt();
      throwIfProducerLeaseLost();
    }
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    // Core reconciles adapter progress objects with hook-bearing final results.
    deliveredResults = results;
    throwIfProducerLeaseLost();
    platformResultsReturned = true;
    const unconfirmedSends = hasUnconfirmedOutboundSends({
      results,
      payloadOutcomes,
      platformSendStarted,
    });
    if (unconfirmedSends) {
      const error =
        results.length > 0
          ? "platform send returned no delivery identity for part of the delivery batch"
          : "platform send returned no delivery identity";
      if (queueId && queuedPostSendState !== "acked") {
        await recordOwnedQueueFailure(failDeliveryAfterPlatformSend, error);
        queuedPostSendState = "failed";
      }
      await settleDeliveryCompletion(undefined);
      // A retained row leaves terminal observers to recovery. A best-effort
      // pre-send ack removed that owner, so the live path still owes observers.
      if (results.length === 0 && queuedPostSendState === "failed") {
        return results;
      }
      // Recovery receives complete accounting and owns its failure transition;
      // live callers need an error so surviving receipts cannot mean success.
      if (results.length > 0 && params.deliveryQueueId === undefined) {
        throw new OutboundDeliveryError(error, {
          cause: new Error(error),
          results,
          payloadOutcomes,
          stage: "platform_send",
        });
      }
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
              payloadOutcomes,
              failureStage: "platform_send",
            })
          : completedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes,
            }),
      );
      return results;
    }
    if (queueId) {
      if (hadPartialFailure) {
        const partialSendEvidence =
          results.length > 0 ||
          payloadOutcomes.some(
            (outcome) => outcome.status === "failed" && outcome.sentBeforeError,
          ) ||
          (platformDispatchedPayloads.size > 0 && !partialFailuresAreProvenNotSent) ||
          (lastPayloadError instanceof OutboundDeliveryError && lastPayloadError.sentBeforeError);
        const postSendState =
          queuedPostSendState ??
          (partialSendEvidence ? await persistOwnedPostSendState() : undefined);
        const error = "partial delivery failure (bestEffort)";
        if (postSendState !== "acked" && postSendState !== "failed") {
          const recordFailure =
            postSendState === "unmarked"
              ? failDeliveryAfterPlatformSend
              : !partialSendEvidence && partialFailuresAreProvenNotSent
                ? failDeliveryBeforePlatformSend
                : failDelivery;
          await recordOwnedQueueFailure(recordFailure, error).catch((err: unknown) => {
            log.warn(
              `failed to mark queued delivery ${queueId} as failed after partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`,
            );
          });
        } else if (postSendState === "acked") {
          // A best-effort pre-send ack removed custody before provider I/O.
          // Recovery cannot run observers for that retired row.
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount,
              results,
              payloadOutcomes,
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
              payloadOutcomes,
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
      payloadOutcomes.some((outcome) => outcome.status === "sent");
    // Every terminal below reports the same failed batch; only the stage differs.
    const emitFailedTerminals = (failureStage: AuditMessageFailureStage) =>
      emitTerminals(() =>
        failedOutboundAuditTerminals({
          payloadCount,
          results: deliveredResults,
          payloadOutcomes,
          failureStage,
        }),
      );
    const platformSendFailureStage: AuditMessageFailureStage =
      err instanceof OutboundDeliveryError ? err.stage : "platform_send";
    if (queueId) {
      if (queuedPostSendState === "acked") {
        // Best-effort fallback removed durable custody before provider I/O.
        // This process is now the only owner that can publish terminal observers.
        await runCommitHooksAfterAck();
        emitFailedTerminals(platformSendFailureStage);
      } else if (isDeliveryAbortError(err)) {
        if (hasPlatformSendEvidence) {
          if (queuedPostSendState !== "failed") {
            await recordOwnedQueueFailure(
              failDeliveryAfterPlatformSend,
              `delivery aborted after platform send: ${formatErrorMessage(err)}`,
            );
            queuedPostSendState = "failed";
          }
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
          emitFailedTerminals("queue");
        }
      } else if (!platformResultsReturned) {
        const sendEvidence =
          deliveredResults.length > 0 ||
          (!isProvenDeliveryNotSentError(err) &&
            (platformDispatchedPayloads.size > 0 ||
              (err instanceof OutboundDeliveryError && err.sentBeforeError)));
        if (sendEvidence) {
          try {
            queuedPostSendState ??= await persistOwnedPostSendState();
            if (queuedPostSendState === "marked" || queuedPostSendState === "unmarked") {
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
                  payloadOutcomes.some((outcome) => outcome.status === "sent"));
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
              emitFailedTerminals("platform_send");
            }
          }
          if (!terminalRejectionHandled) {
            // A caller that resends this failure itself must not leave a row
            // behind: the recovery drain would send the same message again
            // behind that retry (#124279). Callers that only report the error
            // (CLI, gateway RPC) and durable completions keep their own owner,
            // so their rows stay replayable (#100979).
            const callerOwnsRetry =
              isProvenDeliveryNotSentError(err) &&
              params.deliveryRetryOwner === "caller" &&
              !params.deliveryCompletion;
            if (callerOwnsRetry) {
              try {
                throwIfProducerLeaseLost();
                // Claim-fenced removal: the row is gone, so nothing replays it.
                // That also retires recovery's chance to report this delivery,
                // so the terminal audit fact is owed right here.
                const spooled = await moveToFailed(
                  queueId,
                  platformQueueStateDir,
                  producerClaimId ?? null,
                );
                await releaseSpoolArtifacts(spooled, platformQueueStateDir);
                emitFailedTerminals(platformSendFailureStage);
              } catch (failErr: unknown) {
                // Claim loss or a failed removal leaves the row with its owner;
                // no terminal is emitted because recovery still owns the entry.
                log.warn(
                  `failed to dead-letter queued delivery ${queueId} after proven-not-sent failure: ${formatErrorMessage(failErr)}`,
                );
              }
            } else {
              // One retry owner per row: the proven-not-sent row stays replay
              // eligible, so the thrown error is marked to tell RPC callers the
              // queue resends and the model must not.
              const recoveryOwnsRetry = isProvenDeliveryNotSentError(err);
              const recordFailure = recoveryOwnsRetry
                ? failDeliveryBeforePlatformSend
                : failDelivery;
              try {
                await recordOwnedQueueFailure(recordFailure, formatErrorMessage(err));
                if (recoveryOwnsRetry && err instanceof OutboundDeliveryError) {
                  err.recoveryOwnedRetry = true;
                }
              } catch (failErr) {
                log.warn(
                  `failed to mark queued delivery ${queueId} as failed: ${formatErrorMessage(failErr)}`,
                );
              }
            }
          }
        }
      }
    } else {
      flushMessageSentEvents();
      emitFailedTerminals(platformSendFailureStage);
    }
    if (deliveredResults.length === 0 && payloadOutcomes.length === 0) {
      throw err;
    }
    throw toOutboundDeliveryError({
      error: err,
      results: deliveredResults,
      payloadOutcomes,
      stage: "queue",
    });
  }
}

/** Core delivery logic (extracted for queue wrapper). */
