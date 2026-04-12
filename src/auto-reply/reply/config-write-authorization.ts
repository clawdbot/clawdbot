import {
  authorizeConfigWrite,
  canBypassConfigWritePolicy,
  formatConfigWriteDeniedMessage,
} from "../../channels/plugins/config-writes.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveConfigWriteDeniedText(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  channelId: ChannelId | null;
  accountId?: string;
  gatewayClientScopes?: string[];
  target: Parameters<typeof authorizeConfigWrite>[0]["target"];
}): string | null {
  const writeAuth = authorizeConfigWrite({
    cfg: params.cfg,
    origin: { channelId: params.channelId, accountId: params.accountId },
    target: params.target,
    allowBypass: canBypassConfigWritePolicy({
      channel: params.channel ?? "",
      gatewayClientScopes: params.gatewayClientScopes,
    }),
  });
  if (writeAuth.allowed) {
    return null;
  }
  return formatConfigWriteDeniedMessage({
    result: writeAuth,
    fallbackChannelId: params.channelId,
  });
}
