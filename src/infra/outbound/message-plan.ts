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
  /** Exact platform-send count for this payload. */
  deliveryPartCount?: number;
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

function chunkTextForPlan(params: {
  text: string;
  limit: number;
  chunker: OutboundMessageChunker;
  formatting?: OutboundDeliveryFormattingOptions;
}): string[] {
  const chunks = params.formatting
    ? params.chunker(params.text, params.limit, { formatting: params.formatting })
    : params.chunker(params.text, params.limit);
  return chunks.length === 0 && params.text ? [params.text] : chunks;
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
  const planTextUnit = (
    text: string,
    deliveryPartIndex: number,
    chunkedTextFormatting?: OutboundDeliveryFormattingOptions,
  ): OutboundMessageUnit => {
    const overrides = {
      ...withPlannedReplyTo(params.overrides, params.consumeReplyTo),
      deliveryPartIndex,
    };
    return {
      kind: "text",
      text,
      overrides: chunkedTextFormatting
        ? { ...overrides, formatting: { ...overrides.formatting, ...chunkedTextFormatting } }
        : overrides,
    };
  };

  const withDeliveryTopology = (units: OutboundMessageUnit[]): OutboundMessageUnit[] => {
    const deliveryPartCount = units.length;
    // These units are planner-owned until return; finalize them in place rather
    // than cloning every chunk solely to attach the shared fan-out count.
    for (const unit of units) {
      unit.overrides.deliveryPartCount = deliveryPartCount;
    }
    return units;
  };

  if (!params.chunker || params.textLimit === undefined) {
    return withDeliveryTopology([planTextUnit(params.text, 0)]);
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
      for (const chunk of chunks) {
        units.push(planTextUnit(chunk, units.length, params.chunkedTextFormatting));
      }
    }
    return withDeliveryTopology(units);
  }

  return withDeliveryTopology(
    chunkTextForPlan({
      text: params.text,
      limit: params.textLimit,
      chunker: params.chunker,
      formatting: params.formatting,
    }).map((chunk, index) => planTextUnit(chunk, index, params.chunkedTextFormatting)),
  );
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
  const deliveryPartCount = params.mediaUrls.length;
  return params.mediaUrls.map((mediaUrl, index) => ({
    kind: "media" as const,
    mediaUrl,
    ...(index === 0 ? { caption: params.caption } : {}),
    overrides: {
      ...withPlannedReplyTo(params.overrides, params.consumeReplyTo),
      deliveryPartIndex: index,
      deliveryPartCount,
    },
  }));
}
