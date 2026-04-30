import type { OpenClawConfig, ReplyToMode } from "openclaw/plugin-sdk/config-types";
import { resolveChannelModelOverride } from "openclaw/plugin-sdk/model-session-runtime";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/text-runtime";
import {
  ChannelType,
  createThread,
  editChannel,
  getChannelMessage,
  type Client,
} from "../internal/discord.js";
import { resolveDiscordMessageChannelId } from "./message-utils.js";
import { generateThreadTitle } from "./thread-title.js";
import { resolveDiscordReplyDeliveryPlan, sanitizeDiscordThreadName } from "./threading.starter.js";
import type {
  DiscordAutoThreadContext,
  DiscordAutoThreadReplyPlan,
  DiscordMessageEvent,
  MaybeCreateDiscordAutoThreadParams,
} from "./threading.types.js";

function resolveTrimmedDiscordMessageChannelId(params: {
  message: DiscordMessageEvent["message"];
  messageChannelId?: string;
}) {
  return (
    params.messageChannelId ||
    resolveDiscordMessageChannelId({
      message: params.message,
    })
  ).trim();
}

export function resolveDiscordAutoThreadContext(params: {
  agentId: string;
  channel: string;
  messageChannelId: string;
  createdThreadId?: string | null;
  parentInheritanceEnabled?: boolean;
}): DiscordAutoThreadContext | null {
  const createdThreadId = normalizeOptionalStringifiedId(params.createdThreadId) ?? "";
  if (!createdThreadId) {
    return null;
  }
  const messageChannelId = normalizeOptionalString(params.messageChannelId) ?? "";
  if (!messageChannelId) {
    return null;
  }

  const threadSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    peer: { kind: "channel", id: createdThreadId },
  });
  const parentSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel: params.channel,
    peer: { kind: "channel", id: messageChannelId },
  });

  return {
    createdThreadId,
    From: `${params.channel}:channel:${createdThreadId}`,
    To: `channel:${createdThreadId}`,
    OriginatingTo: `channel:${createdThreadId}`,
    SessionKey: threadSessionKey,
    ModelParentSessionKey: parentSessionKey,
    ...(params.parentInheritanceEnabled === true ? { ParentSessionKey: parentSessionKey } : {}),
  };
}

export async function resolveDiscordAutoThreadReplyPlan(
  params: MaybeCreateDiscordAutoThreadParams & {
    replyToMode: ReplyToMode;
    agentId: string;
    channel: string;
    cfg: OpenClawConfig;
    threadParentInheritanceEnabled?: boolean;
  },
): Promise<DiscordAutoThreadReplyPlan> {
  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  const targetChannelId = params.threadChannel?.id ?? (messageChannelId || "unknown");
  const originalReplyTarget = `channel:${targetChannelId}`;
  const createdThreadId = await maybeCreateDiscordAutoThread({
    client: params.client,
    message: params.message,
    messageChannelId: messageChannelId || undefined,
    channel: params.channel,
    isGuildMessage: params.isGuildMessage,
    channelConfig: params.channelConfig,
    threadChannel: params.threadChannel,
    channelType: params.channelType,
    channelName: params.channelName,
    channelDescription: params.channelDescription,
    baseText: params.baseText,
    combinedBody: params.combinedBody,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget: originalReplyTarget,
    replyToMode: params.replyToMode,
    messageId: params.message.id,
    threadChannel: params.threadChannel,
    createdThreadId,
  });
  const autoThreadContext = params.isGuildMessage
    ? resolveDiscordAutoThreadContext({
        agentId: params.agentId,
        channel: params.channel,
        messageChannelId,
        createdThreadId,
        parentInheritanceEnabled: params.threadParentInheritanceEnabled,
      })
    : null;
  return { ...deliveryPlan, createdThreadId, autoThreadContext };
}

