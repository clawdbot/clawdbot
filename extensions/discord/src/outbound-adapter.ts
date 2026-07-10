// Discord plugin module implements outbound adapter behavior.
import type { OutboundIdentity } from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { notifyDiscordInboundEventOutboundPayloadSuccess } from "./inbound-event-delivery.js";
import { isLikelyDiscordVideoMedia } from "./media-detection.js";
import type { ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  buildDiscordPresentationPayload,
  DISCORD_PRESENTATION_CAPABILITIES,
  DISCORD_PRESENTATION_TEXT_LIMIT,
} from "./outbound-components.js";
import { sendDiscordOutboundPayload } from "./outbound-payload.js";
import {
  loadDiscordSendRuntime,
  resolveDiscordFormattingOptions,
  resolveDiscordOutboundTarget,
  type DiscordSendFn,
  type DiscordVoiceSendFn,
} from "./outbound-send-context.js";
import { resolveDiscordReplyReference } from "./reply-reference.js";

export const DISCORD_TEXT_CHUNK_LIMIT = DISCORD_PRESENTATION_TEXT_LIMIT;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE =
  /<\s*(system-reminder|previous_response)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE =
  /<\s*(?:system-reminder|previous_response)\b[^>]*\/\s*>/gi;
const DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE =
  /<\s*\/?\s*(?:system-reminder|previous_response)\b[^>]*>/gi;

function stripDiscordInternalRuntimeScaffolding(text: string): string {
  return text
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_BLOCK_RE, "")
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_SELF_CLOSING_RE, "")
    .replace(DISCORD_INTERNAL_RUNTIME_SCAFFOLDING_TAG_RE, "");
}

const loadDiscordThreadBindings = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.js"),
);

function resolveDiscordWebhookIdentity(params: {
  identity?: OutboundIdentity;
  binding: ThreadBindingRecord;
}): { username?: string; avatarUrl?: string } {
  const usernameRaw = normalizeOptionalString(params.identity?.name);
  const fallbackUsername = normalizeOptionalString(params.binding.label) ?? params.binding.agentId;
  const username = truncateUtf16Safe(usernameRaw || fallbackUsername || "", 80) || undefined;
  const avatarUrl = normalizeOptionalString(params.identity?.avatarUrl);
  return { username, avatarUrl };
}

async function maybeSendDiscordWebhookText(params: {
  cfg: OpenClawConfig;
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
  const { getThreadBindingManager } = await loadDiscordThreadBindings();
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
  chunker: (text, limit, ctx) =>
    chunkDiscordTextWithMode(text, {
      maxChars: limit,
      maxLines: ctx?.formatting?.maxLinesPerMessage,
    }),
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
  sanitizeText: ({ text }) => stripDiscordInternalRuntimeScaffolding(text),
  pollMaxOptions: 10,
  normalizePayload: ({ payload }) => normalizeDiscordApprovalPayload(payload),
  presentationCapabilities: DISCORD_PRESENTATION_CAPABILITIES,
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      poll: true,
      payload: true,
      silent: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
    },
  },
  renderPresentation: async ({ payload, presentation }) => {
    return await buildDiscordPresentationPayload({
      payload,
      presentation,
    });
  },
  resolveTarget: ({ to, allowFrom }) => normalizeDiscordOutboundTarget(to, allowFrom),
  sendPayload: async (ctx) =>
    await sendDiscordOutboundPayload({
      ctx,
      fallbackAdapter: discordOutbound,
    }),
  ...createAttachedChannelResultAdapter({
    channel: "discord",
    sendText: async ({
      cfg,
      to,
      text,
      accountId,
      deps,
      replyToId,
      replyToIdSource,
      replyToMode,
      threadId,
      identity,
      silent,
      formatting,
      onDeliveryResult,
    }) => {
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
        reply: resolveDiscordReplyReference({
          replyToId,
          replyToIdSource,
          replyToMode,
        }),
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
        ...resolveDiscordFormattingOptions({ formatting }),
        onDeliveryResult: onDeliveryResult
          ? async (result) => {
              await onDeliveryResult(attachChannelToResult("discord", result));
            }
          : undefined,
      });
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      audioAsVoice,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      deps,
      replyToId,
      replyToIdSource,
      replyToMode,
      threadId,
      silent,
      formatting,
      onDeliveryResult,
    }) => {
      const send =
        resolveOutboundSendDep<DiscordSendFn>(deps, "discord") ??
        (await loadDiscordSendRuntime()).sendMessageDiscord;
      const target = resolveDiscordOutboundTarget({ to, threadId });
      const formattingOptions = resolveDiscordFormattingOptions({ formatting });
      const reply = resolveDiscordReplyReference({
        replyToId,
        replyToIdSource,
        replyToMode,
      });
      if (audioAsVoice && mediaUrl) {
        const sendVoice =
          resolveOutboundSendDep<DiscordVoiceSendFn>(deps, "discordVoice") ??
          (await loadDiscordSendRuntime()).sendVoiceMessageDiscord;
        return await sendVoice(target, mediaUrl, {
          cfg,
          reply,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
        });
      }
      if (text.trim() && mediaUrl && isLikelyDiscordVideoMedia(mediaUrl)) {
        await send(target, text, {
          verbose: false,
          reply,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
          cfg,
          ...formattingOptions,
          onDeliveryResult: onDeliveryResult
            ? async (result) => {
                await onDeliveryResult(attachChannelToResult("discord", result));
              }
            : undefined,
        });
        return await send(target, "", {
          verbose: false,
          mediaUrl,
          reply: reply?.scope === "all" ? reply : undefined,
          mediaAccess,
          mediaLocalRoots,
          mediaReadFile,
          accountId: accountId ?? undefined,
          silent: silent ?? undefined,
          cfg,
          ...formattingOptions,
          onDeliveryResult: onDeliveryResult
            ? async (result) => {
                await onDeliveryResult(attachChannelToResult("discord", result));
              }
            : undefined,
        });
      }
      return await send(target, text, {
        verbose: false,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
        reply,
        accountId: accountId ?? undefined,
        silent: silent ?? undefined,
        cfg,
        ...formattingOptions,
        onDeliveryResult: onDeliveryResult
          ? async (result) => {
              await onDeliveryResult(attachChannelToResult("discord", result));
            }
          : undefined,
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
  afterDeliverPayload: async ({ target, payload }) => {
    notifyDiscordInboundEventOutboundPayloadSuccess({
      payload,
      to: resolveDiscordOutboundTarget({ to: target.to, threadId: target.threadId }),
      accountId: target.accountId,
    });
    const threadId = normalizeOptionalStringifiedId(target.threadId);
    if (!threadId) {
      return;
    }
    const { getThreadBindingManager } = await loadDiscordThreadBindings();
    const manager = getThreadBindingManager(target.accountId ?? undefined);
    if (!manager?.getByThreadId(threadId)) {
      return;
    }
    manager.touchThread({ threadId });
  },
};
