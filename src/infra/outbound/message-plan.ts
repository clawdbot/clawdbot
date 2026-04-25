import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  type ChunkMode,
} from "../../auto-reply/chunk.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { ReplyToOverride } from "./reply-policy.js";

export type OutboundMessageSendOverrides = ReplyToOverride & {
  threadId?: string | number | null;
  audioAsVoice?: boolean;
  forceDocument?: boolean;
};

export type OutboundMessageUnit =
  | {
      kind: "text";
      text: string;
      overrides: OutboundMessageSendOverrides;
    }
  | {
      kind: "media";
      caption?: string;
      mediaUrl: string;
      overrides: OutboundMessageSendOverrides;
    };

export type OutboundMessageChunker = (
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
) => string[];

type PlanReplyToConsumption = <T extends OutboundMessageSendOverrides>(overrides: T) => T;

function withPlannedReplyTo(
  overrides: OutboundMessageSendOverrides,
  consumeReplyTo?: PlanReplyToConsumption,
): OutboundMessageSendOverrides {
  return consumeReplyTo ? consumeReplyTo({ ...overrides }) : { ...overrides };
}

function chunkTextForPlan(params: {
  text: string;
  limit: number;
  chunker: OutboundMessageChunker;
  formatting?: OutboundDeliveryFormattingOptions;
}): string[] {
  return params.formatting
    ? params.chunker(params.text, params.limit, { formatting: params.formatting })
    : params.chunker(params.text, params.limit);
}

export function planOutboundTextMessageUnits(params: {
  text: string;
  overrides: OutboundMessageSendOverrides;
  chunker?: OutboundMessageChunker | null;
  chunkerMode?: "text" | "markdown";
  textLimit?: number;
  chunkMode?: ChunkMode;
  formatting?: OutboundDeliveryFormattingOptions;
  consumeReplyTo?: PlanReplyToConsumption;
}): OutboundMessageUnit[] {
  const planTextUnit = (text: string): OutboundMessageUnit => ({
    kind: "text",
    text,
    overrides: withPlannedReplyTo(params.overrides, params.consumeReplyTo),
  });

  if (!params.chunker || params.textLimit === undefined) {
    return [planTextUnit(params.text)];
  }

  if (params.chunkMode === "newline") {
    const blockChunks =
      (params.chunkerMode ?? "text") === "markdown"
        ? chunkMarkdownTextWithMode(params.text, params.textLimit, "newline")
        : chunkByParagraph(params.text, params.textLimit);

    if (!blockChunks.length && params.text) {
      blockChunks.push(params.text);
    }

    const units: OutboundMessageUnit[] = [];
    for (const blockChunk of blockChunks) {
      const chunks = chunkTextForPlan({
        text: blockChunk,
        limit: params.textLimit,
        chunker: params.chunker,
        formatting: params.formatting,
      });
      if (!chunks.length && blockChunk) {
        chunks.push(blockChunk);
      }
      for (const chunk of chunks) {
        units.push(planTextUnit(chunk));
      }
    }
    return units;
  }

  return chunkTextForPlan({
    text: params.text,
    limit: params.textLimit,
    chunker: params.chunker,
    formatting: params.formatting,
  }).map(planTextUnit);
}

export function planOutboundMediaMessageUnits(params: {
  caption: string;
  mediaUrls: readonly string[];
  overrides: OutboundMessageSendOverrides;
  consumeReplyTo?: PlanReplyToConsumption;
}): OutboundMessageUnit[] {
  return params.mediaUrls.map((mediaUrl, index) => ({
    kind: "media" as const,
    mediaUrl,
    ...(index === 0 ? { caption: params.caption } : {}),
    overrides: withPlannedReplyTo(params.overrides, params.consumeReplyTo),
  }));
}
