// Discord plugin module implements inbound job behavior.
import {
  resolveDiscordChannelIdSafe,
  resolveDiscordChannelInfoSafe,
  resolveDiscordChannelNameSafe,
  resolveDiscordChannelParentSafe,
} from "./channel-access.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";

type DiscordInboundJobRuntimeField =
  | "runtime"
  | "abortSignal"
  | "guildHistories"
  | "client"
  | "threadBindings"
  // Function-backed feedback stays runtime-only; payload must remain
  // materializable data so queued jobs cannot accidentally serialize it.
  | "replyTypingFeedback"
  | "discordRestFetch";

type DiscordInboundJobRuntime = Pick<DiscordMessagePreflightContext, DiscordInboundJobRuntimeField>;

type DiscordInboundJobPayload = Omit<DiscordMessagePreflightContext, DiscordInboundJobRuntimeField>;

export type DiscordInboundJob = {
  queueKey: string;
  payload: DiscordInboundJobPayload;
  runtime: DiscordInboundJobRuntime;
  replayKeys?: string[];
};

export function resolveDiscordInboundJobQueueKey(ctx: DiscordMessagePreflightContext): string {
  // This key is both the run-queue serialization key and the typing prestart
  // dedupe key, so keep it aligned with the eventual session route.
  const sessionKey = ctx.route.sessionKey?.trim();
  if (sessionKey) {
    return sessionKey;
  }
  const baseSessionKey = ctx.baseSessionKey?.trim();
  if (baseSessionKey) {
    return baseSessionKey;
  }
  return ctx.messageChannelId;
}

export function buildDiscordInboundJob(
  ctx: DiscordMessagePreflightContext,
  options?: { replayKeys?: readonly string[] },
): DiscordInboundJob {
  const {
    runtime,
    abortSignal,
    guildHistories,
    client,
    threadBindings,
    replyTypingFeedback,
    discordRestFetch,
    message,
    data,
    threadChannel,
    ...payload
  } = ctx;

  const sanitizedMessage = sanitizeDiscordInboundMessage(message);
  return {
    queueKey: resolveDiscordInboundJobQueueKey(ctx),
    payload: {
      ...payload,
      message: sanitizedMessage,
      data: {
        ...data,
        message: sanitizedMessage,
      },
      threadChannel: normalizeDiscordThreadChannel(threadChannel),
    },
    runtime: {
      runtime,
      abortSignal,
      guildHistories,
      client,
      threadBindings,
      replyTypingFeedback,
      discordRestFetch,
    },
    replayKeys: options?.replayKeys ? [...options.replayKeys] : undefined,
  };
}

export function materializeDiscordInboundJob(
  job: DiscordInboundJob,
  abortSignal?: AbortSignal,
): DiscordMessagePreflightContext {
  return {
    ...job.payload,
    ...job.runtime,
    abortSignal: abortSignal ?? job.runtime.abortSignal,
  };
}

function sanitizeDiscordInboundMessage<T extends object>(message: T): T {
  const descriptors = Object.getOwnPropertyDescriptors(message);
  delete descriptors.channel;
  return Object.create(Object.getPrototypeOf(message), descriptors) as T;
}

function normalizeDiscordThreadChannel(
  threadChannel: DiscordMessagePreflightContext["threadChannel"],
): DiscordMessagePreflightContext["threadChannel"] {
  if (!threadChannel) {
    return null;
  }
  const channelInfo = resolveDiscordChannelInfoSafe(threadChannel);
  const parent = resolveDiscordChannelParentSafe(threadChannel);
  return {
    id: threadChannel.id,
    name: channelInfo.name,
    parentId: channelInfo.parentId,
    parent: parent
      ? {
          id: resolveDiscordChannelIdSafe(parent),
          name: resolveDiscordChannelNameSafe(parent),
        }
      : undefined,
    ownerId: channelInfo.ownerId,
  };
}
