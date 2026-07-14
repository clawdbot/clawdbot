// Discord plugin module implements reply delivery behavior.
import { formatReasoningMessage, resolveAgentAvatar } from "openclaw/plugin-sdk/agent-runtime";
import {
  buildOutboundSessionContext,
  sendDurableMessageBatch,
  type OutboundDeliveryFormattingOptions,
  type OutboundIdentity,
  type OutboundSendDeps,
} from "openclaw/plugin-sdk/channel-outbound";
import type {
  MarkdownTableMode,
  OpenClawConfig,
  ReplyToMode,
} from "openclaw/plugin-sdk/config-contracts";
import type { OutboundMediaAccess } from "openclaw/plugin-sdk/media-runtime";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-dispatch-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type { RequestClient } from "../internal/discord.js";
import { sendMessageDiscord, sendVoiceMessageDiscord } from "../send.js";
import type { DiscordAllowedMentions } from "../send.shared.js";
import { sanitizeDiscordFrontChannelReplyPayloads } from "./reply-safety.js";

type DiscordThreadBindingLookupRecord = {
  accountId: string;
  channelId: string;
  threadId: string;
  agentId: string;
  label?: string;
  webhookId?: string;
  webhookToken?: string;
};

export type DiscordThreadBindingLookup = {
  listBySessionKey: (targetSessionKey: string) => DiscordThreadBindingLookupRecord[];
  touchThread?: (params: { threadId: string; at?: number; persist?: boolean }) => unknown;
};

