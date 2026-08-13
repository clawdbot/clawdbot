// Assembles the channel ownership policy from operator config so config validation and the
// operator-facing runtime schema pick the same channel owner plugin activation does.
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { ChannelOwnershipPolicy } from "./channel-config-metadata.js";
import { resolveChannelPreferOverIds } from "./plugin-auto-enable.prefer-over.js";
import {
  isPluginExplicitlySelected,
  isPluginPolicyDisabled,
} from "./plugin-replacement-eligibility.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function createConfiguredChannelOwnershipPolicy(params: {
  config: OpenClawConfig;
  registry: PluginManifestRegistry;
  env: NodeJS.ProcessEnv;
}): ChannelOwnershipPolicy {
  // Policy lists accept a plugin's channel ids and legacy ids; Gateway startup canonicalizes them
  // through the registry, so ownership has to resolve them the same way.
  const resolveAlias = createManifestPluginAliasResolver(params.registry);
  return {
    isPluginActive: (pluginId) => !isPluginPolicyDisabled(params.config, pluginId, resolveAlias),
    isPluginExplicitlySelected: (pluginId) =>
      isPluginExplicitlySelected(params.config, resolveAlias(pluginId)),
    resolveChannelPreferOverIds: (record, channelId) =>
      resolveChannelPreferOverIds({ record, channelId, env: params.env }),
  };
}
