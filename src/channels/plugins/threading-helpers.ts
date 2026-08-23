/**
 * Channel threading resolver helpers.
 *
 * Builds reply-to-mode resolvers from static, top-level, or account-scoped config.
 */
import type { ReplyToMode } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelThreadingAdapter } from "./types.core.js";

type ReplyToModeResolver = NonNullable<ChannelThreadingAdapter["resolveReplyToMode"]>;

/**
 * Creates a reply-to-mode resolver that always returns one mode.
 */
export function createStaticReplyToModeResolver(mode: ReplyToMode): ReplyToModeResolver {
  return () => mode;
}

/**
 * Creates a resolver that reads reply-to mode from top-level channel config.
 */
export function createTopLevelChannelReplyToModeResolver(channelId: string): ReplyToModeResolver {
  return ({ cfg }) => {
    const channelConfig = (
      cfg.channels as Record<string, { replyToMode?: ReplyToMode }> | undefined
    )?.[channelId];
    return channelConfig?.replyToMode ?? "off";
  };
}

/**
 * Creates a resolver that reads reply-to mode from account-scoped config.
 */
export function createScopedAccountReplyToModeResolver<TAccount>(params: {
  resolveAccount: (cfg: OpenClawConfig, accountId?: string | null) => TAccount;
  resolveReplyToMode: (
    account: TAccount,
    chatType?: string | null,
  ) => ReplyToMode | null | undefined;
  fallback?: ReplyToMode;
}): ReplyToModeResolver {
  return ({ cfg, accountId, chatType }) =>
    params.resolveReplyToMode(params.resolveAccount(cfg, accountId), chatType) ??
    params.fallback ??
    "off";
}
