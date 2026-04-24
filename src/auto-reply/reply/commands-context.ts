import { normalizeAnyChannelId } from "../../channels/registry.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { resolveCommandAuthorization } from "../command-auth.js";
import { normalizeCommandBody } from "../commands-registry-normalize.js";
import type { MsgContext } from "../templating.js";
import type { CommandContext } from "./commands-types.js";
import { stripMentions } from "./mentions.js";

export function buildCommandContext(params: {
  ctx: MsgContext;
  cfg: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  isGroup: boolean;
  triggerBodyNormalized: string;
  commandAuthorized: boolean;
}): CommandContext {
  const { ctx, cfg, agentId, sessionKey, isGroup, triggerBodyNormalized } = params;
  const auth = resolveCommandAuthorization({
    ctx,
    cfg,
    commandAuthorized: params.commandAuthorized,
  });
  const surface = normalizeLowercaseStringOrEmpty(ctx.Surface ?? ctx.Provider);
  const channel = normalizeLowercaseStringOrEmpty(
    ctx.OriginatingChannel ?? ctx.Provider ?? surface,
  );
  const from = auth.from ?? normalizeOptionalString(ctx.SenderId);
  const to = auth.to ?? normalizeOptionalString(ctx.OriginatingTo);
  const abortKey = sessionKey ?? from ?? to;
  const channelId =
    normalizeAnyChannelId(channel) ??
    (channel ? (channel as CommandContext["channelId"]) : undefined);
  const rawBodyNormalized = triggerBodyNormalized;
  const commandBodyNormalized = normalizeCommandBody(
    isGroup ? stripMentions(rawBodyNormalized, ctx, cfg, agentId) : rawBodyNormalized,
    { botUsername: ctx.BotUsername },
  );

  return {
    surface,
    channel,
    channelId: channelId ?? auth.providerId,
    ownerList: auth.ownerList,
    senderIsOwner: auth.senderIsOwner,
    isAuthorizedSender: auth.isAuthorizedSender,
    senderId: auth.senderId,
    abortKey,
    rawBodyNormalized,
    commandBodyNormalized,
    from,
    to,
  };
}
