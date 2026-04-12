import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import { hasBundledChannelConfiguredState } from "../channels/plugins/configured-state.js";
import { hasBundledChannelPersistedAuthState } from "../channels/plugins/persisted-auth-state.js";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "./channel-configured-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId))) {
    return true;
  }
  if (hasBundledChannelConfiguredState({ channelId, cfg, env })) {
    return true;
  }
  const pluginPersistedAuthState = hasBundledChannelPersistedAuthState({ channelId, cfg, env });
  if (pluginPersistedAuthState) {
    return true;
  }
  const plugin = getBootstrapChannelPlugin(channelId);
  return Boolean(plugin?.config?.hasConfiguredState?.({ cfg, env }));
}
