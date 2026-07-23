// Line plugin module implements channel.setup behavior.
import type { ChannelPlugin, ResolvedLineAccount } from "./channel-api.js";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { lineSetupAdapter, lineSetupContract } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";

export const lineSetupPlugin: ChannelPlugin<ResolvedLineAccount> = {
  id: "line",
  ...lineChannelPluginCommon,
  setupWizard: lineSetupWizard,
  setup: lineSetupAdapter,
  setupContract: lineSetupContract,
};
