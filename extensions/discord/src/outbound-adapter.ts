// Discord plugin module implements outbound adapter behavior.
import {
  type OutboundIdentity,
  resolveOutboundSendDep,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  attachChannelToResult,
  type ChannelOutboundAdapter,
  createAttachedChannelResultAdapter,
} from "openclaw/plugin-sdk/channel-send-result";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createDiscordActionGate } from "./accounts.js";
import { formatDiscordApprovalDisplayValue } from "./approval-message-safety.js";
import { chunkDiscordTextWithMode } from "./chunk.js";
import {
  discordInboundEventDelivery,
  notifyDiscordInboundEventOutboundPayloadSuccess,
} from "./inbound-event-delivery.js";
import { isLikelyDiscordVideoMedia } from "./media-detection.js";
import type { ThreadBindingRecord } from "./monitor/thread-bindings.js";
import { normalizeDiscordOutboundTarget } from "./normalize.js";
import { normalizeDiscordApprovalPayload } from "./outbound-approval.js";
import {
  buildDiscordPresentationPayload,
  DISCORD_PRESENTATION_CAPABILITIES,
  resolveDiscordComponentSpec,
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
import {
  createDiscordSendReceiptFromResults,
  toDiscordOutboundDeliveryResult,
} from "./send.receipt.js";

export const DISCORD_TEXT_CHUNK_LIMIT = 2000;
const log = createSubsystemLogger("discord/outbound");
const loadDiscordThreadBindings = createLazyRuntimeModule(
  () => import("./monitor/thread-bindings.js"),
);
const loadDiscordComponentSendRuntime = createLazyRuntimeModule(
  () => import("./send.components.js"),
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
  onPlatformSendDispatch?: () => Promise<void>;
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
    onPlatformSendDispatch: params.onPlatformSendDispatch,
  });
  return result;
}

type DiscordOutboundMessageContext = Parameters<NonNullable<ChannelOutboundAdapter["sendText"]>>[0];

async function resolveDiscordOutboundMessageSend(params: DiscordOutboundMessageContext) {
  const send =
    resolveOutboundSendDep<DiscordSendFn>(params.deps, "discord") ??
    (await loadDiscordSendRuntime()).sendMessageDiscord;
  const reply = resolveDiscordReplyReference({
    replyToId: params.replyToId,
    replyToIdSource: params.replyToIdSource,
    replyToMode: params.replyToMode,
  });
  return {
    send,
    target: resolveDiscordOutboundTarget({ to: params.to, threadId: params.threadId }),
    options: {
      verbose: false as const,
      reply,
      accountId: params.accountId ?? undefined,
      silent: params.silent ?? undefined,
      cfg: params.cfg,
      ...resolveDiscordFormattingOptions({ formatting: params.formatting }),
      onDeliveryResult: params.onDeliveryResult
        ? async (
            result: Parameters<
              NonNullable<NonNullable<Parameters<DiscordSendFn>[2]>["onDeliveryResult"]>
            >[0],
          ) => {
            await params.onDeliveryResult?.(
              attachChannelToResult("discord", toDiscordOutboundDeliveryResult(result)),
            );
          }
        : undefined,
      onPlatformSendDispatch: params.onPlatformSendDispatch,
    },
  };
}

