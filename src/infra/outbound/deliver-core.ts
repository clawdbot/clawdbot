// Executes normalized outbound payloads against the selected channel transport.
import { resolveChunkMode, resolveTextChunkLimit } from "../../auto-reply/chunk.js";
import { hasReplyPayloadContent } from "../../interactive/payload.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import type { OutboundMediaAccess } from "../../media/load-options.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import { getOrCreatePromise } from "../../shared/lazy-promise.js";
import type { DiagnosticMessageDeliveryKind } from "../diagnostic-events.js";
import { formatErrorMessage } from "../errors.js";
import { throwIfAborted } from "./abort.js";
import { createChannelHandler, resolveChannelOutboundDirectiveOptions } from "./deliver-channel.js";
import type { ChannelHandler, DeliverOutboundPayloadsCoreParams } from "./deliver-contracts.js";
import {
  applyMessageSendingHook,
  applyReplyPayloadSendingHook,
  createMessageSentEmitter,
  suppressedPayloadOutcome,
  toOutboundDeliveryError,
} from "./deliver-hooks.js";
import { OUTBOUND_DELIVERY_LOG_SCOPE } from "./deliver-log.js";
import {
  buildPayloadSummary,
  deliveryKindForPayload,
  emitMessageDeliveryCompleted,
  emitMessageDeliveryError,
  emitMessageDeliveryStarted,
  maybeNotifyAfterDeliveredPayload,
  maybePinDeliveredMessage,
  normalizeEmptyPayloadForDelivery,
  normalizePayloadsForChannelDelivery,
  renderPresentationForDelivery,
  resolveOutboundMediaAccessForSend,
  sessionKeyForDeliveryDiagnostics,
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
import { createOutboundPayloadPlan, type NormalizedOutboundPayload } from "./payloads.js";
import { createReplyToDeliveryPolicy } from "./reply-policy.js";

const log = createSubsystemLogger("outbound/deliver");

export async function deliverOutboundPayloadsCore(
  params: DeliverOutboundPayloadsCoreParams,
): Promise<OutboundDeliveryResult[]> {
  const { cfg, channel, to, payloads } = params;
  const directiveOptions = await resolveChannelOutboundDirectiveOptions({ cfg, channel });
  const outboundPayloadPlan = createOutboundPayloadPlan(payloads, {
    cfg,
    sessionKey: params.session?.policyKey ?? params.session?.key,
    surface: channel,
    conversationType: params.session?.conversationType,
    extractMarkdownImages: directiveOptions.extractMarkdownImages,
  });
  const accountId = params.accountId;
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
  const resolveMediaAccess = (mediaSources: readonly string[]): OutboundMediaAccess =>
    resolveOutboundMediaAccessForSend(params, channel, mediaSources);
  const createHandler = (mediaSources: readonly string[]) =>
    createChannelHandler({
      cfg,
      channel,
      to,
      deps,
      accountId,
      replyToId: params.replyToId,
      replyToMode: params.replyToMode,
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
      onPlatformSendStart: params.onPlatformSendStart,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
      onDeliveryResult: reportIdentifiedDeliveryResult,
    });
  const baseHandler = await createHandler([]);
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
    replyToId: params.replyToId,
    replyToMode: params.replyToMode,
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
      await recordIdentifiedDeliveryResult(await sendHandler.sendText(unit.text, unit.overrides));
    }
  };
  const normalizedPayloads = normalizePayloadsForChannelDelivery(outboundPayloadPlan, handler);
  const payloadOutcomes: OutboundPayloadDeliveryOutcome[] = [];
  const effectiveDeliveryKinds = new Map<number, OutboundPayloadDeliveryKind>();
  const recordPayloadOutcome = (outcome: OutboundPayloadDeliveryOutcome): void => {
    const deliveryKind = effectiveDeliveryKinds.get(outcome.index);
    const recordedOutcome =
      deliveryKind && outcome.status !== "suppressed" ? { ...outcome, deliveryKind } : outcome;
    payloadOutcomes.push(recordedOutcome);
    params.onPayloadDeliveryOutcome?.(recordedOutcome);
  };
  if (normalizedPayloads.length === 0) {
    for (const [index] of payloads.entries()) {
      recordPayloadOutcome(suppressedPayloadOutcome({ index, reason: "no_visible_payload" }));
    }
  } else {
    const normalizedPayloadIndexes = new Set(normalizedPayloads.map((entry) => entry.index));
    for (const [index] of payloads.entries()) {
      if (!normalizedPayloadIndexes.has(index)) {
        recordPayloadOutcome(suppressedPayloadOutcome({ index, reason: "no_visible_payload" }));
      }
    }
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
  const hookRunner = getGlobalHookRunner();
  // Canonical session key forwarded to internal lifecycle hooks
  // (`message:sent` event, `message_sending` plugin hook ctx, etc.). Mirror
  // delivery wins because mirror sends are explicitly bound to the mirror's
  // session; otherwise we use `session.key`, which by contract equals the
  // agent runtime's `params.sessionKey` for the run that produced the
  // payload (see OutboundSessionContext.key JSDoc). We deliberately do NOT
  // fall back to `session.policyKey` here — the policy key describes the
  // delivery target's policy, not the canonical control session, and
  // handing it to plugins that correlate against agent_end would be wrong.
  const sessionKeyForInternalHooks = params.mirror?.sessionKey ?? params.session?.key;
  const mirrorIsGroup = params.mirror?.isGroup;
  const mirrorGroupId = params.mirror?.groupId;
  const { emitMessageSent, hasMessageSentHooks } = createMessageSentEmitter({
    hookRunner,
    channel,
    to,
    accountId,
    sessionKeyForInternalHooks,
    isGroup: mirrorIsGroup,
    groupId: mirrorGroupId,
    logPrefix: OUTBOUND_DELIVERY_LOG_SCOPE,
  });
  const hasMessageSendingHooks = hookRunner?.hasHooks("message_sending") ?? false;
  const diagnosticSessionKey = sessionKeyForDeliveryDiagnostics(params);
  if (hasMessageSentHooks && params.session?.agentId && !sessionKeyForInternalHooks) {
    log.warn(
      `${OUTBOUND_DELIVERY_LOG_SCOPE}: session.agentId present without session key; internal message:sent hook will be skipped`,
      {
        channel,
        to,
        agentId: params.session.agentId,
      },
    );
  }
  for (const { index: payloadIndex, payload } of normalizedPayloads) {
    const payloadResultStartIndex = results.length;
    let payloadSummary = buildPayloadSummary(payload);
    const originalMediaCount = payloadSummary.mediaUrls.length;
    let deliveryKind: DiagnosticMessageDeliveryKind = "other";
    let deliveryStartedAt = 0;
    let deliveryStarted = false;
    let deliveryFinished = false;
    const startDeliveryDiagnostics = (kind: DiagnosticMessageDeliveryKind) => {
      deliveryKind = kind;
      deliveryStartedAt = Date.now();
      deliveryStarted = true;
      deliveryFinished = false;
      emitMessageDeliveryStarted({
        channel,
        deliveryKind,
        sessionKey: diagnosticSessionKey,
      });
    };
    const completeDeliveryDiagnostics = (resultCount: number) => {
      if (!deliveryStarted) {
        return;
      }
      deliveryFinished = true;
      emitMessageDeliveryCompleted({
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        resultCount,
        sessionKey: diagnosticSessionKey,
      });
    };
    const errorDeliveryDiagnostics = (err: unknown) => {
      if (!deliveryStarted || deliveryFinished) {
        return;
      }
      deliveryFinished = true;
      emitMessageDeliveryError({
        channel,
        deliveryKind,
        durationMs: Date.now() - deliveryStartedAt,
        error: err,
        sessionKey: diagnosticSessionKey,
      });
    };
    try {
      throwIfAborted(abortSignal);

      const replyHookResult = await applyReplyPayloadSendingHook({
        hook: params.replyPayloadSendingHook,
        payload,
      });
      if (replyHookResult.cancelled) {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "cancelled_by_reply_payload_sending_hook",
          }),
        );
        continue;
      }
      let deliveryPayload = replyHookResult.payload;
      payloadSummary = buildPayloadSummary(deliveryPayload);

      // Run message_sending plugin hook (may modify content or cancel)
      const hookResult = await applyMessageSendingHook({
        hookRunner,
        enabled: hasMessageSendingHooks,
        payload: deliveryPayload,
        payloadSummary,
        to,
        channel,
        accountId,
        replyToId: resolveCurrentReplyTo(deliveryPayload).replyToId,
        threadId: params.threadId,
        sessionKey: sessionKeyForInternalHooks,
      });
      if (hookResult.cancelled) {
        const hookEffect =
          hookResult.cancelReason || hookResult.hookMetadata
            ? {
                ...(hookResult.cancelReason ? { cancelReason: hookResult.cancelReason } : {}),
                ...(hookResult.hookMetadata ? { metadata: hookResult.hookMetadata } : {}),
              }
            : undefined;
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: "cancelled_by_message_sending_hook",
            ...(hookEffect ? { hookEffect } : {}),
          }),
        );
        continue;
      }
      deliveryPayload = hookResult.payload;
      const presentationHandler = await getDeliveryHandler(
        buildPayloadSummary(deliveryPayload).mediaUrls,
      );
      const renderedPayload = stripInternalRuntimeScaffoldingFromPayload(
        await renderPresentationForDelivery(presentationHandler, deliveryPayload),
      );
      const renderedHandler = await getDeliveryHandler(
        buildPayloadSummary(renderedPayload).mediaUrls,
      );
      const normalizedEffectivePayload = renderedHandler.normalizePayload
        ? renderedHandler.normalizePayload(renderedPayload)
        : renderedPayload;
      const effectivePayload = normalizedEffectivePayload
        ? normalizeEmptyPayloadForDelivery(
            stripInternalRuntimeScaffoldingFromPayload(normalizedEffectivePayload),
          )
        : null;
      if (!effectivePayload) {
        recordPayloadOutcome(
          suppressedPayloadOutcome({
            index: payloadIndex,
            reason: hookResult.contentRewritten
              ? "empty_after_message_sending_hook"
              : replyHookResult.changed
                ? "empty_after_reply_payload_sending_hook"
                : "no_visible_payload",
          }),
        );
        continue;
      }
      const effectivePayloadSummary = buildPayloadSummary(effectivePayload);
      assertStableMediaFanout(params, payloadIndex, originalMediaCount, effectivePayloadSummary);
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
        ...(params.threadId !== undefined ? { threadId: params.threadId } : {}),
        ...(effectivePayload.audioAsVoice === true ? { audioAsVoice: true } : {}),
        ...(params.forceDocument !== undefined ? { forceDocument: params.forceDocument } : {}),
      };
      const applySendReplyToConsumption = <T extends OutboundMessageSendOverrides>(
        overrides: T,
      ): T =>
        applyReplyToConsumption(overrides, {
          consumeImplicitReply: replyToResolution.source === "implicit",
        });
      const deliveryTarget = deliveryHandler.buildTargetRef({ threadId: sendOverrides.threadId });
      if (
        deliveryHandler.sendPayload &&
        ((effectivePayload.isError === true &&
          deliveryHandler.sendTextOnlyErrorPayloads === true) ||
          hasReplyPayloadContent(
            {
              presentation: effectivePayload.presentation,
              interactive: effectivePayload.interactive,
              channelData: effectivePayload.channelData,
              location: effectivePayload.location,
            },
            {
              extraContent: effectivePayload.location != null,
            },
          ) ||
          effectivePayload.audioAsVoice === true ||
          effectivePayload.videoAsNote === true)
      ) {
        const beforeCount = results.length;
        const delivery = await deliveryHandler.sendPayload(
          effectivePayload,
          applySendReplyToConsumption(sendOverrides),
        );
        await recordIdentifiedDeliveryResult(delivery);
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
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: deliveredResults.find((entry) => entry.messageId)?.messageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: true,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId: deliveredResults.at(-1)?.messageId,
        });
        continue;
      }
      if (payloadSummary.mediaUrls.length === 0) {
        const beforeCount = results.length;
        if (deliveryHandler.sendFormattedText) {
          await recordIdentifiedDeliveryResults(
            await deliveryHandler.sendFormattedText(
              payloadSummary.text,
              applySendReplyToConsumption(sendOverrides),
            ),
          );
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
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: pinMessageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: deliveredResults.length > 0,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
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
        await maybePinDeliveredMessage({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          messageId: pinMessageId,
          gatewayClientScopes: params.gatewayClientScopes,
        });
        await maybeNotifyAfterDeliveredPayload({
          handler: deliveryHandler,
          payload: effectivePayload,
          target: deliveryTarget,
          results: deliveredResults,
        });
        completeDeliveryDiagnostics(deliveredResults.length);
        emitMessageSent({
          success: deliveredResults.length > 0,
          content: payloadSummary.hookContent ?? payloadSummary.text,
          messageId,
        });
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
        const delivery = deliveryHandler.sendFormattedMedia
          ? await deliveryHandler.sendFormattedMedia(
              unit.caption ?? "",
              unit.mediaUrl,
              unit.overrides,
            )
          : await deliveryHandler.sendMedia(unit.caption ?? "", unit.mediaUrl, unit.overrides);
        if (await recordIdentifiedDeliveryResult(delivery)) {
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
      await maybePinDeliveredMessage({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget,
        messageId: firstMessageId,
        gatewayClientScopes: params.gatewayClientScopes,
      });
      await maybeNotifyAfterDeliveredPayload({
        handler: deliveryHandler,
        payload: effectivePayload,
        target: deliveryTarget,
        results: deliveredResults,
      });
      completeDeliveryDiagnostics(results.length - beforeCount);
      emitMessageSent({
        success: results.length > beforeCount,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        messageId: lastMessageId,
      });
    } catch (err) {
      // A rejected adapter has no final return to reconcile with its progress
      // results. Keep the results, but never match them to a later payload.
      resetReportedResults();
      const failedPayloadResults = results.slice(payloadResultStartIndex);
      recordPayloadOutcome({
        index: payloadIndex,
        status: "failed",
        error: err,
        sentBeforeError: failedPayloadResults.length > 0,
        stage: "platform_send",
        results: failedPayloadResults,
      });
      errorDeliveryDiagnostics(err);
      emitMessageSent({
        success: false,
        content: payloadSummary.hookContent ?? payloadSummary.text,
        error: formatErrorMessage(err),
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
