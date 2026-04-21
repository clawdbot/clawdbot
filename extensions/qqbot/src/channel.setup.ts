import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { qqbotBasePluginFields } from "./channel-base.js";
import type { ResolvedQQBotAccount } from "./types.js";

/**
 * Setup-only QQBot plugin — lightweight subset used during `openclaw onboard`
 * and `openclaw configure` without pulling the full runtime dependencies.
 */
export const qqbotSetupPlugin: ChannelPlugin<ResolvedQQBotAccount> = {
  ...qqbotBasePluginFields,
};
