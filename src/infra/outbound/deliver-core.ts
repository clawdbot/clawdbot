// Executes normalized outbound payloads against the selected channel transport.
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { payloadRequiresDurablePayloadTransport } from "../../channels/message/capabilities.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import { diagnosticErrorCategory } from "../diagnostic-error-metadata.js";
import {
  emitInternalDiagnosticEvent as emitDiagnosticEvent,
  type DiagnosticMessageDeliveryKind,
} from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { createChannelHandler } from "./deliver-channel.js";
import type { ChannelHandler, DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import { suppressedPayloadOutcome, toOutboundDeliveryError } from "./deliver-hooks.js";
import {
  buildPayloadSummary,
  deliveryKindForPayload,
  maybeNotifyAfterDeliveredPayload,
  maybePinDeliveredMessage,
  normalizeEmptyPayloadForDelivery,
  renderPresentationForDelivery,
  resolveOutboundMediaAccessForSend,
  stripInternalRuntimeScaffoldingFromPayload,
} from "./deliver-payload.js";
import { createDeliveryResultRecorder } from "./deliver-results.js";
import { mirrorDeliveredPayloads } from "./deliver-transcript.js";
import type {
  OutboundDeliveryResult,
  OutboundPayloadDeliveryKind,
  OutboundPayloadDeliveryOutcome,
} from "./deliver-types.js";
import {
  assertStableMediaFanout,
  planOutboundMediaMessageUnits,
  planOutboundTextMessageUnits,
  type OutboundMessageSendOverrides,
} from "./message-plan.js";
import type { NormalizedOutboundPayload } from "./payloads.js";
import {
  acceptedPreparedOutboundEntries,
  preparedOutboundSuppressionOutcomes,
} from "./prepared-batch.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

const log = createSubsystemLogger("outbound/deliver");

export async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to } = params;
  const preparedBatch = params.preparedBatch;
  if (!preparedBatch) {
    throw new Error("Outbound delivery requires a prepared payload batch");
  }
  const accountId = params.accountId;
  const reply = params.reply;
  const deps = params.deps;
  const abortSignal = params.abortSignal;
  const results: OutboundDeliveryResult[] = [];
  const {
    recordIdentifiedDeliveryResult,
    recordIdentifiedDeliveryResults,
    reportIdentifiedDeliveryResult,
    resetReportedResults,
  } = createDeliveryResultRecorder({
    results,
    onDeliveryResult: params.onDeliveryResult,
  });
  let activeSourceIndex: number | undefined;
  const resolveMediaAccess = (mediaSources: readonly string[]): OutboundMediaAccess =>
    resolveOutboundMediaAccessForSend(params, channel, mediaSources);
  const createHandler = (mediaSources: readonly string[]) =>
    createChannelHandler({
      cfg,
      agentId: params.session?.agentId,
      channel,
      to,
      deps,
      accountId,
      replyToId: reply?.replyToId,
      replyToMode: reply?.source === "implicit" ? reply.mode : undefined,
      formatting: params.formatting,
      threadId: params.threadId,
      identity: params.identity,
      gifPlayback: params.gifPlayback,
      forceDocument: params.forceDocument,
      silent: params.silent,
      mediaAccess: resolveMediaAccess(mediaSources),
      gatewayClientScopes: params.gatewayClientScopes,
      conversationReadOrigin: params.conversationReadOrigin,
      deliveryQueueId: params.deliveryQueueId,
      preparedMessageId: params.preparedMessageId,
      requiredUnknownSendReconciliation: params.requiredUnknownSendReconciliation,
      onPlatformSendStart: async (route) => {
        // Channel handlers can fan one logical payload into multiple sends.
        // Carry its source index without polluting the persisted platform route.
        await params.onPlatformSendStart?.(route, activeSourceIndex);
      },
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      onDeliveryResult: reportIdentifiedDeliveryResult,
    });
  const baseHandler = await createHandler([]);
  let preparedTarget = baseHandler.buildTargetRef({ threadId: params.threadId });
  const maybeAdoptTargetFromDelivery = (result: OutboundDeliveryResult): void => {
    if (params.threadId != null || preparedTarget.threadId != null) {
      return;
    }
    const adoptedTarget = baseHandler.adoptTargetFromDelivery?.({ target: preparedTarget, result });
    if (adoptedTarget?.threadId != null) {
      // The adapter owns receipt semantics; core only carries its typed target forward.
      preparedTarget = { ...preparedTarget, threadId: adoptedTarget.threadId };
    }
  };
  const withPreparedTarget = <T extends OutboundMessageSendOverrides>(overrides: T): T =>
    preparedTarget.threadId == null
      ? overrides
      : { ...overrides, threadId: preparedTarget.threadId };
  const adoptSuccessfulResultsSince = (resultIndex: number): void => {
    for (const result of results.slice(resultIndex)) {
      maybeAdoptTargetFromDelivery(result);
    }
  };
  const handlerByMediaSources = new Map<string, Promise<ChannelHandler>>();
  const getDeliveryHandler = (mediaSources: readonly string[]): Promise<ChannelHandler> => {
    if (mediaSources.length === 0) {
      return Promise.resolve(baseHandler);
    }
    const key = JSON.stringify(mediaSources);
    return getOrCreatePromise(handlerByMediaSources, key, () => createHandler(mediaSources));
  };
  const handler = baseHandler;
  const configuredTextLimit = handler.chunker
    ? resolveTextChunkLimit(cfg, channel, accountId, {
        fallbackLimit: handler.textChunkLimit,
      })
    : undefined;
  const textLimit =
    params.formatting?.textLimit ??
    (handler.resolveEffectiveTextChunkLimit
      ? handler.resolveEffectiveTextChunkLimit(configuredTextLimit)
      : configuredTextLimit);
  const chunkMode = handler.chunker
    ? (params.formatting?.chunkMode ?? resolveChunkMode(cfg, channel, accountId))
    : "length";
  const { resolveCurrentReplyTo, applyReplyToConsumption } = createReplyToDeliveryPolicy({
    reply,
  });

  const sendTextChunks = async (
    sendHandler: ChannelHandler,
    text: string,
    overrides: OutboundMessageSendOverrides = {},
  ) => {
    const units = planOutboundTextMessageUnits({
      text,
      overrides,
      chunker: sendHandler.chunker,
      chunkerMode: sendHandler.chunkerMode,
      chunkedTextFormatting: sendHandler.chunkedTextFormatting,
      textLimit,
      chunkMode,
      formatting: params.formatting,
      consumeReplyTo: (value) =>
        applyReplyToConsumption(value, {
          consumeImplicitReply: value.replyToIdSource === "implicit",
        }),
    });
    for (const unit of units) {
      if (unit.kind !== "text") {
        continue;
      }
      throwIfAborted(abortSignal);
      const resultIndex = results.length;
      await recordIdentifiedDeliveryResult(
        await sendHandler.sendText(unit.text, withPreparedTarget(unit.overrides)),
      );
      adoptSuccessfulResultsSince(resultIndex);
    }
  };
  const acceptedEntries = acceptedPreparedOutboundEntries(preparedBatch);
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [
    ...preparedOutboundSuppressionOutcomes(preparedBatch),
  ];
  const effectiveDeliveryKinds = new Map<number, OutboundPayloadDeliveryKind>();
  const recordPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
    const deliveryKind = effectiveDeliveryKinds.get(outcome.index);
    const recordedOutcome =
      deliveryKind && outcome.status !== "suppressed" ? { ...outcome, deliveryKind } : outcome;
    payloadOutcomes.push(recordedOutcome);
    params.onPayloadDeliveryOutcome?.(recordedOutcome);
  };
  for (const outcome of payloadOutcomes) {
    params.onPayloadDeliveryOutcome?.(outcome);
  }
  const deliveredMirrorPayloads: NormalizedOutboundPayload[] = [];
  const recordDeliveredPayload = (
    payloadSummary: NormalizedOutboundPayload,
    deliveredResults: readonly OutboundDeliveryResult[],
  ): void => {
    if (deliveredResults.length === 0) {
      return;
    }
    // Post-send observers are bookkeeping only. Never turn an identified
    // platform delivery into a retryable failure if an observer misbehaves.
    try {
      params.onDeliveredPayload?.(payloadSummary);
    } catch (error) {
      log.warn("Outbound delivered-payload observer failed after platform send.", {
        channel,
        to,
        error: formatErrorMessage(error),
      });
    }
    if (params.mirror) {
      deliveredMirrorPayloads.push(payloadSummary);
    }
  };
  // `policyKey` is a diagnostics-only fallback; never use it for hook correlation.
  const diagnosticSessionKey =
    params.mirror?.sessionKey ?? params.session?.key ?? params.session?.policyKey;
  for (const [deliveryPayloadIndex, preparedEntry] of acceptedEntries.entries()) {
    const payloadIndex = preparedEntry.sourceIndex;
    activeSourceIndex = payloadIndex;
    const payload = preparedEntry.payload;
    const payloadResultStartIndex = results.length;
    let effectivePayload: typeof payload | null | undefined;
    let payloadSummary = buildPayloadSummary(payload);
    const originalMediaCount = preparedEntry.preparedMediaCount;
    let deliveryKind: DiagnosticMessageDeliveryKind = "other";
    let deliveryStartedAt = 0;
    let deliveryStarted = false;
    let deliveryFinished = false;
    let messageSentEventRecorded = false;
    const recordMessageSentEvent = (
      event: Parameters<NonNullable<typeof params.onMessageSentEvent>>[0],
    ): void => {
      if (messageSentEventRecorded) {
        return;
      }
      messageSentEventRecorded = true;
      params.onMessageSentEvent?.(event, payloadIndex);
    };
    const startDeliveryDiagnostics = (kind: DiagnosticMessageDeliveryKind) => {
      deliveryKind = kind;
      deliveryStartedAt = Date.now();
      deliveryStarted = true;
      deliveryFinished = false;
      emitDiagnosticEvent({
        type: "message.delivery.started",
        channel,
        deliveryKind,
        ...(diagnosticSessionKey ? { sessionKey: diagnosticSessionKey } : {}),
      });
    };
    const completeDeliveryDiagnostics = (resultCount: number) => {
      if (!deliveryStarted) {
        return;
      }
      deliveryFinished = true;
      emitDiagnosticEvent({
        type: "message.delivery.completed",
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        resultCount,
        ...(diagnosticSessionKey ? { sessionKey: diagnosticSessionKey } : {}),
      });
    };
    const errorDeliveryDiagnostics = (err: unknown) => {
      if (!deliveryStarted || deliveryFinished) {
        return;
      }
      deliveryFinished = true;
      emitDiagnosticEvent({
        type: "message.delivery.error",
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        errorCategory: diagnosticErrorCategory(err),
        ...(diagnosticSessionKey ? { sessionKey: diagnosticSessionKey } : {}),
      });
    };
    try {
      throwIfAborted(abortSignal);

      const deliveryPayload = payload;
      const presentationHandler = await getDeliveryHandler(
        buildPayloadSummary(deliveryPayload).mediaUrls,
      );
      const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(
        await renderPresentationForDelivery(presentationHandler, deliveryPayload),
      );
      const renderedHandler = await getDeliveryHandler(
        buildPayloadSummary(renderedPayload).mediaUrls,
      );
      // Preparation already normalized the post-policy payload. Normalize again
      // only when presentation rendering creates a new transport representation.
      const normalizedEffectivePayload =
        (preparedBatch.channelNormalized !== true || renderedPayload !== deliveryPayload) &&
        renderedHandler.normalizePayload
          ? renderedHandler.normalizePayload(renderedPayload)
          : renderedPayload;
      effectivePayload = normalizedEffectivePayload
        ? normalizeEmptyPayloadForDelivery(
            stripInternalRuntimeScaffoldingFromPayload(normalizedEffectivePayload),
          )
        : null;
      if (!effectivePayload) {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: preparedEntry.messageHookChanged
              ? "empty_after_message_sending_hook"
              : preparedEntry.replyHookChanged
                ? "empty_after_reply_payload_sending_hook"
                : "no_visible_payload",
          }),
        );
        continue;
      }
      const effectivePayloadSummary = buildPayloadSummary(effectivePayload);
      assertStableMediaFanout(
        params,
        deliveryPayloadIndex,
        originalMediaCount,
        effectivePayloadSummary,
      );
      payloadSummary = effectivePayloadSummary;
      const deliveryHandler = await getDeliveryHandler(payloadSummary.mediaUrls);
      const effectiveDeliveryKind = deliveryKindForPayload(effectivePayload, payloadSummary);
      effectiveDeliveryKinds.set(payloadIndex, effectiveDeliveryKind);
      startDeliveryDiagnostics(effectiveDeliveryKind);

      params.onPayload?.(payloadSummary);
      const replyToResolution = resolveCurrentReplyTo(effectivePayload);
      const sendOverrides: OutboundMessageSendOverrides = {
        replyToId: replyToResolution.replyToId,
        replyToIdSource: replyToResolution.source,
        ...(preparedTarget.threadId != null ? { threadId: preparedTarget.threadId } : {}),
        ...(effectivePayload.audioAsVoice === true ? { audioAsVoice: true } : {}),
        ...(params.forceDocument !== undefined ? { forceDocument: params.forceDocument } : {}),
      };
      const applySendReplyToConsumption = <T extends OutboundMessageSendOverrides>(
        overrides: T,
      ): T =>
        applyReplyToConsumption(overrides, {
          consumeImplicitReply: replyToResolution.source === "implicit",
        });
      const deliveryTarget = () =>
        deliveryHandler.buildTargetRef({ threadId: preparedTarget.threadId });
      if (
        deliveryHandler.sendPayload &&
        payloadRequiresDurablePayloadTransport(effectivePayload, {
          sendTextOnlyErrorPayloads: deliveryHandler.sendTextOnlyErrorPayloads,
        })
      ) {
        const beforeCount = results.length;
        const delivery = await deliveryHandler.sendPayload(
          effectivePayload,
          withPreparedTarget(applySendReplyToConsumption(sendOverrides)),
        );
        await recordIdentifiedDeliveryResult(delivery);
        adoptSuccessfulResultsSince(beforeCount);
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length === 0) {
          completeDeliveryDiagnostics(0);
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
          continue;
        }
        recordPayloadOutcome({
          index: payloadIndex,
          status: "sent",
          results: deliveredResults,
        });
        recordDeliveredPayload(payloadSummary, deliveredResults);
        recordMessageSentEvent({
          success: true,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId: deliveredResults.at(-1)?.messageId,
        });
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget(),
          messageId: deliveredResults.find((entry) => entry.messageId)?.messageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget(),
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (deliveryHandler.sendFormattedText) {
          await recordIdentifiedDeliveryResults(
            await deliveryHandler.sendFormattedText(
              payloadSummary.text,
              withPreparedTarget(applySendReplyToConsumption(sendOverrides)),
            ),
          );
          adoptSuccessfulResultsSince(beforeCount);
        } else {
          await sendTextChunks(deliveryHandler, payloadSummary.text, sendOverrides);
        }
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length > 0) {
          recordPayloadOutcome({
            index: payloadIndex,
            status: "sent",
            results: deliveredResults,
          });
          recordDeliveredPayload(payloadSummary, deliveredResults);
        } else {
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
        }
        const messageId = deliveredResults.at(-1)?.messageId;
        const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
        recordMessageSentEvent({
          success: deliveredResults.length > 0,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget(),
          messageId: pinMessageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget(),
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        continue;
      }

      if (!deliveryHandler.supportsMedia) {
        log.warn(
          "Plugin outbound adapter does not implement sendMedia; media URLs will be dropped and text fallback will be used",
          {
            channel,
            to,
            mediaCount: payloadSummary.mediaUrls.length,
          },
        );
        const fallbackText = payloadSummary.text.trim();
        if (!fallbackText) {
          throw new Error(
            "Plugin outbound adapter does not implement sendMedia and no text fallback is available for media payload",
          );
        }
        const beforeCount = results.length;
        await sendTextChunks(deliveryHandler, fallbackText, sendOverrides);
        const deliveredResults = results.slice(beforeCount);
        if (deliveredResults.length > 0) {
          recordPayloadOutcome({
            index: payloadIndex,
            status: "sent",
            results: deliveredResults,
          });
          recordDeliveredPayload(
            { ...payloadSummary, text: fallbackText, mediaUrls: [] },
            deliveredResults,
          );
        } else {
          recordPayloadOutcome(
            suppressedPayloadOutcome({
              index: payloadIndex,
              reason: "adapter_returned_no_identity",
            }),
          );
        }
        const messageId = deliveredResults.at(-1)?.messageId;
        const pinMessageId = deliveredResults.find((entry) => entry.messageId)?.messageId;
        recordMessageSentEvent({
          success: deliveredResults.length > 0,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget(),
          messageId: pinMessageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget(),
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        continue;
      }

      let firstMessageId: string | undefined;
      let lastMessageId: string | undefined;
      const beforeCount = results.length;
      const mediaUnits = planOutboundMediaMessageUnits({
        mediaUrls: payloadSummary.mediaUrls,
        caption: payloadSummary.text,
        overrides: sendOverrides,
        consumeReplyTo: applySendReplyToConsumption,
      });
      for (const unit of mediaUnits) {
        if (unit.kind !== "media") {
          continue;
        }
        throwIfAborted(abortSignal);
        const resultIndex = results.length;
        const delivery = deliveryHandler.sendFormattedMedia
          ? await deliveryHandler.sendFormattedMedia(
              unit.caption ?? "",
              unit.mediaUrl,
              withPreparedTarget(unit.overrides),
            )
          : await deliveryHandler.sendMedia(
              unit.caption ?? "",
              unit.mediaUrl,
              withPreparedTarget(unit.overrides),
            );
        const recorded = await recordIdentifiedDeliveryResult(delivery);
        adoptSuccessfulResultsSince(resultIndex);
        if (recorded) {
          firstMessageId ??= delivery.messageId;
          lastMessageId = delivery.messageId;
        }
      }
      const deliveredResults = results.slice(beforeCount);
      if (deliveredResults.length > 0) {
        recordPayloadOutcome({
          index: payloadIndex,
          status: "sent",
          results: deliveredResults,
        });
        recordDeliveredPayload(payloadSummary, deliveredResults);
      } else {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "adapter_returned_no_identity",
          }),
        );
      }
      recordMessageSentEvent({
        success: deliveredResults.length > 0,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        messageId: lastMessageId,
      });
      await maybePinDeliveredMessage({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget(),
        messageId: firstMessageId,
        gatewayClientScopes: params.gatewayClientScopes,
      });
      await maybeNotifyAfterDeliveredPayload({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget(),
        results: deliveredResults,
      });
      completeDeliveryDiagnostics(results.length - beforeCount);
    } catch (err) {
      // A rejected adapter has no final return to reconcile with its progress
      // results. Keep the results, but never match them to a later payload.
      resetReportedResults();
      const failedPayloadResults = results.slice(payloadResultStartIndex);
      adoptSuccessfulResultsSince(payloadResultStartIndex);
      if (effectivePayload && failedPayloadResults.length > 0) {
        await maybeNotifyAfterDeliveredPayload({
          handler: await getDeliveryHandler(buildPayloadSummary(effectivePayload).mediaUrls),
          payload: effectivePayload,
          target: baseHandler.buildTargetRef({ threadId: preparedTarget.threadId }),
          results: failedPayloadResults,
        });
      }
      recordPayloadOutcome({
        index: payloadIndex,
        status: "failed",
        error: err,
        sentBeforeError: failedPayloadResults.length > 0,
        stage: "platform_send",
        results: failedPayloadResults,
      });
      errorDeliveryDiagnostics(err);
      // A completed provider send records success before optional pin/notify
      // bookkeeping. Reaching this fallback first means the logical payload's
      // provider fan-out itself was incomplete, even if an earlier part sent.
      recordMessageSentEvent({
        success: false,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        error: formatErrorMessage(err),
        ...(failedPayloadResults.at(-1)?.messageId
          ? { messageId: failedPayloadResults.at(-1)!.messageId }
          : {}),
      });
      if (!params.bestEffort) {
        throw toOutboundDeliveryError({
          error: err,
          results,
          payloadOutcomes,
          stage: "platform_send",
        });
      }
      params.onError?.(err, payloadSummary);
    }
  }
  await mirrorDeliveredPayloads({
    delivery: params,
    payloads: deliveredMirrorPayloads,
    channel,
    to,
  });

  return results;
}