export const discordOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit, ctx) =>
    chunkDiscordTextWithMode(text, {
      maxChars: limit,
      maxLines: ctx?.formatting?.maxLinesPerMessage,
    }),
  textChunkLimit: DISCORD_TEXT_CHUNK_LIMIT,
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
    sendText: async (ctx) => {
      if (!ctx.silent) {
        let webhookSelected = false;
        try {
          const webhookResult = await maybeSendDiscordWebhookText({
            cfg: ctx.cfg,
            text: ctx.text,
            threadId: ctx.threadId,
            accountId: ctx.accountId,
            identity: ctx.identity,
            replyToId: ctx.replyToId,
            onPlatformSendDispatch: ctx.onPlatformSendDispatch
              ? async () => {
                  webhookSelected = true;
                  await ctx.onPlatformSendDispatch?.();
                }
              : undefined,
          });
          if (webhookResult) {
            return toDiscordOutboundDeliveryResult(webhookResult);
          }
        } catch (error) {
          if (webhookSelected) {
            throw error;
          }
          // Falling back to the plain bot send is intended (persona delivery is
          // best-effort), but the failure must stay operator-visible: a broken
          // webhook binding otherwise degrades every reply silently.
          log.warn("discord webhook persona send failed; falling back to bot send", { error });
        }
      }
      const { send, target, options } = await resolveDiscordOutboundMessageSend(ctx);
      return toDiscordOutboundDeliveryResult(await send(target, ctx.text, options));
    },
    sendMedia: async (ctx) => {
      const { send, target, options } = await resolveDiscordOutboundMessageSend(ctx);
      if (ctx.audioAsVoice && ctx.mediaUrl) {
        const sendVoice =
          resolveOutboundSendDep<DiscordVoiceSendFn>(ctx.deps, "discordVoice") ??
          (await loadDiscordSendRuntime()).sendVoiceMessageDiscord;
        return toDiscordOutboundDeliveryResult(
          await sendVoice(target, ctx.mediaUrl, {
            cfg: ctx.cfg,
            reply: options.reply,
            accountId: ctx.accountId ?? undefined,
            silent: ctx.silent ?? undefined,
            mediaAccess: ctx.mediaAccess,
            mediaLocalRoots: ctx.mediaLocalRoots,
            mediaReadFile: ctx.mediaReadFile,
            onPlatformSendDispatch: ctx.onPlatformSendDispatch,
          }),
        );
      }
      const mediaOptions = {
        ...options,
        mediaUrl: ctx.mediaUrl,
        mediaAccess: ctx.mediaAccess,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
      };
      if (ctx.text.trim() && ctx.mediaUrl && isLikelyDiscordVideoMedia(ctx.mediaUrl)) {
        const captionResult = await send(target, ctx.text, options);
        // Forum sends create their thread on the first message; the video belongs in that thread.
        const mediaTarget = captionResult.receipt?.threadId
          ? `channel:${captionResult.receipt.threadId}`
          : target;
        const mediaResult = await send(mediaTarget, "", {
          ...mediaOptions,
          reply: options.reply?.scope === "all" ? options.reply : undefined,
        });
        const threadId = captionResult.receipt?.threadId;
        return toDiscordOutboundDeliveryResult({
          ...(threadId ? captionResult : mediaResult),
          receipt: createDiscordSendReceiptFromResults({
            results: [captionResult, mediaResult],
            threadId,
          }),
        });
      }
      return toDiscordOutboundDeliveryResult(await send(target, ctx.text, mediaOptions));
    },
    sendPoll: async ({
      cfg,
      to,
      poll,
      content,
      accountId,
      threadId,
      silent,
      sessionKey,
      inboundEventKind,
      onPlatformSendDispatch,
    }) => {
      if (!createDiscordActionGate({ cfg, accountId })("polls")) {
        throw new Error("Discord polls are disabled.");
      }
      const outboundTo = resolveDiscordOutboundTarget({ to, threadId });
      const result = await (
        await loadDiscordSendRuntime()
      ).sendPollDiscord(outboundTo, poll, {
        accountId: accountId ?? undefined,
        content,
        threadId: threadId ?? undefined,
        silent: silent ?? undefined,
        cfg,
        onPlatformSendDispatch,
      });
      discordInboundEventDelivery.notify({
        sessionKey,
        inboundEventKind,
        to: outboundTo,
        accountId,
      });
      return result;
    },
  }),
  adoptTargetFromDelivery: ({ result }) => {
    const threadId = normalizeOptionalStringifiedId(result.receipt?.threadId);
    return threadId ? { threadId } : null;
  },
  afterDeliverPayload: async ({ cfg, target, payload, results }) => {
    notifyDiscordInboundEventOutboundPayloadSuccess({
      payload,
      to: resolveDiscordOutboundTarget({ to: target.to, threadId: target.threadId }),
      accountId: target.accountId,
    });
    const questionId = questionGatewayRuntime.readAskUserQuestionId(payload);
    const result = results.find(
      (candidate) => candidate.channel === "discord" && candidate.messageId,
    );
    const componentSpec = questionId ? await resolveDiscordComponentSpec(payload) : undefined;
    if (questionId && result && componentSpec) {
      const to = resolveDiscordOutboundTarget({ to: target.to, threadId: target.threadId });
      const channelId = result.target?.kind === "channel" ? result.target.id : to;
      questionGatewayRuntime.registerChannelDelivery({
        questionId,
        deliveryId: `discord:${target.accountId ?? "default"}:${channelId}:${result.messageId}`,
        finalize: async (statusLine) => {
          const { editDiscordComponentMessage } = await loadDiscordComponentSendRuntime();
          await editDiscordComponentMessage(
            to,
            result.messageId,
            {
              ...componentSpec,
              blocks: [
                ...(componentSpec.blocks ?? []).filter((block) => block.type !== "actions"),
                // Same markdown-inert display escaping approvals use; raw
                // option labels must not become live Discord markup/mentions.
                { type: "text", text: `-# ${formatDiscordApprovalDisplayValue(statusLine)}` },
              ],
              modal: undefined,
            },
            { cfg, accountId: target.accountId ?? undefined },
          );
        },
      });
    }
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
