import {
  createPreviewMessageReceipt,
  type MessageReceipt,
} from "openclaw/plugin-sdk/channel-message";
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

function stripTrailingEllipsis(text: string): string {
  return text.replace(/(?:\s*(?:\.{3}|\u2026))+$/u, "").trimEnd();
}

const MIN_TRUNCATED_FINAL_PREFIX_CHARS = 48;
const MIN_TRUNCATED_FINAL_CONTINUATION_CHARS = 24;

function isPotentialTruncatedFinal(finalText: string): boolean {
  const trimmedFinal = finalText.trimEnd();
  const untruncatedFinal = stripTrailingEllipsis(trimmedFinal);
  return (
    untruncatedFinal.length >= MIN_TRUNCATED_FINAL_PREFIX_CHARS && untruncatedFinal !== trimmedFinal
  );
}

function selectLongerPreviewForFinal(params: {
  finalText: string;
  candidateTexts: readonly (string | undefined)[];
}): string | undefined {
  const finalText = params.finalText.trimEnd();
  const untruncatedFinal = stripTrailingEllipsis(finalText);
  if (
    untruncatedFinal.length < MIN_TRUNCATED_FINAL_PREFIX_CHARS ||
    untruncatedFinal === finalText
  ) {
    return undefined;
  }
  for (const candidate of params.candidateTexts) {
    const candidateText = candidate?.trimEnd();
    if (
      !candidateText ||
      candidateText.length <= finalText.length ||
      !candidateText.startsWith(untruncatedFinal)
    ) {
      continue;
    }
    const continuation = candidateText.slice(untruncatedFinal.length).trimStart();
    if (
      continuation.length >= MIN_TRUNCATED_FINAL_CONTINUATION_CHARS &&
      /^[\p{L}\p{N}]/u.test(continuation)
    ) {
      return candidateText;
    }
  }
  return undefined;
}

export function createLaneTextDeliverer(params: CreateLaneTextDelivererParams) {
  const followUpPayload = (payload: ReplyPayload, text: string) =>
    params.applyTextToFollowUpPayload
      ? params.applyTextToFollowUpPayload(payload, text)
      : params.applyTextToPayload(payload, text);

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
        ? selectLongerPreviewForFinal({
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
      if (buttons) {
        try {
          await params.editStreamMessage({ laneName, messageId, text: previewText, buttons });
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
      return result("preview-finalized", { content: previewText, messageId });
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
    if (buttons) {
      try {
        await params.editStreamMessage({ laneName, messageId, text: firstChunk, buttons });
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
      return result("preview-finalized", { content: text, messageId });
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
