// Qa Channel plugin module implements channel.setup behavior.
import type { ResolvedQaChannelAccount } from "./accounts.js";
import { createQaChannelPluginBase } from "./channel-base.js";
import type { ChannelPlugin } from "./runtime-api.js";

export const qaChannelSetupPlugin: ChannelPlugin<ResolvedQaChannelAccount> =
  createQaChannelPluginBase();
