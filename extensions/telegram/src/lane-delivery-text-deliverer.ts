// Telegram plugin module implements lane delivery text deliverer behavior.
import {
  createPreviewMessageReceipt,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  isPotentialTruncatedFinal,
  selectLongerFinalText,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  buildTtsSupplementMediaPayload,
  getReplyPayloadTtsSupplement,
  resolveSendableOutboundReplyParts,
} from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";
import type { TelegramPromptContextProjectionSequence } from "./prompt-context-projection.js";

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
  finalized: boolean;
  retainedPromptContextPages: Array<{ messageId: number; text: string }>;
};

type LanePreviewFinalizedDelivery = {
  content: string;
  messageId: number;
  buttonsAttached?: boolean;
  receipt: MessageReceipt;
};

type LanePreviewFinalizedDeliveryInput = Omit<LanePreviewFinalizedDelivery, "receipt"> & {
  receipt?: MessageReceipt;
};

export type LaneDeliveryResult =
  | {
      kind: "preview-finalized";
      delivery: LanePreviewFinalizedDelivery;
    }
  | { kind: "preview-retained" | "preview-updated" | "sent" | "skipped" };

type CreateLaneTextDelivererParams = {
  lanes: Record<LaneName, DraftLaneState>;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  sendPayload: (
    payload: ReplyPayload,
    options?: {
      afterAcceptedDraft?: boolean;
      durable?: boolean;
      promptContextSequence?: TelegramPromptContextProjectionSequence;
      textMode?: "html";
    },
  ) => Promise<boolean>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  clearDraftLane: (lane: DraftLaneState) => Promise<void>;
  editStreamMessage: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    textMode?: "html" | "markdown";
    buttons?: TelegramInlineButtons;
  }) => Promise<void>;
  createPromptContextSequence: () => TelegramPromptContextProjectionSequence;
  resolveFinalTextCandidate?: (params: {
    finalText: string;
    laneName: LaneName;
  }) => Promise<string | undefined> | string | undefined;
  log: (message: string) => void;
  markDelivered: () => void;
};

type DeliverLaneTextParams = {
  laneName: LaneName;
  text: string;
  payload: ReplyPayload;
  infoKind: string;
  buttons?: TelegramInlineButtons;
  finalizePreview?: boolean;
  durable?: boolean;
  allowStream?: boolean;
  promptContextSequence?: TelegramPromptContextProjectionSequence;
};

