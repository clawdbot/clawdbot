// Telegram plugin module owns buffered reply payload delivery decisions.
import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isFastModeAutoProgressPayload,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { TelegramDeliveryController } from "./bot-message-dispatch-delivery.js";
import type { TelegramDraftController } from "./bot-message-dispatch-draft.js";
import type { TelegramProgressController } from "./bot-message-dispatch-progress.js";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
import type { TelegramDispatchTurnState } from "./bot-message-dispatch.types.js";
import type { TelegramStreamMode } from "./bot/types.js";
import { resolveTelegramInlineButtons, type TelegramInlineButtons } from "./button-types.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { createTelegramReasoningStepState } from "./reasoning-lane-coordinator.js";

type BufferedDispatchParams = Parameters<
  TelegramBotDeps["dispatchReplyWithBufferedBlockDispatcher"]
>[0];
type DispatcherOptions = BufferedDispatchParams["dispatcherOptions"];
type Deliver = DispatcherOptions["deliver"];
type Skip = NonNullable<DispatcherOptions["onSkip"]>;
type ErrorCallback = NonNullable<DispatcherOptions["onError"]>;
type Cancel = NonNullable<DispatcherOptions["onBeforeDeliverCancelled"]>;

type TelegramReplyDeliveryResult = {
  visibleReplySent: boolean;
  suppression?: { reason: "no_visible_result" };
  finalization?: Promise<{ visibleReplySent: boolean }>;
};

function toTelegramReplyDeliveryResult(
  visibleReplySent: boolean,
  finalization?: Promise<{ visibleReplySent: boolean }>,
): TelegramReplyDeliveryResult {
  if (finalization) {
    return { visibleReplySent, finalization };
  }
  return visibleReplySent
    ? { visibleReplySent: true }
    : { visibleReplySent: false, suppression: { reason: "no_visible_result" } };
}

function toTelegramVisiblePartialDeliveryError(error: unknown): unknown {
  return isChannelPartialDeliveryError(error)
    ? error
    : createChannelPartialDeliveryError(error, { visibleReplySent: true });
}

function resolvePayloadTelegramInlineButtons(
  payload: ReplyPayload,
): TelegramInlineButtons | undefined {
  const telegramData = payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons }
    | undefined;
  return resolveTelegramInlineButtons({
    buttons: telegramData?.buttons,
    presentation: normalizeMessagePresentation(payload.presentation),
    interactive: payload.interactive,
  });
}

function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  return payload.channelData?.execApproval !== undefined;
}

