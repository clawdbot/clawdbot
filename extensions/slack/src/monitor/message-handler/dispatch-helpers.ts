import type { ChannelBotLoopProtectionFacts } from "openclaw/plugin-sdk/channel-inbound";
import { resolveChannelProgressDraftConfig } from "openclaw/plugin-sdk/channel-outbound";
import type { SlackAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { mergePairLoopGuardConfig } from "openclaw/plugin-sdk/pair-loop-guard-runtime";
import { resolveSendableOutboundReplyParts } from "openclaw/plugin-sdk/reply-payload";
import type { ReplyDispatchKind, ReplyPayload } from "openclaw/plugin-sdk/reply-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { prepareSlackReply, type PreparedSlackReply } from "../../reply-blocks.js";
import type { SlackMessageEvent } from "../../types.js";
import { readSlackReplyBlocks, resolveSlackThreadTs } from "../replies.js";
import { resolveSlackTimestampMs } from "./timestamp.js";
import type { PreparedSlackMessage } from "./types.js";

type SlackProgressConfigEntry = Pick<SlackAccountConfig, "streaming"> | null | undefined;

function resolveSlackMessageTimestampMs(message: SlackMessageEvent): number | undefined {
  const ts = message.event_ts ?? message.ts;
  return resolveSlackTimestampMs(ts);
}

export function resolveSlackBotLoopProtection(
  prepared: PreparedSlackMessage,
): ChannelBotLoopProtectionFacts | undefined {
  const senderBotId = prepared.message.bot_id;
  if (!senderBotId) {
    return undefined;
  }
  const receiverBotId = prepared.ctx.botId || prepared.ctx.botUserId;
  if (
    !receiverBotId ||
    senderBotId === prepared.ctx.botId ||
    prepared.message.user === prepared.ctx.botUserId
  ) {
    return undefined;
  }
  return {
    scopeId: prepared.route.accountId,
    conversationId: prepared.message.channel,
    senderId: senderBotId,
    receiverId: receiverBotId,
    config: mergePairLoopGuardConfig(
      prepared.account.config.botLoopProtection,
      prepared.channelConfig?.botLoopProtection,
    ),
    defaultsConfig: prepared.ctx.cfg.channels?.defaults?.botLoopProtection,
    defaultEnabled: true,
    nowMs: resolveSlackMessageTimestampMs(prepared.message),
  };
}

export function isSlackStreamingEnabled(params: {
  mode: "off" | "partial" | "block" | "progress";
  nativeStreaming: boolean;
  nativeProgressTaskCards?: boolean;
}): boolean {
  if (params.mode === "partial") {
    return params.nativeStreaming;
  }
  if (params.mode === "progress") {
    return params.nativeStreaming && params.nativeProgressTaskCards === true;
  }
  return false;
}

export function resolveSlackDisableBlockStreaming(params: {
  useStreaming: boolean;
  shouldUseDraftStream: boolean;
  blockStreamingEnabled: boolean | undefined;
}): boolean | undefined {
  if (params.useStreaming || params.shouldUseDraftStream) {
    return true;
  }
  return typeof params.blockStreamingEnabled === "boolean"
    ? !params.blockStreamingEnabled
    : undefined;
}

export function resolveExplicitSlackProgressTitle(
  entry: Parameters<typeof resolveChannelProgressDraftConfig>[0],
): string | undefined {
  const label = resolveChannelProgressDraftConfig(entry).label;
  if (typeof label !== "string") {
    return undefined;
  }
  const trimmed = label.trim();
  return trimmed && trimmed.toLowerCase() !== "auto" ? trimmed : undefined;
}

export function resolveSlackProgressStyle(entry: SlackProgressConfigEntry): "card" | "compact" {
  // DO NOT REMOVE OR CHANGE THE COMPACT STYLE WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
  const progress = entry?.streaming?.progress;
  return progress?.style ?? (progress?.toolProgress === false ? "compact" : "card");
}

// Slack's native agent card is the default progress surface; operators opt out
// with an explicit `false`, which falls back to the Block Kit progress card.
export function resolveSlackNativeProgressTaskCards(entry: SlackProgressConfigEntry): boolean {
  // THIS BEHAVIOR IS INTENTIONAL AND MUST NOT BE CASUALLY ADJUSTED.
  // DO NOT CHANGE THIS WITHOUT APPROVAL FROM SJF OR PASHPASHPASH.
  if (resolveSlackProgressStyle(entry) === "compact") {
    return false;
  }
  const streaming = entry?.streaming;
  if (!streaming || typeof streaming !== "object" || Array.isArray(streaming)) {
    return true;
  }
  const progressConfig = (streaming as Record<string, unknown>).progress;
  if (!progressConfig || typeof progressConfig !== "object" || Array.isArray(progressConfig)) {
    return true;
  }
  return (progressConfig as { nativeTaskCards?: unknown }).nativeTaskCards !== false;
}

export function resolveSlackStreamingThreadHint(params: {
  replyToMode: "off" | "first" | "all" | "batched";
  incomingThreadTs: string | undefined;
  messageTs: string | undefined;
  isThreadReply?: boolean;
}): string | undefined {
  return resolveSlackThreadTs({
    replyToMode: params.replyToMode,
    incomingThreadTs: params.incomingThreadTs,
    messageTs: params.messageTs,
    hasReplied: false,
    isThreadReply: params.isThreadReply,
  });
}

export type SlackEventDeliveryAttempt = {
  kind: ReplyDispatchKind;
  payload: ReplyPayload;
  threadTs?: string;
  textOverride?: string;
};

const SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX = 2000;
const slackStreamRecipientTeamCaches = new WeakMap<object, Map<string, string>>();

function getSlackStreamRecipientTeamCache(client: object): Map<string, string> {
  const existing = slackStreamRecipientTeamCaches.get(client);
  if (existing) {
    return existing;
  }
  const cache = new Map<string, string>();
  slackStreamRecipientTeamCaches.set(client, cache);
  return cache;
}

export function buildSlackEventDeliveryKey(
  params: SlackEventDeliveryAttempt,
  preparedReply: PreparedSlackReply = prepareSlackReply(params.payload),
): string | null {
  const reply = resolveSendableOutboundReplyParts(params.payload, {
    text: params.textOverride,
  });
  const renderPlan = preparedReply.resolvePreview(params.textOverride);
  const plannedBlocks =
    renderPlan.mode === "single" ? renderPlan.blocks : renderPlan.blockPart?.blocks;
  const slackBlocks = readSlackReplyBlocks(params.payload) ?? plannedBlocks;
  const renderedText = renderPlan.mode === "single" ? renderPlan.text : renderPlan.fallbackText;
  if (!reply.hasContent && !slackBlocks?.length && !renderedText.trim()) {
    return null;
  }
  return JSON.stringify({
    kind: params.kind,
    threadTs: params.threadTs ?? "",
    replyToId: params.payload.replyToId ?? null,
    text: renderedText || reply.trimmedText,
    mediaUrls: reply.mediaUrls,
    blocks: slackBlocks ?? null,
  });
}

function readSlackStreamRecipientTeamCache(params: {
  client: object;
  fallbackTeamId?: string;
  userId?: string;
}): string | undefined {
  if (!params.fallbackTeamId || !params.userId) {
    return undefined;
  }
  const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
  const cache = getSlackStreamRecipientTeamCache(params.client);
  const cached = cache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  cache.delete(cacheKey);
  cache.set(cacheKey, cached);
  return cached;
}

function rememberSlackStreamRecipientTeam(params: {
  client: object;
  fallbackTeamId?: string;
  userId?: string;
  teamId: string;
}): void {
  if (!params.fallbackTeamId || !params.userId) {
    return;
  }
  const cacheKey = `${params.fallbackTeamId}:${params.userId}`;
  const cache = getSlackStreamRecipientTeamCache(params.client);
  if (cache.has(cacheKey)) {
    cache.delete(cacheKey);
  }
  cache.set(cacheKey, params.teamId);
  if (cache.size > SLACK_STREAM_RECIPIENT_TEAM_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) {
      cache.delete(oldest);
    }
  }
}

