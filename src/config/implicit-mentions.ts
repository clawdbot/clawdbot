// Resolves channel implicit-mention policy across account, channel, and shared defaults.
import { resolveAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId } from "../routing/session-key.js";
import type { OpenClawConfig } from "./config.js";
import type { ChannelImplicitMentionsConfig } from "./types.channels.js";

export type ResolvedChannelImplicitMentions = Required<ChannelImplicitMentionsConfig>;

type ChannelImplicitMentionsSource = {
  implicitMentions?: ChannelImplicitMentionsConfig;
  accounts?: Record<string, { implicitMentions?: ChannelImplicitMentionsConfig }>;
};

const SHIPPED_IMPLICIT_MENTION_DEFAULTS: ResolvedChannelImplicitMentions = {
  replyToBot: true,
  quotedBot: true,
  threadParticipation: true,
};

/** Resolves each implicit-mention kind using account, channel, defaults, then shipped behavior. */
export function resolveChannelImplicitMentions(params: {
  cfg: OpenClawConfig;
  channel: string;
  accountId?: string | null;
}): ResolvedChannelImplicitMentions {
  const channelConfig = params.cfg.channels?.[params.channel] as
    | ChannelImplicitMentionsSource
    | undefined;
  const accountConfig = resolveAccountEntry(
    channelConfig?.accounts,
    normalizeAccountId(params.accountId),
  );
  const defaults = params.cfg.channels?.defaults?.implicitMentions;
  return {
    replyToBot:
      accountConfig?.implicitMentions?.replyToBot ??
      channelConfig?.implicitMentions?.replyToBot ??
      defaults?.replyToBot ??
      SHIPPED_IMPLICIT_MENTION_DEFAULTS.replyToBot,
    quotedBot:
      accountConfig?.implicitMentions?.quotedBot ??
      channelConfig?.implicitMentions?.quotedBot ??
      defaults?.quotedBot ??
      SHIPPED_IMPLICIT_MENTION_DEFAULTS.quotedBot,
    threadParticipation:
      accountConfig?.implicitMentions?.threadParticipation ??
      channelConfig?.implicitMentions?.threadParticipation ??
      defaults?.threadParticipation ??
      SHIPPED_IMPLICIT_MENTION_DEFAULTS.threadParticipation,
  };
}
