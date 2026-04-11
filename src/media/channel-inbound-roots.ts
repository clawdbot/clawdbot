import type { MsgContext } from "../auto-reply/templating.js";
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import type { OpenClawConfig } from "../config/types.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";

function findChannelMessagingAdapter(channelId?: string | null) {
  const normalized = normalizeOptionalLowercaseString(channelId);
  if (!normalized) {
    return undefined;
  }
  return getBootstrapChannelPlugin(normalized)?.messaging;
}

export function resolveChannelInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}

export function resolveChannelRemoteInboundAttachmentRoots(params: {
  cfg: OpenClawConfig;
  ctx: MsgContext;
}): readonly string[] | undefined {
  const messaging = findChannelMessagingAdapter(params.ctx.Surface ?? params.ctx.Provider);
  return messaging?.resolveRemoteInboundAttachmentRoots?.({
    cfg: params.cfg,
    accountId: params.ctx.AccountId,
  });
}
