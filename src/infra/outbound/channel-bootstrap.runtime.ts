import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DeliverableMessageChannel } from "../../utils/message-channel.js";

export function resetOutboundChannelBootstrapStateForTests(): void {
  // Runtime channel plugins are loaded during Gateway startup now.
}

export function bootstrapOutboundChannelPlugin(params: {
  channel: DeliverableMessageChannel;
  cfg?: OpenClawConfig;
}): void {
  void params;
}
