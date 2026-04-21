import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import { parseReplyDirectives } from "../../auto-reply/reply/reply-directives.js";
import {
  formatBtwTextForExternalDelivery,
  isRenderablePayload,
  shouldSuppressReasoningPayload,
} from "../../auto-reply/reply/reply-payloads.js";
import type { ReplyPayload } from "../../auto-reply/types.js";
import { resolveSilentReplySettings } from "../../config/silent-reply.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  hasInteractiveReplyBlocks,
  hasReplyChannelData,
  hasReplyPayloadContent,
  type InteractiveReply,
} from "../../interactive/payload.js";
import {
  resolveSilentReplyRewriteText,
  type SilentReplyConversationType,
} from "../../shared/silent-reply-policy.js";

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

type OutboundPayloadPlanContext = {
  cfg?: OpenClawConfig;
  sessionKey?: string;
  surface?: string;
  conversationType?: SilentReplyConversationType;
};

export type OutboundPayloadMirror = {
  text: string;
  mediaUrls: string[];
};

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

type PreparedOutboundPayloadPlanEntry = {
  payload: ReplyPayload;
  hasInteractive: boolean;
  hasChannelData: boolean;
  isSilent: boolean;
};

function createOutboundPayloadPlanEntry(
  payload: ReplyPayload,
): PreparedOutboundPayloadPlanEntry | null {
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
  const parsedText = parsed.text ?? "";
  if (isSuppressedRelayStatusText(parsedText) && mergedMedia.length === 0) {
    return null;
  }
  const isSilent = parsed.isSilent && mergedMedia.length === 0;
  const hasMultipleMedia = (explicitMediaUrls?.length ?? 0) > 1;
  const resolvedMediaUrl = hasMultipleMedia ? undefined : explicitMediaUrl;
  const normalizedPayload: ReplyPayload = {
    ...payload,
    text:
      formatBtwTextForExternalDelivery({
        ...payload,
        text: parsedText,
      }) ?? "",
    mediaUrls: mergedMedia.length ? mergedMedia : undefined,
    mediaUrl: resolvedMediaUrl,
    replyToId: payload.replyToId ?? parsed.replyToId,
    replyToTag: payload.replyToTag || parsed.replyToTag,
    replyToCurrent: payload.replyToCurrent || parsed.replyToCurrent,
    audioAsVoice: Boolean(payload.audioAsVoice || parsed.audioAsVoice),
  };
  if (!isRenderablePayload(normalizedPayload) && !isSilent) {
    return null;
  }
  const hasChannelData = hasReplyChannelData(normalizedPayload.channelData);
  return {
    payload: normalizedPayload,
    hasInteractive: hasInteractiveReplyBlocks(normalizedPayload.interactive),
    hasChannelData,
    isSilent,
  };
}

export function createOutboundPayloadPlan(
  payloads: readonly ReplyPayload[],
  context: OutboundPayloadPlanContext = {},
): OutboundPayloadPlan[] {
  // Intentionally scoped to channel-agnostic normalization and projection inputs.
  // Transport concerns (queueing, hooks, retries), channel transforms, and
  // heartbeat-specific token semantics remain outside this plan boundary.
  const resolvedSilentReplySettings = resolveSilentReplySettings({
    cfg: context.cfg,
    sessionKey: context.sessionKey,
    surface: context.surface,
    conversationType: context.conversationType,
  });
  const prepared: PreparedOutboundPayloadPlanEntry[] = [];
  for (const payload of payloads) {
    const entry = createOutboundPayloadPlanEntry(payload);
    if (!entry) {
      continue;
    }
    prepared.push(entry);
  }
  const hasVisibleNonSilentContent = prepared.some((entry) => {
    if (entry.isSilent) {
      return false;
    }
    const parts = resolveSendableOutboundReplyParts(entry.payload);
    return hasReplyPayloadContent(
      { ...entry.payload, text: parts.text, mediaUrls: parts.mediaUrls },
      { hasChannelData: entry.hasChannelData },
    );
  });
  const plan: OutboundPayloadPlan[] = [];
  for (const entry of prepared) {
    if (!entry.isSilent) {
      plan.push({
        payload: entry.payload,
        parts: resolveSendableOutboundReplyParts(entry.payload),
        hasInteractive: entry.hasInteractive,
        hasChannelData: entry.hasChannelData,
      });
      continue;
    }
    if (hasVisibleNonSilentContent || resolvedSilentReplySettings.policy === "allow") {
      continue;
    }
    if (!resolvedSilentReplySettings.rewrite) {
      const visibleSilentPayload: ReplyPayload = {
        ...entry.payload,
        text: entry.payload.text?.trim() || "NO_REPLY",
      };
      if (!isRenderablePayload(visibleSilentPayload)) {
        continue;
      }
      plan.push({
        payload: visibleSilentPayload,
        parts: resolveSendableOutboundReplyParts(visibleSilentPayload),
        hasInteractive: entry.hasInteractive,
        hasChannelData: entry.hasChannelData,
      });
      continue;
    }
    const rewrittenPayload: ReplyPayload = {
      ...entry.payload,
      text: resolveSilentReplyRewriteText({
        seed: `${context.sessionKey ?? context.surface ?? "silent-reply"}:${entry.payload.text ?? ""}`,
      }),
    };
    if (!isRenderablePayload(rewrittenPayload)) {
      continue;
    }
    plan.push({
      payload: rewrittenPayload,
      parts: resolveSendableOutboundReplyParts(rewrittenPayload),
      hasInteractive: entry.hasInteractive,
      hasChannelData: entry.hasChannelData,
    });
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
