import {
  createChannelPartialDeliveryError,
  isChannelPartialDeliveryError,
} from "openclaw/plugin-sdk/channel-inbound";
import { normalizeMessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import {
  isFastModeAutoProgressPayload,
  isReplyPayloadNonTerminalToolErrorWarning,
  resolveAskUserQuestionOptionIndices,
  resolveSendableOutboundReplyParts,
  type ReplyPayload,
} from "openclaw/plugin-sdk/reply-payload";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { TelegramBotDeps } from "./bot-deps.js";
import {
  applyTextToPayload,
  deliverFinalAnswerText,
  handlePreviewFinalizedResult,
  normalizeDeliveryPayload,
  registerTelegramQuestionDeliveryForMessage,
  sendPayload,
} from "./bot-message-dispatch-delivery.js";
import {
  dropQueuedAnswerBlockRotation,
  enqueueDraftEvent,
  isQueuedAnswerBlock,
  prepareAnswerLaneForText,
  prepareAnswerLaneForToolProgress,
  rotateAnswerLaneAfterToolProgress,
  rotateAnswerLaneForNewMessage,
  splitTextIntoLaneSegments,
  takeQueuedAnswerBlockRotation,
} from "./bot-message-dispatch-draft.js";
import {
  markFinalDelivered,
  markFinalStarted,
  pushToolProgress,
} from "./bot-message-dispatch-progress.js";
import { deduplicateBlockSentMedia } from "./bot-message-dispatch.media-dedup.js";
import type {
  TelegramBufferedFinalSettlement,
  TelegramDispatchTurn as Turn,
  TelegramReplyStateSlice,
} from "./bot-message-dispatch.types.js";
import {
  appendTelegramDroppedControlFallback,
  resolveTelegramInlineButtons,
  type TelegramDroppedControl,
  type TelegramInlineButtons,
} from "./button-types.js";
import {
  buildTelegramErrorScopeKey,
  isSilentErrorPolicy,
  resolveTelegramErrorPolicy,
  shouldSuppressTelegramError,
} from "./error-policy.js";
import { shouldSuppressLocalTelegramExecApprovalPrompt } from "./exec-approvals.js";
import { createTelegramReasoningStepState } from "./reasoning-lane-coordinator.js";
import { resolveTelegramTargetChatType } from "./targets.js";

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

function resolvePayloadTelegramControls(
  turn: Turn,
  payload: ReplyPayload,
): { payload: ReplyPayload; buttons: TelegramInlineButtons | undefined } {
  const telegramData = payload.channelData?.telegram as
    | { buttons?: TelegramInlineButtons }
    | undefined;
  const droppedControls: TelegramDroppedControl[] = [];
  const buttons = resolveTelegramInlineButtons(
    {
      buttons: telegramData?.buttons,
      presentation: normalizeMessagePresentation(payload.presentation),
      interactive: payload.interactive,
    },
    {
      allowWebAppButtons: resolveTelegramTargetChatType(String(turn.context.chatId)) === "direct",
      onDroppedControl: (control) => droppedControls.push(control),
      questionOptionIndices: resolveAskUserQuestionOptionIndices(payload),
    },
  );
  const text = appendTelegramDroppedControlFallback(payload.text ?? "", droppedControls);
  return {
    payload: text === (payload.text ?? "") ? payload : { ...payload, text },
    buttons,
  };
}

function hasExecApprovalPayload(payload: ReplyPayload): boolean {
  return payload.channelData?.execApproval !== undefined;
}

export function createReplyState(): TelegramReplyStateSlice {
  return {
    reasoningStepState: createTelegramReasoningStepState(),
    bufferedFinalSettlement: undefined as TelegramBufferedFinalSettlement | undefined,
    sentBlockMediaUrls: new Set<string>(),
    splitReasoningOnNextStream: false,
  };
}

function settleBufferedFinalAsNotVisible(turn: Turn): void {
  if (turn.bufferedFinalSettlement) {
    turn.bufferedFinalSettlement.resolve({
      visibleReplySent: turn.bufferedFinalSettlement.visibleReplySent,
    });
  }
  turn.bufferedFinalSettlement = undefined;
}

export function resetReasoningStepState(turn: Turn): void {
  settleBufferedFinalAsNotVisible(turn);
  turn.reasoningStepState.resetForNextStep();
}

async function flushBufferedFinalAnswer(turn: Turn, currentPayloadVisible = false): Promise<void> {
  const settlement = turn.bufferedFinalSettlement;
  const buffered = turn.reasoningStepState.takeBufferedFinalAnswer();
  turn.bufferedFinalSettlement = undefined;
  if (!buffered) {
    settlement?.resolve({ visibleReplySent: settlement.visibleReplySent });
    turn.reasoningStepState.resetForNextStep();
    return;
  }
  try {
    const controls = resolvePayloadTelegramControls(turn, buffered);
    const result = await deliverFinalAnswerText(
      turn,
      controls.payload,
      controls.payload.text ?? "",
      controls.buttons,
      settlement?.onPlatformSendDispatch,
      settlement?.assertPlatformSendAuthorized,
      settlement?.bindPendingFinalDelivery,
    );
    if (settlement) {
      settlement.resolve({
        visibleReplySent: settlement.visibleReplySent || result.kind !== "skipped",
      });
    }
    resetReasoningStepState(turn);
  } catch (error: unknown) {
    if (settlement) {
      settlement.reject(
        settlement.visibleReplySent ? toTelegramVisiblePartialDeliveryError(error) : error,
      );
    }
    throw currentPayloadVisible ? toTelegramVisiblePartialDeliveryError(error) : error;
  }
}

async function stopTelegramReplyLanesAndFlushBufferedFinal(turn: Turn): Promise<void> {
  await rotateAnswerLaneAfterToolProgress(turn);
  await turn.answerLane.stream?.stop();
  await turn.reasoningLane.stream?.stop();
  // Both lanes must stop before the buffered flush, keeping the final answer the last visible send.
  await flushBufferedFinalAnswer(turn);
}

async function settleTerminalNoVisibleDelivery(
  turn: Turn,
  info: Parameters<NonNullable<Deliver>>[1],
  options?: { abandonBufferedFinal?: boolean },
): Promise<TelegramReplyDeliveryResult> {
  if (options?.abandonBufferedFinal) {
    resetReasoningStepState(turn);
  } else if (info.kind === "final") {
    // A terminal callback must drain the buffered answer before the next step can reset it.
    await flushBufferedFinalAnswer(turn);
  }
  return toTelegramReplyDeliveryResult(false);
}

function trackBlockMedia(
  turn: Turn,
  delivered: boolean,
  kind: string,
  payload: ReplyPayload,
): void {
  if (delivered && kind === "block" && payload.mediaUrls?.length) {
    for (const url of payload.mediaUrls) {
      turn.sentBlockMediaUrls.add(url);
    }
  }
}

export async function deliverReply(
  turn: Turn,
  payload: Parameters<NonNullable<Deliver>>[0],
  info: Parameters<NonNullable<Deliver>>[1],
): Promise<TelegramReplyDeliveryResult> {
  if (turn.isSuperseded()) {
    return await settleTerminalNoVisibleDelivery(turn, info, { abandonBufferedFinal: true });
  }
  const normalizedPayload = normalizeDeliveryPayload(turn, payload);
  if (!normalizedPayload) {
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  const deduped =
    info.kind === "final"
      ? deduplicateBlockSentMedia(normalizedPayload, turn.sentBlockMediaUrls)
      : normalizedPayload;
  if (!deduped) {
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  const controls = resolvePayloadTelegramControls(turn, deduped);
  const effectivePayload = controls.payload;
  if (
    shouldSuppressLocalTelegramExecApprovalPrompt({
      cfg: turn.cfg,
      accountId: turn.context.route.accountId,
      payload: effectivePayload,
    })
  ) {
    turn.queuedFinal = true;
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  const telegramButtons = controls.buttons;
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
  const split = splitTextIntoLaneSegments(turn, { text: lanePayload.text }, payload.isReasoning);
  const segments = split.segments;
  const reply = resolveSendableOutboundReplyParts(effectivePayload);
  if (info.kind === "final" && (reply.text.length > 0 || reply.hasMedia)) {
    // Mark final delivery before any queued draft drain; late tool progress must stay suppressed.
    markFinalStarted(turn);
  }
  if (info.kind === "final") {
    // Final delivery drains queued draft work so an earlier block cannot overtake it.
    await enqueueDraftEvent(turn, async () => {});
  }
  const isToolPayloadAfterFinal =
    info.kind === "tool" && (turn.finalAnswerDeliveryStarted || turn.finalAnswerDelivered);
  const isNonTerminalWarningAfterDeliveredFinal =
    isReplyPayloadNonTerminalToolErrorWarning(payload) && turn.finalAnswerDelivered;
  if (
    (isToolPayloadAfterFinal || isNonTerminalWarningAfterDeliveredFinal) &&
    !reply.hasMedia &&
    !hasExecApprovalPayload(effectivePayload)
  ) {
    return await settleTerminalNoVisibleDelivery(turn, info);
  }
  if (payload.isError === true) {
    turn.hadErrorReplyFailureOrSkip = true;
  }

  let blockDelivered = false;
  let finalization: Promise<{ visibleReplySent: boolean }> | undefined;
  const hasAnswerSegment = segments.some((segment) => segment.lane === "answer");
  if (info.kind === "block" && !hasAnswerSegment) {
    dropQueuedAnswerBlockRotation(turn, effectivePayload, info.assistantMessageIndex);
  }
  for (const segment of segments) {
    if (
      segment.lane === "answer" &&
      info.kind === "final" &&
      turn.reasoningStepState.shouldBufferFinalAnswer()
    ) {
      let resolveFinalization!: (result: { visibleReplySent: boolean }) => void;
      let rejectFinalization!: (error: unknown) => void;
      finalization = new Promise((resolve, reject) => {
        resolveFinalization = resolve;
        rejectFinalization = reject;
      });
      // The coordinator admits only one buffered answer. Settle defensively before replacing
      // its paired promise so an unexpected rebuffer can never orphan turn finalization.
      settleBufferedFinalAsNotVisible(turn);
      turn.bufferedFinalSettlement = {
        visibleReplySent: blockDelivered,
        onPlatformSendDispatch: info.onPlatformSendDispatch,
        assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
        bindPendingFinalDelivery: info.bindPendingFinalDelivery,
        resolve: resolveFinalization,
        reject: rejectFinalization,
      };
      turn.reasoningStepState.bufferFinalAnswer(
        applyTextToPayload(effectivePayload, segment.update.text),
      );
      continue;
    }
    if (segment.lane === "reasoning") {
      turn.reasoningStepState.noteReasoningHint();
    }
    if (segment.lane === "answer" && info.kind === "tool") {
      if (turn.verboseProgressActive()) {
        if (await sendPayload(turn, applyTextToPayload(effectivePayload, segment.update.text))) {
          blockDelivered = true;
        }
        continue;
      }
      const canRepresentAsTransientProgress =
        !reply.hasMedia &&
        telegramButtons === undefined &&
        effectivePayload.channelData?.askUser === undefined &&
        !hasExecApprovalPayload(effectivePayload);
      const isFastModeProgressPayload = isFastModeAutoProgressPayload(effectivePayload);
      if (turn.streamMode === "progress") {
        if (
          canRepresentAsTransientProgress &&
          turn.answerLane.stream &&
          !isFastModeProgressPayload
        ) {
          continue;
        }
        if (
          (canRepresentAsTransientProgress || isFastModeProgressPayload) &&
          (await pushToolProgress(turn, segment.update.text, {
            startImmediately: true,
          }))
        ) {
          blockDelivered = true;
          continue;
        }
      }
      await prepareAnswerLaneForToolProgress(turn);
    }

    const ownedByQueuedRotation = isQueuedAnswerBlock(
      turn,
      lanePayload,
      info.assistantMessageIndex,
    );
    const skipTextOnlyBlock =
      turn.streamMode === "partial" &&
      info.kind === "block" &&
      segment.lane === "answer" &&
      !reply.hasMedia &&
      !hasExecApprovalPayload(effectivePayload) &&
      telegramButtons === undefined &&
      turn.answerLane.hasStreamedMessage &&
      !turn.activeAnswerDraftIsToolProgressOnly &&
      !ownedByQueuedRotation &&
      segment.update.text.trimEnd() === turn.answerLane.lastPartialText.trimEnd();
    const suppressProgressAnswerBlock =
      turn.streamMode === "progress" &&
      info.kind === "block" &&
      segment.lane === "answer" &&
      !reply.hasMedia &&
      !hasExecApprovalPayload(effectivePayload) &&
      telegramButtons === undefined;
    if (skipTextOnlyBlock || suppressProgressAnswerBlock) {
      turn.activeAnswerBlockDelivery = {
        payload: effectivePayload,
        text: segment.update.text,
        buttons: telegramButtons,
      };
      turn.activeAnswerDraftIsToolProgressOnly = false;
      if (!suppressProgressAnswerBlock) {
        turn.progressCompositor.resetActivity();
      }
      blockDelivered = true;
      continue;
    }

    if (segment.lane === "answer" && info.kind === "block") {
      const prepared = await prepareAnswerLaneForText(turn);
      const shouldRotate = takeQueuedAnswerBlockRotation(
        turn,
        lanePayload,
        info.assistantMessageIndex,
      );
      if (turn.streamMode !== "progress" && shouldRotate && !prepared) {
        await rotateAnswerLaneForNewMessage(turn);
        turn.rotateAnswerLaneWhenQueuedBlocksSettle = false;
      }
      turn.activeAnswerDraftIsToolProgressOnly = false;
      turn.progressCompositor.resetActivity();
    }
    const isAskUserPayload = effectivePayload.channelData?.askUser !== undefined;
    const result =
      segment.lane === "answer" && info.kind === "final"
        ? await deliverFinalAnswerText(
            turn,
            effectivePayload,
            segment.update.text,
            telegramButtons,
            info.onPlatformSendDispatch,
            info.assertPlatformSendAuthorized,
            info.bindPendingFinalDelivery,
          )
        : await turn.deliverLaneText({
            laneName: segment.lane,
            text: segment.update.text,
            payload: lanePayload,
            infoKind: info.kind,
            buttons: telegramButtons,
            ...(isAskUserPayload ? { finalizePreview: true } : {}),
            onPlatformSendDispatch: info.onPlatformSendDispatch,
            assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
            bindPendingFinalDelivery: info.bindPendingFinalDelivery,
          });
    const finalizedPreview =
      segment.lane === "answer" &&
      info.kind !== "final" &&
      (result.kind === "preview-finalized" || result.kind === "preview-finalized-partial");
    if (finalizedPreview) {
      await handlePreviewFinalizedResult(turn, result);
      if (isAskUserPayload && result.kind === "preview-finalized") {
        registerTelegramQuestionDeliveryForMessage(turn, effectivePayload, {
          messageId: result.delivery.messageId,
          text: result.delivery.content,
        });
      }
    }
    if (segment.lane === "answer" && info.kind === "block" && result.kind === "preview-updated") {
      turn.activeAnswerBlockDelivery = {
        payload: lanePayload,
        text: segment.update.text,
        buttons: telegramButtons,
      };
    }
    blockDelivered ||= result.kind !== "skipped";
    if (segment.lane === "reasoning") {
      if (result.kind !== "skipped") {
        turn.reasoningStepState.noteReasoningDelivered();
        if (finalization && turn.bufferedFinalSettlement) {
          turn.bufferedFinalSettlement.visibleReplySent ||= blockDelivered;
        }
        await flushBufferedFinalAnswer(turn, blockDelivered);
      }
    } else if (info.kind === "final") {
      resetReasoningStepState(turn);
    }
  }
  if (segments.length > 0) {
    if (finalization && turn.bufferedFinalSettlement) {
      turn.bufferedFinalSettlement.visibleReplySent ||= blockDelivered;
    }
    trackBlockMedia(turn, blockDelivered, info.kind, effectivePayload);
    return toTelegramReplyDeliveryResult(blockDelivered, finalization);
  }

  if (split.suppressedReasoningOnly) {
    let delivered = false;
    if (info.kind === "final") {
      await stopTelegramReplyLanesAndFlushBufferedFinal(turn);
    }
    if (reply.hasMedia) {
      const payloadWithoutReasoning =
        typeof effectivePayload.text === "string"
          ? { ...effectivePayload, text: "" }
          : effectivePayload;
      delivered = await sendPayload(turn, payloadWithoutReasoning, {
        durable: info.kind === "final",
        onPlatformSendDispatch: info.onPlatformSendDispatch,
        assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
        bindPendingFinalDelivery: info.bindPendingFinalDelivery,
      });
    }
    if (info.kind === "final" && delivered) {
      markFinalDelivered(turn);
    }
    trackBlockMedia(turn, delivered, info.kind, effectivePayload);
    return toTelegramReplyDeliveryResult(delivered);
  }

  if (info.kind === "final") {
    await stopTelegramReplyLanesAndFlushBufferedFinal(turn);
  }
  if (!reply.hasMedia && reply.text.length === 0) {
    if (info.kind === "final") {
      await flushBufferedFinalAnswer(turn);
    }
    return toTelegramReplyDeliveryResult(false);
  }
  const delivered = await sendPayload(turn, effectivePayload, {
    durable: info.kind === "final",
    onPlatformSendDispatch: info.onPlatformSendDispatch,
    assertPlatformSendAuthorized: info.assertPlatformSendAuthorized,
    bindPendingFinalDelivery: info.bindPendingFinalDelivery,
  });
  if (info.kind === "final" && delivered) {
    markFinalDelivered(turn);
  }
  trackBlockMedia(turn, delivered, info.kind, effectivePayload);
  return toTelegramReplyDeliveryResult(delivered);
}

export function handleReplySkip(
  turn: Turn,
  payload: Parameters<Skip>[0],
  info: Parameters<Skip>[1],
): void {
  if (info.kind === "block") {
    void enqueueDraftEvent(turn, async () => {
      dropQueuedAnswerBlockRotation(turn, payload, info.assistantMessageIndex);
    });
  }
  if (payload.isError === true) {
    turn.hadErrorReplyFailureOrSkip = true;
  }
  if (info.reason !== "silent") {
    turn.deliveryState.markNonSilentSkip();
  }
}

export function handleReplyError(
  turn: Turn,
  err: Parameters<ErrorCallback>[0],
  info: Parameters<ErrorCallback>[1],
): void {
  const errorPolicy = resolveTelegramErrorPolicy({
    accountConfig: turn.telegramCfg,
    groupConfig: turn.context.groupConfig,
    topicConfig: turn.context.topicConfig,
  });
  if (isSilentErrorPolicy(errorPolicy.policy)) {
    return;
  }
  if (
    errorPolicy.policy === "once" &&
    shouldSuppressTelegramError({
      scopeKey: buildTelegramErrorScopeKey({
        accountId: turn.context.route.accountId,
        chatId: turn.context.chatId,
        threadSpec: turn.context.threadSpec,
      }),
      cooldownMs: errorPolicy.cooldownMs,
      errorMessage: String(err),
    })
  ) {
    return;
  }
  turn.deliveryState.markNonSilentFailure();
  turn.runtime.error?.(danger(`telegram ${info.kind} reply failed: ${String(err)}`));
}

export function handleBeforeDeliverCancelled(
  turn: Turn,
  payload: Parameters<Cancel>[0],
  info: Parameters<Cancel>[1],
): ReturnType<Cancel> {
  return info.kind === "block"
    ? enqueueDraftEvent(turn, async () => {
        dropQueuedAnswerBlockRotation(turn, payload, info.assistantMessageIndex);
      })
    : undefined;
}
