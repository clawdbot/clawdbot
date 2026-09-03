// Line plugin module implements channel.setup behavior.
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { lineChannelPluginCommon } from "./channel-shared.js";
import { lineSetupContract } from "./setup-core.js";
import { lineSetupWizard } from "./setup-surface.js";
import type { ResolvedLineAccount } from "./types.js";

export const lineSetupPlugin: ChannelPlugin<ResolvedLineAccount> = {
  id: "line",
  ...lineChannelPluginCommon,
  setupWizard: lineSetupWizard,
  setupContract: lineSetupContract,
};
