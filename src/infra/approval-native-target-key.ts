import type { ChannelApprovalNativeTarget } from "../channels/plugins/approval-native.types.js";
import { channelRouteDedupeKey } from "../plugin-sdk/channel-route.js";

export function buildChannelApprovalNativeTargetKey(target: ChannelApprovalNativeTarget): string {
  return channelRouteDedupeKey({
    to: target.to,
    threadId: target.threadId,
  });
}
