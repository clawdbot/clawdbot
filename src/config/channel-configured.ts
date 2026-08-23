// Determines whether a channel is configured from bootstrap and plugin state.
import { getBootstrapChannelPlugin } from "../channels/plugins/bootstrap-registry.js";
import { hasBundledChannelConfiguredState } from "../channels/plugins/configured-state.js";
import {
  hasMeaningfulChannelConfigShallow,
  resolveChannelConfigRecord,
} from "./channel-configured-shared.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Resolves whether a channel has enough config, env, or plugin state to be considered setup. */
export function isChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  // Treat explicit persisted config as configured before consulting channel-specific env/state
  // probes; user-authored config should win over inferred setup state.
  if (hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId))) {
    return true;
  }
  // Bundled channels can expose configured state through env vars or persisted credential files.
  if (hasBundledChannelConfiguredState({ channelId, cfg, env })) {
    return true;
  }
  // Bootstrap plugins cover channels that are available before full plugin registry loading.
  const plugin = getBootstrapChannelPlugin(channelId);
  return Boolean(plugin?.config?.hasConfiguredState?.({ cfg, env }));
}
