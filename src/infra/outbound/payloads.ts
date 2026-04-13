import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import {
  hasInteractiveReplyBlocks,
  hasReplyChannelData,
  hasReplyPayloadContent,
  type InteractiveReply,
} from "../../interactive/payload.js";

export type NormalizedOutboundPayload = {
  text: string;
  mediaUrls: string[];
  audioAsVoice?: boolean;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};

export type OutboundPayloadJson = {
  text: string;
  mediaUrl: string | null;
  mediaUrls?: string[];
  audioAsVoice?: boolean;
  interactive?: InteractiveReply;
  channelData?: Record<string, unknown>;
};

export type OutboundPayloadPlan = {
  payload: ReplyPayload;
  parts: ReturnType<typeof resolveSendableOutboundReplyParts>;
  hasInteractive: boolean;
  hasChannelData: boolean;
};

export type OutboundPayloadMirror = {
  text: string;
  mediaUrls: string[];
};

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

function createOutboundPayloadPlanEntry(payload: ReplyPayload): OutboundPayloadPlan | null {
  if (shouldSuppressReasoningPayload(payload)) {
    return null;
  }
  const parsed = parseReplyDirectives(payload.text ?? "");
  const explicitMediaUrls = payload.mediaUrls ?? parsed.mediaUrls;
  const explicitMediaUrl = payload.mediaUrl ?? parsed.mediaUrl;
  const mergedMedia = mergeMediaUrls(
    explicitMediaUrls,
    explicitMediaUrl ? [explicitMediaUrl] : undefined,
  );
  if (parsed.isSilent && mergedMedia.length === 0) {
    return null;
  }
  const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
  const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
  const normalizedPayload: ReplyPayload = {
    ...payload,
    text:
      formatBtwTextForExternalDelivery({
        ...payload,
        text: parsed.text ?? "",
      }) ?? "",
    mediaUrls: mergedMedia.length ? mergedMedia : undefined,
    mediaUrl: resolvedMediaUrl,
    replyToId: payload.replyToId ?? parsed.replyToId,
    replyToTag: payload.replyToTag || parsed.replyToTag,
    replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
    audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
  };
  if (!isRenderablePayload(normalizedPayload)) {
    return null;
  }
  const parts = resolveSendableOutboundReplyParts(normalizedPayload);
  const hasChannelData = hasReplyChannelData(normalizedPayload.channelData);
  return {
    payload: normalizedPayload,
    parts,
    hasInteractive: hasInteractiveReplyBlocks(normalizedPayload.interactive),
    hasChannelData,
  };
}

export function createOutboundPayloadPlan(
  payloads: readonly ReplyPayload[],
): OutboundPayloadPlan[] {
  // Intentionally scoped to channel-agnostic normalization and projection inputs.
  // Transport concerns (queueing, hooks, retries), channel transforms, and
  // heartbeat-specific token semantics remain outside this plan boundary.
  const plan: OutboundPayloadPlan[] = [];
  for (const payload of payloads) {
    const entry = createOutboundPayloadPlanEntry(payload);
    if (!entry) {
      continue;
    }
    plan.push(entry);
  }
  return plan;
}

export function projectOutboundPayloadPlanForDelivery(
  plan: readonly OutboundPayloadPlan[],
): ReplyPayload[] {
  return plan.map((entry) => entry.payload);
}

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
        { hasChannelData: entry.hasChannelData },
      )
    ) {
      continue;
    }
    normalizedPayloads.push({
      text,
      mediaUrls: entry.parts.mediaUrls,
      audioAsVoice: payload.audioAsVoice === true ? true : undefined,
      ...(entry.hasInteractive ? { interactive: payload.interactive } : {}),
      ...(entry.hasChannelData ? { channelData: payload.channelData } : {}),
    });
  }
  return normalizedPayloads;
}

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
      interactive: payload.interactive,
      channelData: payload.channelData,
    });
  }
  return normalized;
}

export function projectOutboundPayloadPlanForMirror(
  plan: readonly OutboundPayloadPlan[],
): OutboundPayloadMirror {
  return {
    text: plan
      .map((entry) => entry.payload.text)
      .filter((text): text is string => Boolean(text))
      .join("\n"),
    mediaUrls: plan.flatMap((entry) => entry.parts.mediaUrls),
  };
}

export function summarizeOutboundPayloadForTransport(
  payload: ReplyPayload,
): NormalizedOutboundPayload {
  const parts = resolveSendableOutboundReplyParts(payload);
  return {
    text: parts.text,
    mediaUrls: parts.mediaUrls,
    audioAsVoice: payload.audioAsVoice === true ? true : undefined,
    interactive: payload.interactive,
    channelData: payload.channelData,
  };
}

export function normalizeReplyPayloadsForDelivery(
  payloads: readonly ReplyPayload[],
): ReplyPayload[] {
  return projectOutboundPayloadPlanForDelivery(createOutboundPayloadPlan(payloads));
}

export function normalizeOutboundPayloads(
  payloads: readonly ReplyPayload[],
): NormalizedOutboundPayload[] {
  return projectOutboundPayloadPlanForOutbound(createOutboundPayloadPlan(payloads));
}

export function normalizeOutboundPayloadsForJson(
  payloads: readonly ReplyPayload[],
): OutboundPayloadJson[] {
  return projectOutboundPayloadPlanForJson(createOutboundPayloadPlan(payloads));
}

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
    lines.push(`MEDIA:${url}`);
  }
  return lines.join("\n");
}