export async function maybeCreateDiscordAutoThread(
  params: MaybeCreateDiscordAutoThreadParams,
): Promise<string | undefined> {
  if (!params.isGuildMessage) {
    return undefined;
  }
  if (!params.channelConfig?.autoThread) {
    return undefined;
  }
  if (params.threadChannel) {
    return undefined;
  }
  if (
    params.channelType === ChannelType.GuildForum ||
    params.channelType === ChannelType.GuildMedia ||
    params.channelType === ChannelType.GuildVoice ||
    params.channelType === ChannelType.GuildStageVoice
  ) {
    return undefined;
  }

  const messageChannelId = resolveTrimmedDiscordMessageChannelId(params);
  if (!messageChannelId) {
    return undefined;
  }
  try {
    const rawThreadSource = params.baseText || params.combinedBody || "Thread";
    const threadName = sanitizeDiscordThreadName(rawThreadSource, params.message.id);
    const archiveDuration = params.channelConfig?.autoArchiveDuration
      ? Number(params.channelConfig.autoArchiveDuration)
      : 60;

    const created = await createThread<{ id?: string }>(
      params.client.rest,
      messageChannelId,
      {
        body: {
          name: threadName,
          auto_archive_duration: archiveDuration,
        },
      },
      params.message.id,
    );
    const createdId = created?.id || "";
    if (
      createdId &&
      params.channelConfig?.autoThreadName === "generated" &&
      params.cfg &&
      params.agentId
    ) {
      const modelRef = resolveDiscordThreadTitleModelRef({
        cfg: params.cfg,
        channel: params.channel,
        agentId: params.agentId,
        threadId: createdId,
        messageChannelId,
        channelName: params.channelName,
      });
      void maybeRenameDiscordAutoThread({
        client: params.client,
        threadId: createdId,
        currentName: threadName,
        fallbackId: params.message.id,
        sourceText: rawThreadSource,
        modelRef,
        channelName: params.channelName,
        channelDescription: params.channelDescription,
        cfg: params.cfg,
        agentId: params.agentId,
      });
    }
    return createdId || undefined;
  } catch (err) {
    logVerbose(
      `discord: autoThread creation failed for ${messageChannelId}/${params.message.id}: ${String(err)}`,
    );
    try {
      const msg = (await getChannelMessage(
        params.client.rest,
        messageChannelId,
        params.message.id,
      )) as {
        thread?: { id?: string };
      };
      const existingThreadId = msg?.thread?.id || "";
      if (existingThreadId) {
        logVerbose(
          `discord: autoThread reusing existing thread ${existingThreadId} on ${messageChannelId}/${params.message.id}`,
        );
        return existingThreadId;
      }
    } catch {
      // If the refetch also fails, fall through to return undefined.
    }
    return undefined;
  }
}

function resolveDiscordThreadTitleModelRef(params: {
  cfg: OpenClawConfig;
  channel?: string;
  agentId: string;
  threadId: string;
  messageChannelId: string;
  channelName?: string;
}): string | undefined {
  const channel = params.channel?.trim();
  if (!channel) {
    return undefined;
  }
  const parentSessionKey = buildAgentSessionKey({
    agentId: params.agentId,
    channel,
    peer: { kind: "channel", id: params.messageChannelId },
  });
  const channelLabel = params.channelName?.trim();
  const groupChannel = channelLabel ? `#${channelLabel}` : undefined;
  const channelOverride = resolveChannelModelOverride({
    cfg: params.cfg,
    channel,
    groupId: params.threadId,
    groupChatType: "channel",
    groupChannel,
    groupSubject: groupChannel,
    parentSessionKey,
  });
  return channelOverride?.model;
}

async function maybeRenameDiscordAutoThread(params: {
  client: Client;
  threadId: string;
  currentName: string;
  fallbackId: string;
  sourceText: string;
  modelRef?: string;
  channelName?: string;
  channelDescription?: string;
  cfg: OpenClawConfig;
  agentId: string;
}): Promise<void> {
  try {
    const fallbackName = sanitizeDiscordThreadName("", params.fallbackId);
    const generated = await generateThreadTitle({
      cfg: params.cfg,
      agentId: params.agentId,
      messageText: params.sourceText,
      modelRef: params.modelRef,
      channelName: params.channelName,
      channelDescription: params.channelDescription,
    });
    if (!generated) {
      return;
    }
    const nextName = sanitizeDiscordThreadName(generated, params.fallbackId);
    if (!nextName || nextName === params.currentName || nextName === fallbackName) {
      return;
    }
    await editChannel(params.client.rest, params.threadId, {
      body: { name: nextName },
    });
  } catch (err) {
    logVerbose(`discord: autoThread rename failed for ${params.threadId}: ${String(err)}`);
  }
}
