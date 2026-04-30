import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveChunkMode, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveDiscordMaxLinesPerMessage } from "../accounts.js";
import type {
  ButtonInteraction,
  CommandInteraction,
  StringSelectMenuInteraction,
} from "../internal/discord.js";
import type { DispatchDiscordCommandInteractionResult } from "./native-command-dispatch.js";
import {
  deliverDiscordInteractionReply,
  hasRenderableReplyPayload,
} from "./native-command-reply.js";
import type { DiscordConfig } from "./native-command.types.js";

type ResolveDirectStatusReplyForSession = typeof resolveDirectStatusReplyForSession;

export async function maybeDeliverDiscordDirectStatus(params: {
  commandName: string;
  suppressReplies?: boolean;
  resolveDirectStatusReplyForSession: ResolveDirectStatusReplyForSession;
  cfg: OpenClawConfig;
  discordConfig: DiscordConfig;
  accountId: string;
  sessionKey: string;
  commandTargetSessionKey?: string | null;
  channel: "discord";
  senderId: string;
  senderIsOwner: boolean;
  isAuthorizedSender: boolean;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  interaction: CommandInteraction | ButtonInteraction | StringSelectMenuInteraction;
  mediaLocalRoots: readonly string[];
  preferFollowUp: boolean;
  responseEphemeral?: boolean;
  effectiveRoute: ResolvedAgentRoute;
  respond: (content: string, options?: { ephemeral?: boolean }) => Promise<void>;
}): Promise<DispatchDiscordCommandInteractionResult | null> {
  if (params.suppressReplies || params.commandName !== "status") {
    return null;
  }
  const statusReply = await params.resolveDirectStatusReplyForSession({
    cfg: params.cfg,
    sessionKey: params.commandTargetSessionKey?.trim() || params.sessionKey,
    channel: params.channel,
    senderId: params.senderId,
    senderIsOwner: params.senderIsOwner,
    isAuthorizedSender: params.isAuthorizedSender,
    isGroup: params.isGroup,
    defaultGroupActivation: params.defaultGroupActivation,
  });
  if (statusReply && hasRenderableReplyPayload(statusReply)) {
    await deliverDiscordInteractionReply({
      interaction: params.interaction,
      payload: statusReply,
      mediaLocalRoots: params.mediaLocalRoots,
      textLimit: resolveTextChunkLimit(params.cfg, "discord", params.accountId, {
        fallbackLimit: 2000,
      }),
      maxLinesPerMessage: resolveDiscordMaxLinesPerMessage({
        cfg: params.cfg,
        discordConfig: params.discordConfig,
        accountId: params.accountId,
      }),
      preferFollowUp: params.preferFollowUp,
      responseEphemeral: params.responseEphemeral,
      chunkMode: resolveChunkMode(params.cfg, "discord", params.accountId),
    });
    return { accepted: true, effectiveRoute: params.effectiveRoute };
  }
  await params.respond("Status unavailable.");
  return { accepted: true, effectiveRoute: params.effectiveRoute };
}
