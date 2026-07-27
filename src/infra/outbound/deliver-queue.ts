import { hasTrustedMessageAuditListeners } from "../../audit/message-audit-events.js";
// Owns durable queue admission, custody, cleanup, and delivery completion.
import type { ReplyPayload } from "../../auto-reply/types.js";
import { createRenderedMessageBatchPlan } from "../../channels/message/rendered-batch.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveOutboundMediaMaxBytes } from "../../media/configured-max-bytes.js";
import {
  findPlatformMessageRejectedError,
  isProvenDeliveryNotSentError,
} from "../delivery-recovery.shared.js";
import { formatErrorMessage } from "../errors.js";
import { resolveDeferredDeliveryAdmission } from "./deferred-delivery-admission.js";
import { resolveChannelOutboundDirectiveOptions } from "./deliver-channel.js";
import type { DeliverOutboundPayloadsParams, PlatformSendRoute } from "./deliver-contracts.js";
import { deliverOutboundPayloadsCore } from "./deliver-core.js";
import {
  collectPayloadMediaSources,
  resolveOutboundMediaAccessForSend,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
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
import { releaseSpoolArtifacts, stageQueuePayloadMedia } from "./delivery-queue-media-spool.js";
import { cancelDeliveryQueueMediaStage } from "./delivery-queue-media-staging.js";
import {
  ackDelivery,
  enqueueDelivery,
  enqueueDeliveryOnce,
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
import {
  createOutboundPayloadPlan,
  type NormalizedOutboundPayload,
  type OutboundPayloadPlan,
} from "./payloads.js";

const log = createSubsystemLogger("outbound/deliver");

function materializeQueueCustodyMedia(
  payloads: readonly ReplyPayload[],
  plan: readonly OutboundPayloadPlan[],
): ReplyPayload[] {
  const effectiveBySource = new Map(
    plan.map((entry) => [entry.sourceIndex, entry.parts.mediaUrls] as const),
  );
  return payloads.map((payload, index) => {
    const effective = effectiveBySource.get(index);
    if (!effective?.length) {
      return payload;
    }
    const structured = new Set(
      [payload.mediaUrl, ...(payload.mediaUrls ?? [])]
        .map((url) => url?.trim())
        .filter((url): url is string => Boolean(url)),
    );
    if (effective.every((url) => structured.has(url))) {
      return payload;
    }
    // Keep raw pre-hook text for deterministic replay. The singular anchor
    // prevents recovery from re-adding its original MEDIA: path.
    return { ...payload, mediaUrl: effective[0], mediaUrls: [...effective] };
  });
}

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
  const strippedQueuePayloads = payloads.map(stripInternalRuntimeScaffoldingFromPayload);
  const renderedBatchPlan =
    params.renderedBatchPlan ?? createRenderedMessageBatchPlan(params.payloads);

  const stageAndEnqueueDelivery = async (): Promise<{ id: string; created: boolean } | null> => {
    // Legacy `MEDIA:` text directives carry local media that only materializes
    // into structured fields at send time, so the spool (which reads structured
    // media) would skip it and a retry would read the vanished producer path.
    // Project each source payload's effective media through the same canonical
    // plan the live send uses and fold directive-derived sources into the queue
    // copy's structured media before staging. The raw payload and its pre-hook
    // text are untouched, so the live send below stays copy-free on the original.
    const directiveOptions = await resolveChannelOutboundDirectiveOptions({
      cfg: params.cfg,
      channel,
    });
    const queueCustodyPayloads = materializeQueueCustodyMedia(
      strippedQueuePayloads,
      createOutboundPayloadPlan(strippedQueuePayloads, {
        cfg: params.cfg,
        sessionKey: params.session?.policyKey ?? params.session?.key,
        surface: channel,
        conversationType: params.session?.conversationType,
        extractMarkdownImages: directiveOptions.extractMarkdownImages,
      }),
    );
    const queuePayloadsChanged = queueCustodyPayloads.some(
      (payload, index) => payload !== payloads[index],
    );
    // Media staging only rewrites source URLs one-for-one, so the plan stays keyed
    // to the custody payload counts rather than to which copy the row references;
    // recovery replays entry.payloads and this plan together. Materialized custody
    // anchors mediaUrl to the effective set (to override the in-text directive on
    // replay), so count fan-out from mediaUrls alone for payloads we rewrote to
    // keep the plan aligned with the deduped effective media recovery re-derives.
    const renderPlanPayloads = queueCustodyPayloads.map((payload, index) =>
      payload === strippedQueuePayloads[index] ? payload : { ...payload, mediaUrl: undefined },
    );
    const queueRenderedBatchPlan = queuePayloadsChanged
      ? createRenderedMessageBatchPlan(renderPlanPayloads)
      : renderedBatchPlan;
    // A durable row must not outlive its media. Producer-owned local sources
    // (TTS temps above all) are deleted when this process exits, so the queue
    // takes its own copy first and the row references that; the live send below
    // keeps the original path and stays copy-free.
    const staged = await stageQueuePayloadMedia({
      payloads: queueCustodyPayloads,
      // Resolved exactly as the live send resolves it: staging must neither
      // reject media the send would deliver (agent workspace sources are only
      // reachable through the agent-scoped roots) nor read more than the send may.
      mediaAccess: resolveOutboundMediaAccessForSend(
        params,
        channel,
        collectPayloadMediaSources(queueCustodyPayloads),
      ),
      maxBytes: resolveOutboundMediaMaxBytes({
        cfg: params.cfg,
        channel,
        accountId: params.accountId,
      }),
    });
    if (staged.status !== "staged") {
      // Sensitive media must reach neither the spool nor the row, so there is no
      // replayable copy to promise. Required sends fail closed instead of
      // persisting an unreplayable row; best-effort degrades to a live-only send.
      if (queuePolicy === "required") {
        throw new Error(
          `Required durable message send is unsupported for ${channel}: ${staged.reason} cannot be persisted`,
        );
      }
      return null;
    }
    try {
      const delivery = {
        channel,
        to,
        accountId: params.accountId,
        queuePolicy,
        requireUnknownSendReconciliation: params.requireUnknownSendReconciliation,
        payloads: staged.payloads,
        renderedBatchPlan: queueRenderedBatchPlan,
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
        preparedMessageId: params.preparedMessageId,
        deliveryCompletion: params.deliveryCompletion,
      };
      if (params.deliveryIntentId) {
        const queued = await enqueueDeliveryOnce(
          delivery,
          params.deliveryIntentId,
          undefined,
          staged.mediaStageId,
        );
        if (!queued.created) {
          cancelDeliveryQueueMediaStage(staged.mediaStageId);
          await releaseSpoolArtifacts(staged.artifacts);
        }
        return queued;
      }
      const id = staged.mediaStageId
        ? await enqueueDelivery(delivery, undefined, staged.mediaStageId)
        : await enqueueDelivery(delivery);
      return { id, created: true };
    } catch (err) {
      cancelDeliveryQueueMediaStage(staged.mediaStageId);
      await releaseSpoolArtifacts(staged.artifacts);
      throw err;
    }
  };

  // Invocation authority is not queued; recovery must re-enter delegated after restart.
  // Write-ahead delivery queue: persist before sending, remove after success.
  const queued = params.skipQueue
    ? null
    : await stageAndEnqueueDelivery().catch((err: unknown) => {
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

  // A prior producer already owns this stable intent. Recovery or the original
  // live sender will finish it; a replay must not cross platform I/O again.
  if (queued && !queued.created) {
    throw new Error(`Stable delivery intent is already queued: ${queued.id}`);
  }

  if (!queueId) {
    return await deliverOutboundPayloadsWithQueueCleanup(params, null, auditStartedAt);
  }

  // Hold the same in-process claim used by recovery/drain while the live send
  // owns this queue entry.
  const claimResult = await withActiveDeliveryClaim(queueId, () =>
    deliverOutboundPayloadsWithQueueCleanup(params, queueId, auditStartedAt),
  );
  if (claimResult.status === "claimed-by-other-owner") {
    return [];
  }
  return claimResult.value;
}

async function deliverOutboundPayloadsWithQueueCleanup(
  params: DeliverOutboundPayloadsParams,
  queueId: string | null,
  auditStartedAt: number,
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
          await markDeliveryPlatformSendDispatched(
            platformQueueId,
            platformQueueStateDir,
            platformSendRoute,
          );
          queuedPreSendState ??= "marked";
        } catch (dispatchMarkError) {
          if (exactReconciliationRequired) {
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
    ...(auditPayloadOutcomes
      ? {
          onPayloadDeliveryOutcome: (outcome: OutboundPayloadDeliveryOutcome) => {
            auditPayloadOutcomes.push(outcome);
            params.onPayloadDeliveryOutcome?.(outcome);
          },
        }
      : {}),
    onDeliveryResult: async (result) => {
      deliveredResults.push(result);
      if (queueId && queuedPostSendState === undefined) {
        queuedPostSendState = await persistQueuedPostSendState({ queueId, queuePolicy });
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
          (partialSendEvidence
            ? await persistQueuedPostSendState({ queueId, queuePolicy })
            : undefined);
        const error = "partial delivery failure (bestEffort)";
        if (postSendState === undefined || postSendState === "marked") {
          const recordFailure =
            !partialSendEvidence && partialFailuresAreProvenNotSent
              ? failDeliveryBeforePlatformSend
              : failDelivery;
          await recordFailure(queueId, error).catch((err: unknown) => {
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
            ? await persistQueuedPostSendState({ queueId, queuePolicy })
            : queuedPreSendState === "acked"
              ? "acked"
              : undefined);
        const acked =
          postSendState === "acked"
            ? true
            : postSendState === "failed"
              ? false
              : await ackDelivery(queueId)
                  .then(() => true)
                  .catch(async (err: unknown) => {
                    const hasSendEvidence =
                      deliveredResults.length > 0 || queuedPreSendState !== undefined;
                    try {
                      if (hasSendEvidence) {
                        await failDeliveryAfterPlatformSend(
                          queueId,
                          `failed to ack sent delivery: ${formatErrorMessage(err)}`,
                        );
                        queuedPostSendState = "failed";
                      } else {
                        await failDelivery(
                          queueId,
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
        const acked = await ackDelivery(queueId)
          .then(() => true)
          .catch(() => false);
        if (acked) {
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
            queuedPostSendState ??= await persistQueuedPostSendState({
              queueId,
              queuePolicy,
            });
            if (queuedPostSendState === "marked") {
              await failDeliveryAfterPlatformSend(queueId, formatErrorMessage(err));
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
              if (params.deliveryCompletion) {
                rejectDurableDelivery(params.deliveryCompletion, permanentRejection.message);
                ownerRejected = true;
              }
              await ackDelivery(queueId);
              queueAcked = true;
            } catch (rejectionError) {
              log.warn(
                `failed to finalize permanently rejected delivery ${queueId}: ${formatErrorMessage(rejectionError)}`,
              );
            }
            terminalRejectionHandled = ownerRejected || queueAcked;
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
            await recordFailure(queueId, formatErrorMessage(err)).catch((failErr: unknown) => {
              log.warn(
                `failed to mark queued delivery ${queueId} as failed: ${formatErrorMessage(failErr)}`,
              );
            });
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
