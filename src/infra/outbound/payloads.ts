// Outbound payload planning normalizes reply payloads into sendable text,
// media, presentation, interactive, and mirror projections.
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import { stripLeadingInboundMetadata } from "../../auto-reply/reply/strip-inbound-meta.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { formatLocationText } from "../../channels/location.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasLegacyInteractiveReplyBlocks,
  hasMessagePresentationBlocks,
  hasReplyChannelData,
  hasReplyPayloadContent,
  normalizeLegacyInteractiveReply,
  normalizeMessagePresentation,
  renderMessagePresentationChartFallbackText,
  renderMessagePresentationTableFallbackText,
  type LegacyInteractiveReply,
  type MessagePresentation,
  type ReplyPayloadDelivery,
} from "../../interactive/payload.js";
import type { SilentReplyConversationType } from "../../shared/silent-reply-policy.js";
import { stripUnsupportedCitationControlMarkers } from "../../shared/text/citation-control-markers.js";

/** Runtime-ready outbound payload after text/media/rich-content normalization. */
export type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
  audioAsVoice?: boolean;
  presentation?: MessagePresentation;
  presentationTextMode?: ReplyPayload["presentationTextMode"];
  delivery?: ReplyPayloadDelivery;
  interactive?: LegacyInteractiveReply;
  channelData?: Record<string, unknown>;
  location?: ReplyPayload["location"];
  /** Hook-only content for audio-only TTS payloads. Never used as channel text/caption. */
  hookContent?: string;
};

/** JSON-safe outbound payload projection used for envelopes and diagnostics. */
export type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  presentation?: MessagePresentation;
  presentationTextMode?: ReplyPayload["presentationTextMode"];
  delivery?: ReplyPayloadDelivery;
  interactive?: LegacyInteractiveReply;
  channelData?: Record<string, unknown>;
  location?: ReplyPayload["location"];
};

/** Prepared payload entry that keeps source indexing plus reusable projections. */
export type OutboundPayloadPlan = {
  sourceIndex: number;
  payload: ReplyPayload;
  parts: ReturnType<typeof resolveSendableOutboundReplyParts>;
  hasPresentation: boolean;
  hasInteractive: boolean;
  hasChannelData: boolean;
};

type OutboundPayloadPlanContext = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
  extractMarkdownImages?: boolean;
};

/** Text/media projection used to mirror outbound replies into session state. */
type OutboundPayloadMirror = {
  text: string;
  mediaUrls: string[];
};

type MirrorTextBlock =
  | MessagePresentation["blocks"][number]
  | LegacyInteractiveReply["blocks"][number];

function collectBlockMirrorText(
  blocks: readonly MirrorTextBlock[],
  options: { includeContext?: boolean } = {},
): string[] {
  const lines: string[] = [];
  for (const block of blocks) {
    if (
      (block.type === "text" || (options.includeContext === true && block.type === "context")) &&
      block.text.trim()
    ) {
      lines.push(block.text.trim());
      continue;
    }
    if (block.type === "buttons") {
      for (const button of block.buttons) {
        if (button.label.trim()) {
          lines.push(button.label.trim());
        }
      }
      continue;
    }
    if (block.type === "chart") {
      lines.push(renderMessagePresentationChartFallbackText(block));
      continue;
    }
    if (block.type === "table") {
      lines.push(renderMessagePresentationTableFallbackText(block));
      continue;
    }
    if (block.type === "select") {
      if (block.placeholder?.trim()) {
        lines.push(block.placeholder.trim());
      }
      for (const option of block.options) {
        if (option.label.trim()) {
          lines.push(option.label.trim());
        }
      }
    }
  }
  return lines;
}

function collectPresentationMirrorText(presentation: MessagePresentation | undefined): string[] {
  if (!presentation) {
    return [];
  }
  const lines: string[] = [];
  if (presentation.title?.trim()) {
    lines.push(presentation.title.trim());
  }
  lines.push(...collectBlockMirrorText(presentation.blocks, { includeContext: true }));
  return lines;
}

/** Renders user-visible payload content safely for every outbound transcript mirror. */
export function resolveOutboundPayloadMirrorText(payload: ReplyPayload): string {
  const text = payload.text?.trim()
    ? payload.text
    : payload.location && formatLocationText(payload.location);
  const presentation = normalizeMessagePresentation(payload.presentation);
  if (text?.trim()) {
    const structuredDataText = presentation
      ? collectBlockMirrorText(
          presentation.blocks.filter((block) => block.type === "chart" || block.type === "table"),
        )
      : [];
    return [text, ...structuredDataText].join("\n");
  }
  const interactive = normalizeLegacyInteractiveReply(payload.interactive);
  return [
    ...collectPresentationMirrorText(presentation),
    ...collectBlockMirrorText(interactive?.blocks ?? []),
  ].join("\n");
}

