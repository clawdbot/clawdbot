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
import type { ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;

type DiscordSendRuntime = typeof import("./send.js");
type DiscordSendFn = DiscordSendRuntime["sendMessageDiscord"];
type DiscordComponentSendFn = typeof import("./send.components.js").sendDiscordComponentMessage;

let discordSendRuntimePromise: Promise<DiscordSendRuntime> | undefined;
let discordComponentSendPromise: Promise<DiscordComponentSendFn> | undefined;

async function loadDiscordSendRuntime(): Promise<DiscordSendRuntime> {
  discordSendRuntimePromise ??= import("./send.js");
  return await discordSendRuntimePromise;
}

async function sendDiscordComponentMessageLazy(
  ...args: Parameters<DiscordComponentSendFn>
): ReturnType<DiscordComponentSendFn> {
  discordComponentSendPromise ??= import("./send.components.js").then(
    (module) => module.sendDiscordComponentMessage,
  );
  return await (
    await discordComponentSendPromise
  )(...args);
}

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
  const { getThreadBindingManager } = await import("./monitor/thread-bindings.js");
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
  const { sendWebhookMessageDiscord } = await loadDiscordSendRuntime();
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
      discordData?.components ??
      (payload.interactive
        ? (await import("./shared-interactive.js")).buildDiscordInteractiveComponents(
            payload.interactive,
          )
        : undefined);
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
      resolveOutboundSendDep<DiscordSendFn>(ctx.deps, "discord") ??
      (await loadDiscordSendRuntime()).sendMessageDiscord;
    const target = resolveDiscordOutboundTarget({ to: ctx.to, threadId: ctx.threadId });
    const mediaUrls = resolvePayloadMediaUrls(payload);
    const result = await sendPayloadMediaSequenceOrFallback({
      text: payload.text ?? "",
      mediaUrls,
      fallbackResult: { messageId: "", channelId: target },
      sendNoMedia: async () =>
        await sendDiscordComponentMessageLazy(target, componentSpec, {
          replyTo: ctx.replyToId ?? undefined,
          accountId: ctx.accountId ?? undefined,
          silent: ctx.silent ?? undefined,
          cfg: ctx.cfg,
        }),
      send: async ({ text, mediaUrl, isFirst }) => {
        if (isFirst) {
          return await sendDiscordComponentMessageLazy(target, componentSpec, {
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
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
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
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
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
      await (
        await loadDiscordSendRuntime()
      ).sendPollDiscord(resolveDiscordOutboundTarget({ to, threadId }), poll, {
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
      }),
  }),
};
