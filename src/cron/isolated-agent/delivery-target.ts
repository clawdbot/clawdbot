import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { ChannelId } from "../../channels/plugins/types.js";
import { DEFAULT_CHAT_CHANNEL } from "../../channels/registry.js";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveAgentMainSessionKey,
  resolveStorePath,
} from "../../config/sessions.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import type { OutboundChannel } from "../../infra/outbound/targets.js";
import { resolveOutboundTarget } from "../../infra/outbound/targets.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";

export async function resolveDeliveryTarget(
  cfg: ClawdbotConfig,
  agentId: string,
  jobPayload: {
    channel?: "last" | ChannelId;
    to?: string;
  },
): Promise<{
  channel: Exclude<OutboundChannel, "none">;
  to?: string;
  accountId?: string;
  mode: "explicit" | "implicit";
  error?: Error;
}> {
  const requestedRaw =
    typeof jobPayload.channel === "string" ? jobPayload.channel : "last";
  const requestedChannelHint =
    normalizeMessageChannel(requestedRaw) ?? requestedRaw;
  const explicitTo =
    typeof jobPayload.to === "string" && jobPayload.to.trim()
      ? jobPayload.to.trim()
      : undefined;

  const sessionCfg = cfg.session;
  const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
  const storePath = resolveStorePath(sessionCfg?.store, { agentId });
  const store = loadSessionStore(storePath);
  const main = store[mainSessionKey];
  const lastChannel =
    main?.lastChannel && main.lastChannel !== INTERNAL_MESSAGE_CHANNEL
      ? normalizeChannelId(main.lastChannel)
      : undefined;
  const lastTo = typeof main?.lastTo === "string" ? main.lastTo.trim() : "";
  const lastAccountId = main?.lastAccountId;

  let channel: Exclude<OutboundChannel, "none"> | undefined =
    requestedChannelHint === "last"
      ? (lastChannel ?? undefined)
      : requestedChannelHint === INTERNAL_MESSAGE_CHANNEL
        ? undefined
        : (normalizeChannelId(requestedChannelHint) ?? undefined);
  if (!channel) {
    try {
      const selection = await resolveMessageChannelSelection({ cfg });
      channel = selection.channel;
    } catch {
      channel = lastChannel ?? DEFAULT_CHAT_CHANNEL;
    }
  }

  const toCandidate = explicitTo ?? (lastTo || undefined);
  const mode: "explicit" | "implicit" = explicitTo ? "explicit" : "implicit";
  if (!toCandidate) {
    return { channel, to: undefined, accountId: lastAccountId, mode };
  }

  const resolved = resolveOutboundTarget({
    channel,
    to: toCandidate,
    cfg,
    accountId: channel === lastChannel ? lastAccountId : undefined,
    mode,
  });
  return {
    channel,
    to: resolved.ok ? resolved.to : undefined,
    accountId: channel === lastChannel ? lastAccountId : undefined,
    mode,
    error: resolved.ok ? undefined : resolved.error,
  };
}
