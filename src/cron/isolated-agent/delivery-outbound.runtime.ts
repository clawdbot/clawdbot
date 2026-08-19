// Runtime outbound-delivery seam for isolated cron agent delivery dispatch.
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { createChannelReplyTransform } from "../../channels/message/reply-transform.js";
import { getLoadedChannelPluginForRead } from "../../channels/plugins/registry-loaded.js";
import { normalizeAnyChannelId } from "../../channels/registry-normalize.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export { createOutboundSendDeps } from "../../cli/outbound-send-deps.js";
export {
  durableMessageBatchMayHaveReachedRecipient,
  sendDurableMessageBatchCore,
} from "../../channels/message/runtime.js";
export { type OutboundDeliveryResult } from "../../infra/outbound/deliver.js";
export { resolveAgentOutboundIdentity } from "../../infra/outbound/identity.js";
export { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
export { enqueueSystemEvent } from "../../infra/system-events.js";

export function resolveCronChannelReplyTransform(params: {
  channel: string;
  cfg: OpenClawConfig;
  accountId?: string;
}): { apply: (payload: ReplyPayload) => ReplyPayload | null } | undefined {
  const channelId = normalizeAnyChannelId(params.channel) ?? params.channel;
  const messaging = getLoadedChannelPluginForRead(channelId)?.messaging;
  const transform = createChannelReplyTransform({ ...params, messaging });
  return transform ? { apply: transform } : undefined;
}