function isSuppressedRelayStatusText(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return false;
  }
  if (/^no channel reply\.?$/i.test(normalized)) {
    return true;
  }
  if (/^replied in-thread\.?$/i.test(normalized)) {
    return true;
  }
  if (/^replied in #[-\w]+\.?$/i.test(normalized)) {
    return true;
  }
  // Prevent relay housekeeping text from leaking into user-visible channels.
  if (
    /^updated\s+\[[^\]]*wiki\/[^\]]+\](?:\([^)]+\))?(?:\s+with\b[\s\S]*)?(?:\.\s*)?(?:no channel reply\.?)?$/i.test(
      normalized,
    )
  ) {
    return true;
  }
  return false;
}

function mergeMediaUrls(...lists: Array<ReadonlyArray<string | undefined> | undefined>): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const list of lists) {
    if (!list) {
      continue;
    }
    for (const entry of list) {
      const trimmed = entry?.trim();
      if (!trimmed) {
        continue;
      }
      if (seen.has(trimmed)) {
        continue;
      }
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }
  return merged;
}

function createOutboundPayloadPlanEntry(
  payload: ReplyPayload,
  context: Pick<OutboundPayloadPlanContext, "extractMarkdownImages"> = {},
): Omit<OutboundPayloadPlan, "sourceIndex"> | null {
  if (shouldSuppressReasoningPayload(payload)) {
    return null;
  }
  const parsed = parseReplyDirectives(stripLeadingInboundMetadata(payload.text ?? ""), {
    extractMarkdownImages: context.extractMarkdownImages,
  });
  const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
  const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrls?.[0];
  const mergedMedia = mergeMediaUrls(
    explicitMediaUrls,
    explicitMediaUrl ? [explicitMediaUrl] : undefined,
    parsed.mediaUrls,
  );
  const strippedText = stripUnsupportedCitationControlMarkers(parsed.text ?? "");
  const strippedParsed =
    strippedText === (parsed.text ?? "") ? parsed : parseReplyDirectives(strippedText);
  const parsedText = strippedParsed.text ?? "";
  const suppressedText = strippedParsed.isSilent || isSuppressedRelayStatusText(parsedText);
  const resolvedMediaUrl = mergedMedia.length > 1 ? undefined : explicitMediaUrl;
  const normalizedPayload: ReplyPayload = {
    ...payload,
    text:
      formatBtwTextForExternalDelivery({
        ...payload,
        text: suppressedText ? "" : parsedText,
      }) ?? "",
    mediaUrls: mergedMedia.length ? mergedMedia : undefined,
    mediaUrl: resolvedMediaUrl,
    replyToId: payload.replyToId ?? parsed.replyToId,
    replyToTag: payload.replyToTag || parsed.replyToTag,
    replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
    audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
  };
  const hasRenderableContent = suppressedText
    ? hasReplyPayloadContent(normalizedPayload)
    : isRenderablePayload(normalizedPayload);
  if (!hasRenderableContent) {
    return null;
  }
  const hasChannelData = hasReplyChannelData(normalizedPayload.channelData);
  return {
    payload: normalizedPayload,
    parts: resolveSendableOutboundReplyParts(normalizedPayload),
    hasPresentation: hasMessagePresentationBlocks(normalizedPayload.presentation),
    hasInteractive: hasLegacyInteractiveReplyBlocks(normalizedPayload.interactive),
    hasChannelData,
  };
}

/** Builds the canonical outbound payload plan shared by delivery projections. */
export function createOutboundPayloadPlan(
  payloads: readonly ReplyPayload[],
  context: OutboundPayloadPlanContext = {},
): OutboundPayloadPlan[] {
  // Intentionally scoped to channel-agnostic normalization and projection inputs.
  // Transport concerns (queueing, hooks, retries), channel transforms, and
  // heartbeat-specific token semantics remain outside this plan boundary.
  const plan: OutboundPayloadPlan[] = [];
  for (const [sourceIndex, payload] of payloads.entries()) {
    const entry = createOutboundPayloadPlanEntry(payload, {
      extractMarkdownImages: context.extractMarkdownImages,
    });
    if (!entry) {
      continue;
    }
    plan.push({ sourceIndex, ...entry });
  }
  return plan;
}

/** Projects a payload plan back to normalized reply payloads for delivery. */
export function projectOutboundPayloadPlanForDelivery(
  plan: readonly OutboundPayloadPlan[],
): ReplyPayload[] {
  return plan.map((entry) => entry.payload);
}

