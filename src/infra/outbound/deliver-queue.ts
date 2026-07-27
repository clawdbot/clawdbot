import { hasTrustedMessageAuditListeners } from "../../audit/message-audit-events.js";
// Owns durable queue admission, custody, cleanup, and delivery completion.
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { resolveDeferredDeliveryAdmission } from "./deferred-delivery-admission.js";
import type { DeliverOutboundPayloadsParams, PlatformSendRoute } from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import {
  restoreQueuedDeliveryCustody,
  stageAndEnqueueOutboundDelivery,
} from "./deliver-queue-admission.js";
import {
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
import {
  completeDurableDelivery,
  rejectDurableDelivery,
  suppressDurableDelivery,
} from "./delivery-completion.js";
import { loadPendingDelivery } from "./delivery-queue-storage.js";
import {
  ackDelivery,
  claimDeliveryPlatformSendAttempt,
  failDelivery,
  failDeliveryAfterPlatformSend,
  failDeliveryBeforePlatformSend,
  markDeliveryPlatformSendDispatched,
  withActiveDeliveryClaim,
} from "./delivery-queue.js";
import {
  completedOutboundAuditTerminals,
  emitOutboundAuditTerminals,
  failedOutboundAuditTerminals,
  uniformOutboundAuditTerminals,
} from "./outbound-audit.js";
import type { NormalizedOutboundPayload } from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");

export async function runOutboundDelivery(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  return await runOutboundDeliveryInternal(params);
}

export async function runOutboundDeliveryInternal(
  params: DeliverOutboundPayloadsParams,
): Promise<OutboundDeliveryResult[]> {
  const auditStartedAt = Date.now();
  const { channel, to, payloads } = params;
  const emitPreQueueFailure = (): void => {
    // Recovery owns the stable queue terminal for replayed intents.
    if (params.deliveryQueueId !== undefined) {
      return;
    }
    emitOutboundAuditTerminals({
      context: params,
      terminals: () =>
        uniformOutboundAuditTerminals(params.payloads.length, {
          outcome: "failed",
          failureStage: "queue",
        }),
      startedAt: auditStartedAt,
    });
  };
  if (params.requireUnknownSendReconciliation === true && payloads.length !== 1) {
    emitPreQueueFailure();
    throw new Error(
      `Required durable message send is unsupported for ${channel}: unknown-send reconciliation requires exactly one payload`,
    );
  }
  if (params.deferredDeliveryAdmissionPassed !== true) {
    const admission = resolveDeferredDeliveryAdmission({
      cfg: params.cfg,
      channel,
      to,
      accountId: params.accountId,
      phase: "live",
    });
    if (admission.status === "permanent_rejection") {
      emitPreQueueFailure();
      throw new Error(admission.reason);
    }
  }
  const queuePolicy = params.queuePolicy ?? "best_effort";

  // Invocation authority is not queued; recovery must re-enter delegated after restart.
  // Write-ahead delivery queue: persist before sending, remove after success.
  const queued = params.skipQueue
    ? null
    : await stageAndEnqueueOutboundDelivery(params).catch((err: unknown) => {
        if (queuePolicy === "required") {
          emitPreQueueFailure();
          throw err;
        }
        return null;
      }); // Best-effort delivery falls back to direct send if staging or the queue write fails.

  const queueId = queued?.id ?? null;
  if (queueId) {
    params.onDeliveryIntent?.({
      id: queueId,
      channel,
      to,
      ...(params.accountId ? { accountId: params.accountId } : {}),
      queuePolicy,
    });
  }

  if (!queueId) {
    return await deliverOutboundPayloadsWithQueueCleanup(
      params,
      null,
      auditStartedAt,
      params.deliveryProducerClaimId,
    );
  }

  if (!queued?.created && !params.reusePendingDeliveryIntent) {
    throw new Error(`Stable delivery intent is already queued: ${queueId}`);
  }
  const claimResult = await withActiveDeliveryClaim(queueId, async () => {
    const producerClaimId = params.reusePendingDeliveryIntent
      ? await claimDeliveryPlatformSendAttempt(queueId)
      : undefined;
    if (params.reusePendingDeliveryIntent && !producerClaimId) {
      throw new Error(`Stable delivery intent is already queued: ${queueId}`);
    }
    let deliveryParams = params;
    if (queued?.created !== true) {
      const queuedEntry = await loadPendingDelivery(queueId);
      if (!queuedEntry || queuedEntry.producerClaimId !== producerClaimId) {
        throw new Error(`Stable delivery platform claim was lost: ${queueId}`);
      }
      deliveryParams = restoreQueuedDeliveryCustody(params, queuedEntry);
    }
    return deliverOutboundPayloadsWithQueueCleanup(
      deliveryParams,
      queueId,
      auditStartedAt,
      producerClaimId,
    );
  });
  if (claimResult.status === "claimed") {
    return claimResult.value;
  }
  if (params.reusePendingDeliveryIntent) {
    throw new Error(`Stable delivery intent is already queued: ${queueId}`);
  }
  return [];
}

async function deliverOutboundPayloadsWithQueueCleanup(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
  auditStartedAt: number,
  producerClaimId?: string,
): Promise<OutboundDeliveryResult[]> {
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
  // Recipient custody must observe ambiguous adapter outcomes even when no
  // audit listener is installed; audit subscriptions are not delivery proof.
  const stablePayloadOutcomes = producerClaimId
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
  let platformSendRoute: PlatformSendRoute | undefined;
  let deliveredResults: OutboundDeliveryResult[] = [];
  let commitHooksRun = false;
  const ackOwnedQueue = (options?: { suppressCompletionReceipt?: boolean }) => {
    if (!queueId) {
      throw new Error("Queued delivery acknowledgement requires a queue id");
    }
    return producerClaimId
      ? ackDelivery(queueId, undefined, {
          ...options,
          expectedPlatformSendAttemptId: producerClaimId,
        })
      : options
        ? ackDelivery(queueId, undefined, options)
        : ackDelivery(queueId);
  };
  const recordOwnedQueueFailure = (
    record: typeof failDelivery | typeof failDeliveryAfterPlatformSend,
    error: string,
  ) => {
    if (!queueId) {
      throw new Error("Queued delivery failure requires a queue id");
    }
    return producerClaimId
      ? record(queueId, error, undefined, producerClaimId)
      : record(queueId, error);
  };
  const persistOwnedPostSendState = () => {
    if (!queueId) {
      throw new Error("Queued delivery post-send state requires a queue id");
    }
    return persistQueuedPostSendState({
      queueId,
      queuePolicy,
      ...(producerClaimId ? { producerClaimId } : {}),
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
    if (
      queuedPostSendState !== "acked" ||
      params.deferCommitHooks ||
      commitHooksRun ||
      deliveredResults.length === 0
    ) {
      return;
    }
    commitHooksRun = true;
    await runOutboundDeliveryCommitHooks(deliveredResults);
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
      await params.onPlatformSendStart?.(route);
    },
    onPlatformSendDispatch: async () => {
      if (platformQueueId && queuedPreSendState !== "acked") {
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
          if (exactReconciliationRequired || producerClaimId) {
            throw dispatchMarkError;
          }
          log.warn(
            `failed to refresh queued delivery ${platformQueueId} at platform dispatch; continuing best-effort send: ${formatErrorMessage(dispatchMarkError)}`,
          );
        }
      }
      await params.onPlatformSendDispatch?.();
    },
    onError: (err: unknown, payload: NormalizedOutboundPayload) => {
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
  };
  let platformResultsReturned = false;

  try {
    const results = await deliverOutboundPayloadsCore(wrappedParams);
    // Core reconciles adapter progress objects with hook-bearing final results.
    deliveredResults = results;
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
      if (params.deliveryCompletion) {
        if (results.length > 0) {
          completeDurableDelivery(params.deliveryCompletion, results.at(-1)!);
        } else {
          suppressDurableDelivery(params.deliveryCompletion);
        }
      }
      if (!params.deferCommitHooks) {
        await runOutboundDeliveryCommitHooks(results);
      }
      emitTerminals(() =>
        hadPartialFailure
          ? failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "platform_send",
            })
          : completedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
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
          const recordFailure =
            !partialSendEvidence && partialFailuresAreProvenNotSent
              ? failDeliveryBeforePlatformSend
              : failDelivery;
          await recordOwnedQueueFailure(recordFailure, error).catch((err: unknown) => {
            log.warn(
              `failed to mark queued delivery ${queueId} as failed after partial failure; continuing best-effort delivery: ${formatErrorMessage(err)}`,
            );
          });
        } else if (postSendState === "acked") {
          // Direct ack is the fallback when the post-send marker cannot be
          // written. Once the row is gone, recovery cannot run these hooks.
          await runCommitHooksAfterAck();
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: "platform_send",
            }),
          );
        }
      } else {
        if (params.deliveryCompletion) {
          if (results.length > 0) {
            completeDurableDelivery(params.deliveryCompletion, results.at(-1)!);
          } else {
            suppressDurableDelivery(params.deliveryCompletion);
          }
        }
        const postSendState =
          queuedPostSendState ??
          (results.length > 0 || queuedPreSendState === "marked"
            ? await persistOwnedPostSendState()
            : queuedPreSendState === "acked"
              ? "acked"
              : undefined);
        if (results.length === 0 && postSendState === "marked") {
          // The provider was invoked but returned no recipient-visible identity;
          // never convert that ambiguous platform outcome into a success receipt.
          await recordOwnedQueueFailure(
            failDeliveryAfterPlatformSend,
            "platform send returned no delivery identity",
          );
          queuedPostSendState = "failed";
          emitTerminals(() =>
            uniformOutboundAuditTerminals(params.payloads.length, {
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
              payloadCount: params.payloads.length,
              results,
              payloadOutcomes: auditPayloadOutcomes ?? [],
            }),
          );
        }
      }
    }
    return results;
  } catch (err) {
    if (err instanceof OutboundDeliveryError && err.results.length > 0) {
      deliveredResults = err.results;
    }
    if (queueId) {
      if (isDeliveryAbortError(err)) {
        const ambiguousStableAbort =
          producerClaimId !== undefined &&
          (deliveredResults.length > 0 ||
            queuedPreSendState === "marked" ||
            queuedPostSendState === "marked" ||
            stablePayloadOutcomes?.some((outcome) => outcome.status === "sent"));
        if (ambiguousStableAbort) {
          if (queuedPostSendState !== "failed") {
            await recordOwnedQueueFailure(
              failDeliveryAfterPlatformSend,
              `delivery aborted after platform send: ${formatErrorMessage(err)}`,
            );
            queuedPostSendState = "failed";
          }
          emitTerminals(() =>
            uniformOutboundAuditTerminals(params.payloads.length, {
              outcome: "unknown",
              failureStage: "platform_send",
            }),
          );
        } else if (
          await (
            producerClaimId ? ackOwnedQueue({ suppressCompletionReceipt: true }) : ackOwnedQueue()
          )
            .then(() => true)
            .catch(() => false)
        ) {
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
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
                payloadCount: params.payloads.length,
                results: deliveredResults,
                payloadOutcomes: auditPayloadOutcomes ?? [],
                failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
              }),
            );
          }
        } else if (queuedPreSendState === "acked") {
          // The best-effort marker fallback removed the durable row before
          // provider I/O, so this owner must emit the stable queue terminal.
          emitTerminals(() =>
            failedOutboundAuditTerminals({
              payloadCount: params.payloads.length,
              results: deliveredResults,
              payloadOutcomes: auditPayloadOutcomes ?? [],
              failureStage: err instanceof OutboundDeliveryError ? err.stage : "platform_send",
            }),
          );
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
                  rejectDurableDelivery(params.deliveryCompletion, permanentRejection.message);
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
              emitTerminals(() =>
                failedOutboundAuditTerminals({
                  payloadCount: params.payloads.length,
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
      emitTerminals(() =>
        failedOutboundAuditTerminals({
          payloadCount: params.payloads.length,
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