export function formatDiscordReplyDeliveryFailure(params: {
  kind: string;
  err: unknown;
  target: string;
  sessionKey?: string;
}) {
  const context = [
    `target=${params.target}`,
    params.sessionKey ? `session=${params.sessionKey}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  return `discord ${params.kind} reply failed (${context}): ${String(params.err)}`;
}

function resolveTargetChannelId(target: string): string | undefined {
  if (!target.startsWith("channel:")) {
    return undefined;
  }
  const channelId = target.slice("channel:".length).trim();
  return channelId || undefined;
}

function resolveBoundThreadBinding(params: {
  threadBindings?: DiscordThreadBindingLookup;
  sessionKey?: string;
  target: string;
}): DiscordThreadBindingLookupRecord | undefined {
  const sessionKey = params.sessionKey?.trim();
  if (!params.threadBindings || !sessionKey) {
    return undefined;
  }
  const targetChannelId = resolveTargetChannelId(params.target);
  if (!targetChannelId) {
    return undefined;
  }
  return params.threadBindings
    .listBySessionKey(sessionKey)
    .find((entry) => entry.threadId === targetChannelId);
}

function resolveBindingIdentity(
  cfg: OpenClawConfig,
  binding: DiscordThreadBindingLookupRecord | undefined,
): OutboundIdentity | undefined {
  if (!binding) {
    return undefined;
  }
  const baseLabel = binding.label?.trim() || binding.agentId;
  const displayName = `🤖 ${baseLabel}`.trim() || "🤖 agent";
  const identity: OutboundIdentity = {
    name: truncateUtf16Safe(displayName, 80),
  };
  try {
    const avatar = resolveAgentAvatar(cfg, binding.agentId);
    if (avatar.kind === "remote") {
      identity.avatarUrl = avatar.url;
    }
  } catch {
    // Avatar is cosmetic; delivery should not depend on local identity config.
  }
  return identity;
}

function createDiscordDeliveryDeps(params: {
  cfg: OpenClawConfig;
  token: string;
  rest?: RequestClient;
  allowedMentions?: DiscordAllowedMentions;
}): OutboundSendDeps {
  return {
    // Discord webhooks default to user-only parsing; bot messages need this
    // explicit policy to prevent a fresh preview final from broadcasting.
    discord: (to: string, text: string, opts?: Parameters<typeof sendMessageDiscord>[2]) =>
      sendMessageDiscord(to, text, {
        ...opts,
        cfg: opts?.cfg ?? params.cfg,
        token: params.token,
        rest: params.rest,
        ...(params.allowedMentions ? { allowedMentions: params.allowedMentions } : {}),
      }),
    discordVoice: (
      to: string,
      audioPath: string,
      opts?: Parameters<typeof sendVoiceMessageDiscord>[2],
    ) =>
      sendVoiceMessageDiscord(to, audioPath, {
        ...opts,
        cfg: opts?.cfg ?? params.cfg,
        token: params.token,
        rest: params.rest,
      }),
  };
}

type DiscordDeliveryOptions = {
  to: string;
  threadId?: string;
  agentId?: string;
  identity?: OutboundIdentity;
  mediaAccess?: OutboundMediaAccess;
  replyToMode: ReplyToMode;
  formatting: OutboundDeliveryFormattingOptions;
};

function resolveDiscordDeliveryOptions(params: {
  cfg: OpenClawConfig;
  target: string;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
  textLimit: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  replyToMode?: ReplyToMode;
  mediaLocalRoots?: readonly string[];
}): DiscordDeliveryOptions {
  const binding = resolveBoundThreadBinding({
    threadBindings: params.threadBindings,
    sessionKey: params.sessionKey,
    target: params.target,
  });
  return {
    to: binding ? `channel:${binding.channelId}` : params.target,
    threadId: binding?.threadId,
    agentId: binding?.agentId,
    identity: resolveBindingIdentity(params.cfg, binding),
    mediaAccess: params.mediaLocalRoots?.length
      ? { localRoots: params.mediaLocalRoots }
      : undefined,
    replyToMode: params.replyToMode ?? "all",
    formatting: {
      textLimit: params.textLimit,
      maxLinesPerMessage: params.maxLinesPerMessage,
      tableMode: params.tableMode,
      chunkMode: params.chunkMode,
    },
  };
}

function formatDiscordReasoningPayload(payload: ReplyPayload): ReplyPayload {
  if (payload.isReasoning !== true) {
    return payload;
  }
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const nextPayload: ReplyPayload = {
    ...payload,
    text: formatReasoningMessage(text),
  };
  delete nextPayload.isReasoning;
  return nextPayload;
}

export async function deliverDiscordReply(params: {
  cfg: OpenClawConfig;
  replies: ReplyPayload[];
  target: string;
  token: string;
  accountId?: string;
  rest?: RequestClient;
  runtime: RuntimeEnv;
  textLimit: number;
  maxLinesPerMessage?: number;
  replyToId?: string;
  replyToMode?: ReplyToMode;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  sessionKey?: string;
  threadBindings?: DiscordThreadBindingLookup;
  mediaLocalRoots?: readonly string[];
  allowedMentions?: DiscordAllowedMentions;
  kind: "tool" | "block" | "final";
}) {
  void params.runtime;

  const delivery = resolveDiscordDeliveryOptions(params);
  const payloads = sanitizeDiscordFrontChannelReplyPayloads(params.replies, {
    kind: params.kind,
  }).map(formatDiscordReasoningPayload);
  if (payloads.length === 0) {
    return;
  }

  const send = await sendDurableMessageBatch({
    cfg: params.cfg,
    channel: "discord",
    to: delivery.to,
    accountId: params.accountId,
    payloads,
    replyToId: normalizeOptionalString(params.replyToId),
    replyToMode: delivery.replyToMode,
    formatting: delivery.formatting,
    threadId: delivery.threadId,
    identity: delivery.identity,
    deps: createDiscordDeliveryDeps({
      cfg: params.cfg,
      token: params.token,
      rest: params.rest,
      allowedMentions: params.allowedMentions,
    }),
    mediaAccess: delivery.mediaAccess,
    session: buildOutboundSessionContext({
      cfg: params.cfg,
      sessionKey: params.sessionKey,
      agentId: delivery.agentId,
      requesterAccountId: params.accountId,
    }),
  });
  if (send.status === "failed" || send.status === "partial_failed") {
    throw send.error;
  }
  const results = send.status === "sent" ? send.results : [];
  if (results.length === 0) {
    throw new Error(`discord final reply produced no delivered message for ${delivery.to}`);
  }
}