/** Projects a payload plan into runtime transport payload summaries. */
export function projectOutboundPayloadPlanForOutbound(
  plan: readonly OutboundPayloadPlan[],
): NormalizedOutboundPayload[] {
  const normalizedPayloads: NormalizedOutboundPayload[] = [];
  for (const entry of plan) {
    const payload = entry.payload;
    const text = entry.parts.text;
    if (
      !hasReplyPayloadContent(
        { ...payload, text, mediaUrls: entry.parts.mediaUrls },
        {
          hasChannelData: entry.hasChannelData,
          extraContent: payload.location != null,
        },
      )
    ) {
      continue;
    }
    normalizedPayloads.push({
      text,
      mediaUrls: entry.parts.mediaUrls,
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      ...(entry.hasPresentation ? { presentation: payload.presentation } : {}),
      ...(entry.hasPresentation && payload.presentationTextMode
        ? { presentationTextMode: payload.presentationTextMode }
        : {}),
      ...(payload.delivery ? { delivery: payload.delivery } : {}),
      ...(entry.hasInteractive ? { interactive: payload.interactive } : {}),
      ...(entry.hasChannelData ? { channelData: payload.channelData } : {}),
      ...(payload.location ? { location: payload.location } : {}),
    });
  }
  return normalizedPayloads;
}

/** Projects a payload plan into JSON-safe envelope/debug payloads. */
export function projectOutboundPayloadPlanForJson(
  plan: readonly OutboundPayloadPlan[],
): OutboundPayloadJson[] {
  const normalized: OutboundPayloadJson[] = [];
  for (const entry of plan) {
    const payload = entry.payload;
    normalized.push({
      text: entry.parts.text,
      mediaUrl: payload.mediaUrl ?? null,
      mediaUrls: entry.parts.mediaUrls.length ? entry.parts.mediaUrls : undefined,
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      presentation: payload.presentation,
      ...(payload.presentationTextMode
        ? { presentationTextMode: payload.presentationTextMode }
        : {}),
      delivery: payload.delivery,
      interactive: payload.interactive,
      channelData: payload.channelData,
      ...(payload.location ? { location: payload.location } : {}),
    });
  }
  return normalized;
}

/** Projects a payload plan into text/media content for session mirroring. */
export function projectOutboundPayloadPlanForMirror(
  plan: readonly OutboundPayloadPlan[],
): OutboundPayloadMirror {
  return {
    text: plan
      .map(({ payload }) => resolveOutboundPayloadMirrorText(payload))
      .filter((text): text is string => Boolean(text))
      .join("\n"),
    mediaUrls: plan.flatMap((entry) => entry.parts.mediaUrls),
  };
}

/** Summarizes one reply payload for channel transport and hook processing. */
export function summarizeOutboundPayloadForTransport(
  payload: ReplyPayload,
): NormalizedOutboundPayload {
  const parts = resolveSendableOutboundReplyParts(payload);
  const text = stripUnsupportedCitationControlMarkers(parts.text);
  const strippedSpokenText =
    typeof payload.spokenText === "string"
      ? stripUnsupportedCitationControlMarkers(payload.spokenText)
      : undefined;
  const spokenText = strippedSpokenText?.trim() ? strippedSpokenText : undefined;
  return {
    text,
    mediaUrls: parts.mediaUrls,
    audioAsVoice: payload.audioAsVoice === true ? true : undefined,
    presentation: payload.presentation,
    ...(payload.presentationTextMode ? { presentationTextMode: payload.presentationTextMode } : {}),
    delivery: payload.delivery,
    interactive: payload.interactive,
    channelData: payload.channelData,
    ...(payload.location ? { location: payload.location } : {}),
    ...(text || !spokenText ? {} : { hookContent: spokenText }),
  };
}

/** Normalizes reply payloads for direct delivery using the shared plan. */
export function normalizeReplyPayloadsForDelivery(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan(payloads));
}

/** Normalizes reply payloads into JSON-safe outbound envelope payloads. */
export function normalizeOutboundPayloadsForJson(
  payloads: readonly ReplyPayload[],
): OutboundPayloadJson[] {
  return projectOutboundPayloadPlanForJson(createOutboundPayloadPlan(payloads));
}

/** Formats normalized outbound payload text and attachments for logs. */
export function formatOutboundPayloadLog(
  payload: Pick<NormalizedOutboundPayload, "text" | "channelData"> & {
    mediaUrls: readonly string[];
  },
): string {
  const lines: string[] = [];
  if (payload.text) {
    lines.push(payload.text.trimEnd());
  }
  for (const url of payload.mediaUrls) {
    lines.push(`Attachment: ${url}`);
  }
  return lines.join("\n");
}
