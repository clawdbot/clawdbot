// Small channel config mutators used by guided and non-interactive channel add flows.
import { getChannelPlugin } from "../../channels/plugins/index.js";
import { resolveChannelSetupExecutionAdapter } from "../../channels/plugins/setup-contract.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAccountId } from "../../routing/session-key.js";

type ChatChannel = ChannelId;

/** Apply a display name to a channel account when the plugin supports account naming. */
export function applyAccountName(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  accountId: string;
  name?: string;
  plugin?: ChannelPlugin;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = params.plugin ?? getChannelPlugin(params.channel);
  const apply = plugin ? resolveChannelSetupExecutionAdapter(plugin)?.applyAccountName : undefined;
  return apply ? apply({ cfg: params.cfg, accountId, name: params.name }) : params.cfg;
}

/** Delegate account config mutation to the channel plugin setup contract. */
export function applyChannelAccountConfig(params: {
  cfg: OpenClawConfig;
  channel: ChatChannel;
  accountId: string;
  input: unknown;
  plugin?: ChannelPlugin;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const plugin = params.plugin ?? getChannelPlugin(params.channel);
  const apply = plugin
    ? resolveChannelSetupExecutionAdapter(plugin)?.applyAccountConfig
    : undefined;
  if (!apply) {
    return params.cfg;
  }
  return apply({ cfg: params.cfg, accountId, input: params.input });
}
