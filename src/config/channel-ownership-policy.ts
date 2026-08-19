// Assembles the channel ownership policy from operator config so config validation and the
// operator-facing runtime schema pick the same channel owner plugin activation does.
import { normalizeChatChannelId } from "../channels/registry.js";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  type ChannelOwnershipPolicy,
  collectChannelSchemaMetadataWithOwnership,
} from "./channel-config-metadata.js";
import { resolveChannelPreferOverIds } from "./plugin-auto-enable.prefer-over.js";
import { resolveConfiguredPluginAutoEnableCandidates } from "./plugin-auto-enable.shared.js";
import {
  isPluginExplicitlySelected,
  isPluginPolicyDisabled,
} from "./plugin-replacement-eligibility.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function createConfiguredChannelOwnershipPolicy(params: {
  config: OpenClawConfig;
  /**
   * The operator's own config, before auto-enable materializes plugin entries. Explicit selection
   * must be read from it: auto-enable writes `plugins.entries.<id>.enabled` for the plugins it
   * turns on, so reading the materialized config would report every auto-enabled plugin as
   * hand-picked and suppress the replacement rule entirely. `disableImplicitPreferredOverPlugin`
   * checks its own `originalConfig` for the same reason. Defaults to `config` for callers that
   * validate a raw config file.
   */
  sourceConfig?: OpenClawConfig;
  registry: PluginManifestRegistry;
  env: NodeJS.ProcessEnv;
}): ChannelOwnershipPolicy {
  // Policy lists accept a plugin's channel ids and legacy ids; Gateway startup canonicalizes them
  // through the registry, so ownership has to resolve them the same way.
  const resolveAlias = createManifestPluginAliasResolver(params.registry);
  const sourceConfig = params.sourceConfig ?? params.config;

  // Auto-enable's per-channel candidate set is what activation actually selects from. Once any
  // claimant declares `preferOver`, that set narrows to the declaring pair, so a third claimant is
  // never activated on that channel however close its origin sits. Ownership read only "not
  // policy-disabled" and could hand it the strict schema anyway, leaving the operator's config
  // validated against a plugin the runtime never loads.
  //
  // Built from `sourceConfig` for the reason above: the materialized config reports auto-enabled
  // plugins as hand-picked. Computed once on first use — a channel-scoped predicate is called per
  // claimant per channel, and candidate discovery walks the whole registry.
  let candidatesByChannel: Map<string, Set<string>> | undefined;
  const channelCandidates = (channelId: string): Set<string> | undefined => {
    if (!candidatesByChannel) {
      candidatesByChannel = new Map();
      for (const candidate of resolveConfiguredPluginAutoEnableCandidates({
        config: sourceConfig,
        env: params.env,
        registry: params.registry,
      })) {
        if (candidate.kind !== "channel-configured") {
          continue;
        }
        const key = normalizeChatChannelId(candidate.channelId) ?? candidate.channelId;
        const forChannel = candidatesByChannel.get(key) ?? new Set<string>();
        forChannel.add(candidate.pluginId);
        candidatesByChannel.set(key, forChannel);
      }
    }
    return candidatesByChannel.get(normalizeChatChannelId(channelId) ?? channelId);
  };

  return {
    isPluginActive: (pluginId, channelId) => {
      if (isPluginPolicyDisabled(params.config, pluginId, resolveAlias)) {
        return false;
      }
      const candidates = channelCandidates(channelId);
      if (!candidates) {
        // The operator has not configured this channel, so activation materializes nothing to
        // narrow with. Policy disablement stays the only signal, as before.
        return true;
      }
      return candidates.has(pluginId) || candidates.has(resolveAlias(pluginId));
    },
    isPluginExplicitlySelected: (pluginId) =>
      isPluginExplicitlySelected(sourceConfig, resolveAlias(pluginId)),
    resolveChannelPreferOverIds: (record, channelId) =>
      resolveChannelPreferOverIds({ record, channelId, env: params.env }),
  };
}

/**
 * Channel schema metadata for a config under validation. Validation must not build the ownership
 * policy itself: the policy module owns how explicit selection is read, and the file being
 * validated is its own source config because auto-enable has not materialized entries yet.
 */
export function configuredChannelSchemas(
  registry: PluginManifestRegistry,
  config: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
) {
  return collectChannelSchemaMetadataWithOwnership(
    registry,
    createConfiguredChannelOwnershipPolicy({ config, registry, env: env ?? process.env }),
  );
}