function result(
  kind: LaneDeliveryResult["kind"],
  delivery?: LanePreviewFinalizedDeliveryInput,
): LaneDeliveryResult {
  if (kind === "preview-finalized") {
    const finalized = delivery!;
    return {
      kind,
      delivery: {
        ...finalized,
        receipt: finalized.receipt ?? createPreviewMessageReceipt({ id: finalized.messageId }),
      },
    };
  }
  return { kind };
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const textOnlyPayload = (payload: ReplyPayload): ReplyPayload => {
    const {
      mediaUrl: _mediaUrl,
      mediaUrls: _mediaUrls,
      audioAsVoice: _audioAsVoice,
      spokenText: _spokenText,
      ...rest
    } = payload;
    return rest;
  };
  const mediaChannelData = (
    channelData: ReplyPayload["channelData"],
    options?: { stripButtons?: boolean },
  ): ReplyPayload["channelData"] => {
    if (!options?.stripButtons) {
      return channelData;
    }
    const telegramData = channelData?.telegram;
    if (!telegramData || typeof telegramData !== "object" || Array.isArray(telegramData)) {
      return channelData;
    }
    const { buttons: _buttons, ...telegramRest } = telegramData as Record<string, unknown>;
    if (_buttons === undefined) {
      return channelData;
    }
    const next: Record<string, unknown> = { ...channelData };
    if (Object.keys(telegramRest).length > 0) {
      next.telegram = telegramRest;
    } else {
      delete next.telegram;
    }
    return Object.keys(next).length > 0 ? next : undefined;
  };
  const withMediaChannelData = (
    payload: ReplyPayload,
    options?: { stripButtons?: boolean },
  ): ReplyPayload => {
    const channelData = mediaChannelData(payload.channelData, options);
    if (channelData === payload.channelData) {
      return payload;
    }
    if (channelData) {
      return { ...payload, channelData };
    }
    const { channelData: _channelData, ...rest } = payload;
    return rest;
  };
  const withFallbackTelegramButtons = (
    payload: ReplyPayload,
    buttons: TelegramInlineButtons | undefined,
  ): ReplyPayload => {
    if (!buttons) {
      return payload;
    }
    const channelData = payload.channelData ?? {};
    const telegramData = channelData.telegram;
    if (
      telegramData &&
      typeof telegramData === "object" &&
      !Array.isArray(telegramData) &&
      "buttons" in telegramData
    ) {
      return payload;
    }
    const telegramRest =
      telegramData && typeof telegramData === "object" && !Array.isArray(telegramData)
        ? (telegramData as Record<string, unknown>)
        : {};
    return {
      ...payload,
      channelData: {
        ...channelData,
        telegram: {
          ...telegramRest,
          buttons,
        },
      },
    };
  };
  const mediaOnlyPayload = (
    payload: ReplyPayload,
    text: string,
    options?: { stripButtons?: boolean; fallbackButtons?: TelegramInlineButtons },
  ): ReplyPayload => {
    if (getReplyPayloadTtsSupplement(payload)) {
      return withFallbackTelegramButtons(
        withMediaChannelData(
          buildTtsSupplementMediaPayload(params.applyTextToPayload(payload, text)),
          options,
        ),
        options?.fallbackButtons,
      );
    }
    if (payload.audioAsVoice === true) {
      const {
        text: _text,
        presentation: _presentation,
        interactive: _interactive,
        btw: _btw,
        spokenText: _spokenText,
        ...voicePayload
      } = params.applyTextToPayload(payload, text);
      return withFallbackTelegramButtons(
        withMediaChannelData({ ...voicePayload, spokenText: text }, options),
        options?.fallbackButtons,
      );
    }
    const {
      text: _text,
      presentation: _presentation,
      interactive: _interactive,
      btw: _btw,
      ...rest
    } = payload;
    return withFallbackTelegramButtons(
      withMediaChannelData(rest, options),
      options?.fallbackButtons,
    );
  };

  const clearUnfinalizedStream = async (lane: DraftLaneState) => {
    if (!lane.stream || lane.finalized) {
      return;
    }
    await params.clearDraftLane(lane);
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
  };

  const discardUnmaterializedStream = async (lane: DraftLaneState) => {
    const stream = lane.stream;
    if (stream) {
      await stream.discard?.();
      stream.forceNewMessage();
    }
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
    lane.finalized = false;
  };

  const rotateFinalizedStream = (lane: DraftLaneState) => {
    if (!lane.stream || !lane.finalized) {
      return;
    }
    lane.stream.forceNewMessage();
    lane.lastPartialText = "";
    lane.hasStreamedMessage = false;
    lane.finalized = false;
  };

  const recordRetainedPromptContextPages = async (
    lane: DraftLaneState,
    sequence: TelegramPromptContextProjectionSequence,
  ): Promise<void> => {
    for (const page of lane.retainedPromptContextPages.splice(0)) {
      await sequence.accept(page);
    }
  };

  const streamText = async (
    laneName: LaneName,
    lane: DraftLaneState,
    text: string,
    payload: ReplyPayload,
    useFinalTextRecovery: boolean,
    finalizePreview: boolean,
    buttons: TelegramInlineButtons | undefined,
    promptContextSequence: TelegramPromptContextProjectionSequence,
    followedByDurablePayload = false,
  ): Promise<LaneDeliveryResult | undefined> => {
    const stream = lane.stream;
    if (!stream || text.length === 0 || payload.isError) {
      return undefined;
    }
    rotateFinalizedStream(lane);

    const finalText = text.trimEnd();
    const candidateTexts = [stream.lastDeliveredText?.(), lane.lastPartialText];
    if (useFinalTextRecovery && isPotentialTruncatedFinal(finalText)) {
      const resolvedFullCandidate = await params.resolveFinalTextCandidate?.({
        finalText: text,
        laneName,
      });
      if (resolvedFullCandidate) {
        candidateTexts.push(resolvedFullCandidate);
      }
    }
    const previewText =
      useFinalTextRecovery && isPotentialTruncatedFinal(finalText)
        ? (selectLongerFinalText({ finalText, candidateTexts }) ?? finalText)
        : finalText;
    lane.lastPartialText = previewText;
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    if (stream.lastDeliveredText?.() !== previewText) {
      stream.update(previewText);
    }
    if (finalizePreview) {
      await params.stopDraftLane(lane);
    } else {
      await params.flushDraftLane(lane);
    }
    const messageId = stream.messageId();
    if (typeof messageId !== "number") {
      if (finalizePreview && stream.sendMayHaveLanded?.()) {
        await recordRetainedPromptContextPages(lane, promptContextSequence);
        await promptContextSequence.fail();
        lane.finalized = true;
        params.markDelivered();
        return result("preview-retained");
      }
      if (!finalizePreview) {
        await discardUnmaterializedStream(lane);
      }
      return undefined;
    }
    if (finalizePreview && stream.lastDeliveredText?.() !== previewText) {
      // Retained pagination pages stay concrete while normal delivery resumes
      // the suffix, so their shared projection sequence remains valid.
      if (
        !lane.retainedPromptContextPages.length ||
        !stream.remainingFinalContent?.()?.text.trimEnd()
      ) {
        promptContextSequence.invalidate();
      }
      return undefined;
    }

    params.markDelivered();
    const activeSnapshot =
      finalizePreview || buttons ? stream.currentMessageSnapshot?.() : undefined;
    let buttonsAttached = false;
    if (buttons && activeSnapshot) {
      try {
        await params.editStreamMessage({
          laneName,
          messageId,
          text: activeSnapshot.sourceText,
          ...(activeSnapshot.sourceTextMode ? { textMode: activeSnapshot.sourceTextMode } : {}),
          buttons,
        });
        buttonsAttached = true;
      } catch (err) {
        params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
      }
    }
    if (!finalizePreview) {
      return result("preview-updated");
    }
    if (!activeSnapshot) {
      promptContextSequence.invalidate();
      return undefined;
    }
    lane.finalized = true;
    await recordRetainedPromptContextPages(lane, promptContextSequence);
    await promptContextSequence.accept({ messageId, text: activeSnapshot.text });
    if (!followedByDurablePayload) {
      await promptContextSequence.finish();
    }
    return result("preview-finalized", {
      content: previewText,
      messageId,
      buttonsAttached,
    });
  };

  return async ({
    laneName,
    text,
    payload,
    infoKind,
    buttons,
    finalizePreview: requestedFinalizePreview,
    durable: requestedDurable,
    allowStream = true,
    promptContextSequence: suppliedPromptContextSequence,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    const lane = params.lanes[laneName];
    const promptContextSequence =
      suppliedPromptContextSequence ?? params.createPromptContextSequence();
    const reply = resolveSendableOutboundReplyParts(payload, { text });
    const isDurableFinal = infoKind === "final";
    const finalizePreview = requestedFinalizePreview ?? isDurableFinal;
    const durable = requestedDurable ?? isDurableFinal;
    const streamed =
      allowStream && !reply.hasMedia
        ? await streamText(
            laneName,
            lane,
            text,
            payload,
            isDurableFinal,
            finalizePreview,
            buttons,
            promptContextSequence,
          )
        : undefined;
    if (streamed) {
      return streamed;
    }

    if (
      finalizePreview &&
      reply.hasMedia &&
      lane.stream &&
      lane.hasStreamedMessage &&
      !lane.finalized &&
      text.trim().length > 0
    ) {
      const finalizedPreview = await streamText(
        laneName,
        lane,
        text,
        textOnlyPayload(payload),
        isDurableFinal,
        true,
        buttons,
        promptContextSequence,
        true,
      );
      if (finalizedPreview) {
        const stripButtons =
          finalizedPreview.kind === "preview-finalized" &&
          finalizedPreview.delivery.buttonsAttached === true;
        const mediaText =
          finalizedPreview.kind === "preview-finalized" ? finalizedPreview.delivery.content : text;
        await params.sendPayload(
          mediaOnlyPayload(payload, mediaText, {
            stripButtons,
            fallbackButtons: stripButtons ? undefined : buttons,
          }),
          {
            afterAcceptedDraft: true,
            durable,
            promptContextSequence,
          },
        );
        return finalizedPreview;
      }
    }

    const retainedFinalContent =
      finalizePreview && lane.retainedPromptContextPages.length > 0
        ? lane.stream?.remainingFinalContent?.()
        : undefined;
    const afterAcceptedDraft =
      retainedFinalContent !== undefined || lane.stream?.hasConsumedReplyTarget?.() === true;

    if (finalizePreview) {
      await recordRetainedPromptContextPages(lane, promptContextSequence);
      await clearUnfinalizedStream(lane);
    }

    // Accepted pagination pages remain visible. If bounded final retries exhaust,
    // deliver only the unaccepted suffix so fallback cannot duplicate the prefix.
    const delivered = await params.sendPayload(
      params.applyTextToPayload(payload, retainedFinalContent?.sourceText ?? text),
      {
        afterAcceptedDraft,
        durable,
        promptContextSequence,
        ...(retainedFinalContent?.sourceTextMode === "html" ? { textMode: "html" } : {}),
      },
    );
    if (delivered && finalizePreview) {
      lane.finalized = true;
    }
    return delivered ? result("sent") : result("skipped");
  };
}
