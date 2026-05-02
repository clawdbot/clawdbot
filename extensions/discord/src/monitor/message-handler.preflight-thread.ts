import type { ChannelType } from "../internal/discord.js";
import {
  isPreflightAborted,
  loadDiscordThreadingRuntime,
} from "./message-handler.preflight-runtime.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import type { DiscordChannelInfo } from "./message-utils.js";

type DiscordPreflightThreadContext = {
  earlyThreadChannel: DiscordMessagePreflightContext["threadChannel"];
  earlyThreadParentId?: string;
  earlyThreadParentName?: string;
  earlyThreadParentType?: ChannelType;
};

export async function resolveDiscordPreflightThreadContext(params: {
  client: DiscordMessagePreflightContext["client"];
  isGuildMessage: boolean;
  message: DiscordMessagePreflightContext["message"];
  channelInfo: DiscordChannelInfo | null;
  messageChannelId: string;
  abortSignal?: AbortSignal;
}): Promise<DiscordPreflightThreadContext | null> {
  const { resolveDiscordThreadChannel, resolveDiscordThreadParentInfo } =
    await loadDiscordThreadingRuntime();
  const earlyThreadChannel = resolveDiscordThreadChannel({
    isGuildMessage: params.isGuildMessage,
    message: params.message,
    channelInfo: params.channelInfo,
    messageChannelId: params.messageChannelId,
  });
  if (!earlyThreadChannel) {
    return { earlyThreadChannel: null };
  }
  const parentInfo = await resolveDiscordThreadParentInfo({
    client: params.client,
    threadChannel: earlyThreadChannel,
    channelInfo: params.channelInfo,
  });
  if (isPreflightAborted(params.abortSignal)) {
    return null;
  }
  return {
    earlyThreadChannel,
    earlyThreadParentId: parentInfo.id,
    earlyThreadParentName: parentInfo.name,
    earlyThreadParentType: parentInfo.type,
  };
}
