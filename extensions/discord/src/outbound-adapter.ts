import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOutboundSendDep,
  type OutboundIdentity,
} from "openclaw/plugin-sdk/outbound-runtime";
import {
  resolvePayloadMediaUrls,
  sendPayloadMediaSequenceOrFallback,
  sendTextMediaPayload,
} from "openclaw/plugin-sdk/reply-payload";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import type { DiscordComponentMessageSpec } from "./components.js";
import { getThreadBindingManager, type ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { sendDiscordComponentMessage } from "./send.components.js";
import { sendMessageDiscord, sendPollDiscord, sendWebhookMessageDiscord } from "./send.js";
import { buildDiscordInteractiveComponents } from "./shared-interactive.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

function hasApprovalChannelData(payload: { channelData?: unknown }): boolean {
  const channelData = payload.channelData;
  if (!channelData || typeof channelData !== "object" || Array.isArray(channelData)) {
    return false;
  }
  return Boolean((channelData as { execApproval?: unknown }).execApproval);
}

function neutralizeDiscordApprovalMentions(value: string): string {
  return value
    .replace(/@everyone/gi, "@\u200beveryone")
    .replace(/@here/gi, "@\u200bhere")
    .replace(/<@/g, "<@\u200b")
    .replace(/<#/g, "<#\u200b");
}

function normalizeDiscordApprovalPayload<T extends { text?: string; channelData?: unknown }>(
  payload: T,
): T {
  return hasApprovalChannelData(payload) && payload.text
    ? {
        ...payload,
        text: neutralizeDiscordApprovalMentions(payload.text),
      }
    : payload;
}

function resolveDiscordOutboundTarget(params: {
  to: string;
  threadId?: string | number | null;
}): string {
  if (params.threadId == null) {
    return params.to;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return params.to;
  }
  return `channel:${threadId}`;
}

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = normalizeOptionalString(params.identity?.name);
  const fallbackUsername = normalizeOptionalString(params.binding.label) ?? params.binding.agentId;
  const username = (usernameRaw || fallbackUsername || "").slice(0, 80) || undefined;
  const avatarUrl = normalizeOptionalString(params.identity?.avatarUrl);
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  cfg?: OpenClawConfig;
  text: string;
  threadId?: string | number | null;
  accountId?: string | null;
  identity?: OutboundIdentity;
  replyToId?: string | null;
}): Promise<{ messageId: string; channelId: string } | null> {
  if (params.threadId == null) {
    return null;
  }
  const threadId = normalizeOptionalStringifiedId(params.threadId) ?? "";
  if (!threadId) {
    return null;
  }
  const manager = getThreadBindingManager(params.accountId ?? undefined);
  if (!manager) {
    return null;
  }
  const binding = manager.getByThreadId(threadId);
  if (!binding?.webhookId || !binding?.webhookToken) {
    return null;
  }
  const persona = resolveDiscordWebhookIdentity({
    identity: params.identity,
    binding,
  });
  const result = await sendWebhookMessageDiscord(params.text, {
    webhookId: binding.webhookId,
    webhookToken: binding.webhookToken,
    accountId: binding.accountId,
    threadId: binding.threadId,
    cfg: params.cfg,
    replyTo: params.replyToId ?? undefined,
    username: persona.username,
    avatarUrl: persona.avatarUrl,
  });
  return result;
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: null,
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  pollMaxOptions: 10,
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  resolveTarget: ({ to }) => normalizeDiscordOutboundTarget(to),
  sendPayload: async (ctx) => {
    const payload = normalizeDiscordApprovalPayload({
      ...ctx.payload,
      text: ctx.payload.text ?? "",
    });
    const discordData = payload.channelData?.discord as
      | { components?: DiscordComponentMessageSpec }
      | undefined;
    const rawComponentSpec =
      discordData?.components ?? buildDiscordInteractiveComponents(payload.interactive);
    const componentSpec = rawComponentSpec
      ? rawComponentSpec.text
        ? rawComponentSpec
        : {
            ...rawComponentSpec,
            text: payload.text?.trim() ? payload.text : undefined,
          }
      : undefined;
    if (!componentSpec) {
      return await sendTextMediaPayload({
        channel: "discord",
        ctx: {
          ...ctx,
          payload,
        },
        adapter: discordOutbound,
      });
    }
    const send =
      resolveOutboundSendDep<typeof sendMessageDiscord>(ctx.deps, "discord") ?? sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to: ctx.to, threadId: ctx.threadId });
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const result = await sendPayloadMediaSequenceOrFallback({
      text: payload.text ?? "",
      mediaUrls,
      fallbackResult: { messageId: "", channelId: target },
      sendNoMedia: async () =>
        await sendDiscordComponentMessage(target, componentSpec, {
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        }),
      send: async ({ text, mediaUrl, isFirst }) => {
        if (isFirst) {
          return await sendDiscordComponentMessage(target, componentSpec, {
            mediaUrl,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            replyTo: ctx.replyToId ?? undefined,
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            cfg: ctx.cfg,
          });
        }
        return await send(target, text, {
          verbose: false,
          mediaUrl,
          mediaAccess: ctx.mediaAccess,
          mediaLocalRoots: ctx.mediaLocalRoots,
          mediaReadFile: ctx.mediaReadFile,
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        });
      },
    });
    return attachChannelToResult("discord", result);
  },
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async ({ cfg, to, text, accountId, deps, replyToId, threadId, identity, silent }) => {
      if (!silent) {
        const webhookResult = await maybeSendDiscordWebhookText({
          cfg,
          text,
          threadId,
          accountId,
          identity,
          replyToId,
        }).catch(() => null);
        if (webhookResult) {
          return webhookResult;
        }
      }
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
        verbose: false,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      threadId,
      silent,
    }) => {
      const send =
        resolveOutboundSendDep<typeof sendMessageDiscord>(deps, "discord") ?? sendMessageDiscord;
      return await send(resolveDiscordOutboundTarget({ to, threadId }), text, {
        verbose: false,
        mediaUrl,
        mediaLocalRoots,
        mediaReadFile,
        replyTo: replyToId ?? undefined,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      });
    },
    sendPoll: async ({ cfg, to, poll, accountId, threadId, silent }) =>
      await sendPollDiscord(resolveDiscordOutboundTarget({ to, threadId }), poll, {
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      }),
  }),
};
