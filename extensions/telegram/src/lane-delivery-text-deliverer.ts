import {
  createPreviewMessageReceipt,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-message";
import {
  isPotentialTruncatedFinal,
  selectLongerFinalText,
} from "openclaw/plugin-sdk/channel-streaming";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import type { TelegramInlineButtons } from "./button-types.js";
import type { TelegramDraftStream } from "./draft-stream.js";

export type LaneName = "answer" | "reasoning";

export type DraftLaneState = {
  stream: TelegramDraftStream | undefined;
  lastPartialText: string;
  hasStreamedMessage: boolean;
  finalized: boolean;
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
  draftMaxChars: number;
  applyTextToPayload: (payload: ReplyPayload, text: string) => ReplyPayload;
  applyTextToFollowUpPayload?: (payload: ReplyPayload, text: string) => ReplyPayload;
  splitFinalTextForStream?: (text: string) => readonly string[];
  sendPayload: (
    payload: ReplyPayload,
    options?: { durable?: boolean; silent?: boolean },
  ) => Promise<boolean>;
  flushDraftLane: (lane: DraftLaneState) => Promise<void>;
  stopDraftLane: (lane: DraftLaneState) => Promise<void>;
  clearDraftLane: (lane: DraftLaneState) => Promise<void>;
  editStreamMessage: (params: {
    laneName: LaneName;
    messageId: number;
    text: string;
    buttons?: TelegramInlineButtons;
  }) => Promise<void>;
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

function compactChunks(chunks: readonly string[]): string[] {
  const out: string[] = [];
  let whitespace = "";
  for (const chunk of chunks) {
    if (!chunk) {
      continue;
    }
    if (chunk.trim().length === 0) {
      whitespace += chunk;
      continue;
    }
    out.push(`${whitespace}${chunk}`);
    whitespace = "";
  }
  if (whitespace && out.length > 0) {
    out[out.length - 1] = `${out[out.length - 1]}${whitespace}`;
  }
  return out;
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const followUpPayload = (payload: ReplyPayload, text: string) =>
    params.applyTextToFollowUpPayload
      ? params.applyTextToFollowUpPayload(payload, text)
      : params.applyTextToPayload(payload, text);
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
    buttons?: TelegramInlineButtons,
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

  const streamText = async (
    laneName: LaneName,
    lane: DraftLaneState,
    text: string,
    payload: ReplyPayload,
    isFinal: boolean,
    buttons?: TelegramInlineButtons,
  ): Promise<LaneDeliveryResult | undefined> => {
    const stream = lane.stream;
    if (!stream || text.length === 0 || payload.isError) {
      return undefined;
    }

    const chunks =
      text.length > params.draftMaxChars
        ? compactChunks(params.splitFinalTextForStream?.(text) ?? [])
        : [text];
    const [firstChunk, ...remainingChunks] = chunks;
    if (!firstChunk || firstChunk.length > params.draftMaxChars) {
      return undefined;
    }

    const retainedPreview =
      isFinal && remainingChunks.length === 0 && isPotentialTruncatedFinal(text)
        ? selectLongerFinalText({
            finalText: text,
            candidateTexts: [
              await params.resolveFinalTextCandidate?.({ finalText: text, laneName }),
              stream.lastDeliveredText?.(),
              lane.lastPartialText,
            ],
          })
        : undefined;
    if (retainedPreview && (!buttons || retainedPreview.length <= params.draftMaxChars)) {
      const previewText = retainedPreview;
      lane.lastPartialText = previewText;
      lane.hasStreamedMessage = true;
      await params.stopDraftLane(lane);
      const messageId = stream.messageId();
      if (typeof messageId !== "number") {
        if (stream.sendMayHaveLanded?.()) {
          lane.finalized = true;
          params.markDelivered();
          return result("preview-retained");
        }
        return undefined;
      }
      const deliveredStreamText = stream.lastDeliveredText?.();
      if (deliveredStreamText !== undefined && deliveredStreamText !== previewText) {
        return undefined;
      }
      let buttonsAttached = false;
      if (buttons) {
        try {
          await params.editStreamMessage({ laneName, messageId, text: previewText, buttons });
          buttonsAttached = true;
        } catch (err) {
          params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
        }
      }
      for (const chunk of remainingChunks) {
        if (chunk.trim().length === 0) {
          continue;
        }
        await params.sendPayload(followUpPayload(payload, chunk));
      }
      lane.finalized = true;
      params.markDelivered();
      return result("preview-finalized", { content: previewText, messageId, buttonsAttached });
    }

    lane.lastPartialText = firstChunk;
    lane.hasStreamedMessage = true;
    lane.finalized = false;
    stream.update(firstChunk);
    if (isFinal) {
      await params.stopDraftLane(lane);
    } else {
      await params.flushDraftLane(lane);
    }

    const messageId = stream.messageId();
    if (typeof messageId !== "number") {
      if (isFinal && stream.sendMayHaveLanded?.()) {
        lane.finalized = true;
        params.markDelivered();
        return result("preview-retained");
      }
      return undefined;
    }

    const deliveredStreamText = stream.lastDeliveredText?.();
    if (
      isFinal &&
      deliveredStreamText !== undefined &&
      deliveredStreamText !== firstChunk.trimEnd()
    ) {
      return undefined;
    }

    params.markDelivered();
    let buttonsAttached = false;
    if (buttons) {
      try {
        await params.editStreamMessage({ laneName, messageId, text: firstChunk, buttons });
        buttonsAttached = true;
      } catch (err) {
        params.log(`telegram: ${laneName} stream button edit failed: ${String(err)}`);
      }
    }

    if (isFinal) {
      lane.finalized = true;
      for (const chunk of remainingChunks) {
        if (chunk.trim().length === 0) {
          continue;
        }
        await params.sendPayload(followUpPayload(payload, chunk));
      }
      return result("preview-finalized", { content: text, messageId, buttonsAttached });
    }

    return result("preview-updated");
  };

  return async ({
    laneName,
    text,
    payload,
    infoKind,
    buttons,
  }: DeliverLaneTextParams): Promise<LaneDeliveryResult> => {
    const lane = params.lanes[laneName];
    const reply = resolveSendableOutboundReplyParts(payload, { text });
    const isFinal = infoKind === "final";
    const streamed = !reply.hasMedia
      ? await streamText(laneName, lane, text, payload, isFinal, buttons)
      : undefined;
    if (streamed) {
      return streamed;
    }

    if (
      isFinal &&
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
        true,
        buttons,
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
            durable: true,
          },
        );
        return finalizedPreview;
      }
    }

    if (isFinal) {
      await clearUnfinalizedStream(lane);
    }

    const delivered = await params.sendPayload(params.applyTextToPayload(payload, text), {
      durable: isFinal,
    });
    if (delivered && isFinal) {
      lane.finalized = true;
    }
    return delivered ? result("sent") : result("skipped");
  };
}
