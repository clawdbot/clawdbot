// Message planning expands normalized payloads into ordered text/media send
// units while preserving reply-to consumption rules.
import {
  chunkByParagraph,
  chunkMarkdownTextWithMode,
  type ChunkMode,
} from "../../auto-reply/chunk.js";
import type { OutboundDeliveryFormattingOptions } from "./formatting.js";
import type { ReplyToOverride } from "./reply-policy.js";

/**
 * Per-send overrides carried from outbound planning into channel delivery.
 */
export type OutboundMessageSendOverrides = ReplyToOverride & {
  threadId?: string | number | null;
  audioAsVoice?: boolean;
  forceDocument?: boolean;
  formatting?: OutboundDeliveryFormattingOptions;
  /** Stable zero-based platform-send index within one durable payload. */
  deliveryPartIndex?: number;
};

/**
 * Planned outbound delivery unit after text chunking or media expansion.
 */
type OutboundMessageUnit =
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

/**
 * Splits outbound text with optional formatting-aware context.
 */
type OutboundMessageChunker = (
  text: string,
  limit: number,
  ctx?: { formatting?: OutboundDeliveryFormattingOptions },
) => string[];

type PlanReplyToConsumption = <T extends OutboundMessageSendOverrides>(overrides: T) => T;

type DurableMediaFanoutContext = {
  channel: string;
  requiredUnknownSendReconciliation?: boolean;
  renderedBatchPlan?: { items: Array<{ mediaUrls: readonly string[] }> };
};

type MediaFanoutSummary = { mediaUrls: readonly unknown[] };

export function assertStableMediaFanout(
  params: DurableMediaFanoutContext,
  payloadIndex: number,
  originalMediaCount: number,
  effective: MediaFanoutSummary,
): void {
  if (!params.requiredUnknownSendReconciliation) {
    return;
  }
  const plannedMediaCount =
    params.renderedBatchPlan?.items[payloadIndex]?.mediaUrls.length ?? originalMediaCount;
  if (plannedMediaCount !== effective.mediaUrls.length) {
    throw new Error(
      `Required durable message send changed platform fan-out after outbound transforms for ${params.channel}`,
    );
  }
}

function withPlannedReplyTo(
  overrides: OutboundMessageSendOverrides,
  consumeReplyTo?: PlanReplyToConsumption,
): OutboundMessageSendOverrides {
  // Reply-to policies can be single-use; clone overrides before consuming the implicit slot.
  return consumeReplyTo ? consumeReplyTo({ ...overrides }) : { ...overrides };
}

function withChunkedTextFormatting(
  overrides: OutboundMessageSendOverrides,
  formatting?: OutboundDeliveryFormattingOptions,
): OutboundMessageSendOverrides {
  return formatting
    ? { ...overrides, formatting: { ...overrides.formatting, ...formatting } }
    : overrides;
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

/**
 * Plans text sends, preserving reply-to policy across chunked delivery units.
 */
export function planOutboundTextMessageUnits(params: {
  text: string;
  overrides: OutboundMessageSendOverrides;
  chunker?: OutboundMessageChunker | null;
  chunkerMode?: "text" | "markdown";
  chunkedTextFormatting?: OutboundDeliveryFormattingOptions;
  textLimit?: number;
  chunkMode?: ChunkMode;
  formatting?: OutboundDeliveryFormattingOptions;
  consumeReplyTo?: PlanReplyToConsumption;
}): OutboundMessageUnit[] {
  const planTextUnit = (text: string, deliveryPartIndex: number): OutboundMessageUnit => ({
    kind: "text",
    text,
    overrides: {
      ...withPlannedReplyTo(params.overrides, params.consumeReplyTo),
      deliveryPartIndex,
    },
  });
  const planChunkedTextUnit = (text: string, deliveryPartIndex: number): OutboundMessageUnit => {
    const unit = planTextUnit(text, deliveryPartIndex);
    return {
      ...unit,
      overrides: withChunkedTextFormatting(unit.overrides, params.chunkedTextFormatting),
    };
  };

  if (!params.chunker || params.textLimit === undefined) {
    return [planTextUnit(params.text, 0)];
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
        units.push(planChunkedTextUnit(chunk, units.length));
      }
    }
    return units;
  }

  return chunkTextForPlan({
    text: params.text,
    limit: params.textLimit,
    chunker: params.chunker,
    formatting: params.formatting,
  }).map(planChunkedTextUnit);
}

/**
 * Plans media sends with a caption only on the leading media unit.
 */
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
    overrides: {
      ...withPlannedReplyTo(params.overrides, params.consumeReplyTo),
      deliveryPartIndex: index,
    },
  }));
}