export function createSlackEventDeliveryTracker() {
  const deliveredKeys = new Set<string>();
  return {
    hasDelivered(key: string | null) {
      return key ? deliveredKeys.has(key) : false;
    },
    markDelivered(key: string | null) {
      if (key) {
        deliveredKeys.add(key);
      }
    },
  };
}

export function shouldUseStreaming(params: {
  streamingEnabled: boolean;
  threadTs: string | undefined;
}): boolean {
  if (!params.streamingEnabled) {
    return false;
  }
  if (!params.threadTs) {
    logVerbose("slack-stream: streaming disabled — no reply thread target available");
    return false;
  }
  return true;
}

export async function resolveSlackStreamRecipientTeamId(params: {
  client: Pick<PreparedSlackMessage["ctx"]["app"]["client"], "users">;
  token: string;
  userId?: PreparedSlackMessage["message"]["user"];
  fallbackTeamId?: string;
}): Promise<string | undefined> {
  const cachedTeamId = readSlackStreamRecipientTeamCache(params);
  if (cachedTeamId) {
    return cachedTeamId;
  }
  if (params.userId) {
    try {
      const info = await params.client.users.info({
        token: params.token,
        user: params.userId,
      });
      const teamId = info.user?.team_id ?? info.user?.profile?.team;
      if (teamId) {
        rememberSlackStreamRecipientTeam({ ...params, teamId });
        return teamId;
      }
    } catch (err) {
      logVerbose(`slack-stream: users.info team lookup failed (${formatErrorMessage(err)})`);
    }
  }
  return params.fallbackTeamId;
}