export function createTelegramReplyDelivery(params: {
  cfg: OpenClawConfig;
  context: TelegramMessageContext;
  delivery: TelegramDeliveryController;
  draft: TelegramDraftController;
  fence: { generation: () => number; isSuperseded: () => boolean };
  progress: TelegramProgressController;
  runtime: RuntimeEnv;
  state: TelegramDispatchTurnState;
  streamMode: TelegramStreamMode;
  telegramCfg: TelegramAccountConfig;
}) {
  const reasoningStepState = createTelegramReasoningStepState();
  let bufferedFinalSettlement:
    | {
        promise: Promise<{ visibleReplySent: boolean }>;
        visibleReplySent: boolean;
        resolve: (result: { visibleReplySent: boolean }) => void;
        reject: (error: unknown) => void;
      }
    | undefined;
  const sentBlockMediaUrls = new Set<string>();
  params.draft.setReasoningStepCallbacks({
    noteHint: () => reasoningStepState.noteReasoningHint(),
    noteDelivered: () => reasoningStepState.noteReasoningDelivered(),
  });

  const settleBufferedFinalAsNotVisible = () => {
    if (bufferedFinalSettlement) {
      bufferedFinalSettlement.resolve({
        visibleReplySent: bufferedFinalSettlement.visibleReplySent,
      });
    }
    bufferedFinalSettlement = undefined;
  };
  const resetReasoningStepState = () => {
    settleBufferedFinalAsNotVisible();
    reasoningStepState.resetForNextStep();
  };
  const flushBufferedFinalAnswer = async (currentPayloadVisible = false): Promise<void> => {
    const settlement = bufferedFinalSettlement;
    const buffered = reasoningStepState.takeBufferedFinalAnswer(params.fence.generation());
    if (!buffered) {
      // A stale fence can discard the buffered text after another segment became visible.
      // Preserve that partial visibility so core does not reconcile an actual send away.
      settlement?.resolve({ visibleReplySent: settlement.visibleReplySent });
      bufferedFinalSettlement = undefined;
      resetReasoningStepState();
      return;
    }
    bufferedFinalSettlement = undefined;
    try {
      const result = await params.delivery.deliverFinalAnswerText(
        buffered.payload,
        buffered.text,
        resolvePayloadTelegramInlineButtons(buffered.payload),
      );
      if (settlement) {
        settlement.resolve({
          visibleReplySent: settlement.visibleReplySent || result.kind !== "skipped",
        });
      }
      resetReasoningStepState();
    } catch (error: unknown) {
      if (settlement) {
        settlement.reject(
          settlement.visibleReplySent ? toTelegramVisiblePartialDeliveryError(error) : error,
        );
      }
      throw currentPayloadVisible ? toTelegramVisiblePartialDeliveryError(error) : error;
    }
  };
  const settleTerminalNoVisibleDelivery = async (
    info: Parameters<NonNullable<Deliver>>[1],
    options?: { abandonBufferedFinal?: boolean },
  ): Promise<TelegramReplyDeliveryResult> => {
    if (options?.abandonBufferedFinal) {
      resetReasoningStepState();
    } else if (info.kind === "final") {
      await flushBufferedFinalAnswer();
    }
    return toTelegramReplyDeliveryResult(false);
  };
  const trackBlockMedia = (delivered: boolean, kind: string, payload: ReplyPayload) => {
    if (delivered && kind === "block" && payload.mediaUrls?.length) {
      for (const url of payload.mediaUrls) {
        sentBlockMediaUrls.add(url);
      }
    }
  };

  const deliver = (async (
    payload: Parameters<Deliver>[0],
    info: Parameters<Deliver>[1],
  ): Promise<TelegramReplyDeliveryResult> => {
    if (params.fence.isSuperseded()) {
      return await settleTerminalNoVisibleDelivery(info, { abandonBufferedFinal: true });
    }
    const normalizedPayload = params.delivery.normalizeDeliveryPayload(payload);
    if (!normalizedPayload) {
      return await settleTerminalNoVisibleDelivery(info);
    }
    const deduped =
      info.kind === "final"
        ? deduplicateBlockSentMedia(normalizedPayload, sentBlockMediaUrls)
        : normalizedPayload;
    if (!deduped) {
      return await settleTerminalNoVisibleDelivery(info);
    }
    const effectivePayload = deduped;
    if (
      shouldSuppressLocalTelegramExecApprovalPrompt({
        cfg: params.cfg,
        accountId: params.context.route.accountId,
        payload: effectivePayload,
      })
    ) {
      params.state.queuedFinal = true;
      return await settleTerminalNoVisibleDelivery(info);
    }
    const telegramButtons = resolvePayloadTelegramInlineButtons(effectivePayload);
    const lanePayload =
      info.kind === "block" &&
      typeof payload.text === "string" &&
      typeof effectivePayload.text === "string" &&
      payload.text !== effectivePayload.text &&
      payload.text.trimEnd() === effectivePayload.text &&
      !effectivePayload.mediaUrl &&
      !effectivePayload.mediaUrls?.length
        ? { ...effectivePayload, text: payload.text }
        : effectivePayload;
    const split = params.draft.splitTextIntoLaneSegments(
      { text: lanePayload.text },
      payload.isReasoning,
    );
    const segments = split.segments;
    const reply = resolveSendableOutboundReplyParts(effectivePayload);
    if (info.kind === "final" && (reply.text.length > 0 || reply.hasMedia)) {
      params.progress.markFinalStarted();
    }
    if (info.kind === "final") {
      await params.draft.enqueueEvent(async () => {});
    }
    const isToolPayloadAfterFinal =
      info.kind === "tool" &&
      (params.progress.finalAnswerDeliveryStarted() || params.progress.finalAnswerDelivered());
    const isNonTerminalWarningAfterDeliveredFinal =
      isReplyPayloadNonTerminalToolErrorWarning(payload) && params.progress.finalAnswerDelivered();
    if (
      (isToolPayloadAfterFinal || isNonTerminalWarningAfterDeliveredFinal) &&
      !reply.hasMedia &&
      !hasExecApprovalPayload(effectivePayload)
    ) {
      return await settleTerminalNoVisibleDelivery(info);
    }
    if (payload.isError === true) {
      params.state.hadErrorReplyFailureOrSkip = true;
    }

    let blockDelivered = false;
    let finalization: Promise<{ visibleReplySent: boolean }> | undefined;
    const hasAnswerSegment = segments.some((segment) => segment.lane === "answer");
    if (info.kind === "block" && !hasAnswerSegment) {
      params.draft.dropQueuedAnswerBlockRotation(effectivePayload, info.assistantMessageIndex);
    }
    for (const segment of segments) {
      if (
        segment.lane === "answer" &&
        info.kind === "final" &&
        reasoningStepState.shouldBufferFinalAnswer()
      ) {
        let resolveFinalization!: (result: { visibleReplySent: boolean }) => void;
        let rejectFinalization!: (error: unknown) => void;
        finalization = new Promise((resolve, reject) => {
          resolveFinalization = resolve;
          rejectFinalization = reject;
        });
        // The coordinator admits only one buffered answer. Settle defensively before replacing
        // its paired promise so an unexpected rebuffer can never orphan turn finalization.
        settleBufferedFinalAsNotVisible();
        bufferedFinalSettlement = {
          promise: finalization,
          visibleReplySent: blockDelivered,
          resolve: resolveFinalization,
          reject: rejectFinalization,
        };
        reasoningStepState.bufferFinalAnswer({
          payload: effectivePayload,
          text: segment.update.text,
          bufferedGeneration: params.fence.generation(),
        });
        continue;
      }
      if (segment.lane === "reasoning") {
        reasoningStepState.noteReasoningHint();
      }
      if (segment.lane === "answer" && info.kind === "tool") {
        if (params.progress.verboseProgressActive()) {
          if (
            await params.delivery.sendPayload(
              params.delivery.applyTextToPayload(effectivePayload, segment.update.text),
            )
          ) {
            blockDelivered = true;
          }
          continue;
        }
        const canRepresentAsTransientProgress =
          !reply.hasMedia &&
          telegramButtons === undefined &&
          !hasExecApprovalPayload(effectivePayload);
        const isFastModeProgressPayload = isFastModeAutoProgressPayload(effectivePayload);
        if (params.streamMode === "progress") {
          if (
            canRepresentAsTransientProgress &&
            params.draft.answerLane.stream &&
            !isFastModeProgressPayload
          ) {
            continue;
          }
          if (
            (canRepresentAsTransientProgress || isFastModeProgressPayload) &&
            (await params.progress.pushToolProgress(segment.update.text, {
              startImmediately: true,
            }))
          ) {
            blockDelivered = true;
            continue;
          }
        }
        await params.draft.prepareAnswerLaneForToolProgress();
      }

      const ownedByQueuedRotation = params.draft.isQueuedAnswerBlock(
        lanePayload,
        info.assistantMessageIndex,
      );
      const skipTextOnlyBlock =
        params.streamMode === "partial" &&
        info.kind === "block" &&
        segment.lane === "answer" &&
        !reply.hasMedia &&
        !hasExecApprovalPayload(effectivePayload) &&
        telegramButtons === undefined &&
        params.draft.answerLane.hasStreamedMessage &&
        !params.draft.isAnswerToolProgressOnly() &&
        !ownedByQueuedRotation &&
        segment.update.text.trimEnd() === params.draft.answerLane.lastPartialText.trimEnd();
      const suppressProgressAnswerBlock =
        params.streamMode === "progress" &&
        info.kind === "block" &&
        segment.lane === "answer" &&
        !reply.hasMedia &&
        !hasExecApprovalPayload(effectivePayload) &&
        telegramButtons === undefined;
      if (skipTextOnlyBlock || suppressProgressAnswerBlock) {
        params.draft.setActiveAnswerBlockDelivery({
          payload: effectivePayload,
          text: segment.update.text,
          buttons: telegramButtons,
        });
        params.draft.resetAnswerToolProgressDraft();
        params.progress.reset();
        blockDelivered = true;
        continue;
      }

      if (segment.lane === "answer" && info.kind === "block") {
        const prepared = await params.draft.prepareAnswerLaneForText();
        const shouldRotate = params.draft.takeQueuedAnswerBlockRotation(
          lanePayload,
          info.assistantMessageIndex,
        );
        if (params.streamMode !== "progress" && shouldRotate && !prepared) {
          await params.draft.rotateAnswerLaneForNewMessage();
          params.draft.setRotateWhenQueuedBlocksSettle(false);
        }
        params.draft.resetAnswerToolProgressDraft();
        params.progress.reset();
      }
      const result =
        segment.lane === "answer" && info.kind === "final"
          ? await params.delivery.deliverFinalAnswerText(
              effectivePayload,
              segment.update.text,
              telegramButtons,
            )
          : await params.delivery.deliverLaneText({
              laneName: segment.lane,
              text: segment.update.text,
              payload: lanePayload,
              infoKind: info.kind,
              buttons: telegramButtons,
            });
      if (
        segment.lane === "answer" &&
        info.kind !== "final" &&
        result.kind === "preview-finalized"
      ) {
        await params.delivery.emitPreviewFinalizedHook(result);
      }
      if (segment.lane === "answer" && info.kind === "block" && result.kind === "preview-updated") {
        params.draft.setActiveAnswerBlockDelivery({
          payload: lanePayload,
          text: segment.update.text,
          buttons: telegramButtons,
        });
      }
      blockDelivered ||= result.kind !== "skipped";
      if (segment.lane === "reasoning") {
        if (result.kind !== "skipped") {
          reasoningStepState.noteReasoningDelivered();
          if (finalization && bufferedFinalSettlement) {
            bufferedFinalSettlement.visibleReplySent ||= blockDelivered;
          }
          await flushBufferedFinalAnswer(blockDelivered);
        }
      } else if (info.kind === "final") {
        resetReasoningStepState();
      }
    }
    if (segments.length > 0) {
      if (finalization && bufferedFinalSettlement) {
        bufferedFinalSettlement.visibleReplySent ||= blockDelivered;
      }
      trackBlockMedia(blockDelivered, info.kind, effectivePayload);
      return toTelegramReplyDeliveryResult(blockDelivered, finalization);
    }

    if (split.suppressedReasoningOnly) {
      let delivered = false;
      if (info.kind === "final") {
        await params.draft.rotateAnswerLaneAfterToolProgress();
        await params.draft.answerLane.stream?.stop();
        await params.draft.reasoningLane.stream?.stop();
        await flushBufferedFinalAnswer();
      }
      if (reply.hasMedia) {
        const payloadWithoutReasoning =
          typeof effectivePayload.text === "string"
            ? { ...effectivePayload, text: "" }
            : effectivePayload;
        delivered = await params.delivery.sendPayload(payloadWithoutReasoning, {
          durable: info.kind === "final",
        });
      }
      if (info.kind === "final" && delivered) {
        params.progress.markFinalDelivered();
      }
      trackBlockMedia(delivered, info.kind, effectivePayload);
      return toTelegramReplyDeliveryResult(delivered);
    }

    if (info.kind === "final") {
      await params.draft.rotateAnswerLaneAfterToolProgress();
      await params.draft.answerLane.stream?.stop();
      await params.draft.reasoningLane.stream?.stop();
      await flushBufferedFinalAnswer();
    }
    if (!reply.hasMedia && reply.text.length === 0) {
      if (info.kind === "final") {
        await flushBufferedFinalAnswer();
      }
      return toTelegramReplyDeliveryResult(false);
    }
    const delivered = await params.delivery.sendPayload(effectivePayload, {
      durable: info.kind === "final",
    });
    if (info.kind === "final" && delivered) {
      params.progress.markFinalDelivered();
    }
    trackBlockMedia(delivered, info.kind, effectivePayload);
    return toTelegramReplyDeliveryResult(delivered);
  }) satisfies Deliver;

  const onSkip: Skip = (payload, info) => {
    if (info.kind === "block") {
      void params.draft.enqueueEvent(async () => {
        params.draft.dropQueuedAnswerBlockRotation(payload, info.assistantMessageIndex);
      });
    }
    if (payload.isError === true) {
      params.state.hadErrorReplyFailureOrSkip = true;
    }
    if (info.reason !== "silent") {
      params.delivery.markNonSilentSkip();
    }
  };

  const onError: ErrorCallback = (err, info) => {
    const errorPolicy = resolveTelegramErrorPolicy({
      accountConfig: params.telegramCfg,
      groupConfig: params.context.groupConfig,
      topicConfig: params.context.topicConfig,
    });
    if (isSilentErrorPolicy(errorPolicy.policy)) {
      return;
    }
    if (
      errorPolicy.policy === "once" &&
      shouldSuppressTelegramError({
        scopeKey: buildTelegramErrorScopeKey({
          accountId: params.context.route.accountId,
          chatId: params.context.chatId,
          threadId: params.context.threadSpec.id,
        }),
        cooldownMs: errorPolicy.cooldownMs,
        errorMessage: String(err),
      })
    ) {
      return;
    }
    params.delivery.markNonSilentFailure();
    params.runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
  };

  return {
    deliver,
    onBeforeDeliverCancelled: (payload: Parameters<Cancel>[0], info: Parameters<Cancel>[1]) => {
      if (info.kind === "block") {
        return params.draft.enqueueEvent(async () => {
          params.draft.dropQueuedAnswerBlockRotation(payload, info.assistantMessageIndex);
        });
      }
      return undefined;
    },
    onError,
    onSkip,
    reasoningStepState: { ...reasoningStepState, resetForNextStep: resetReasoningStepState },
  };
}

export type TelegramReplyDelivery = ReturnType<typeof createTelegramReplyDelivery>;
