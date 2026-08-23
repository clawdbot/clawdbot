import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
// Assembles the channel ownership policy from operator config so config validation and the
// operator-facing runtime schema pick the same channel owner plugin activation does.
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizePluginId } from "../plugins/config-state.js";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectAutoEnableConfiguredChannelIds,
  collectPluginIdsForConfiguredChannel,
} from "./channel-activation-candidates.js";
import {
  type ChannelOwnershipPolicy,
  collectChannelSchemaMetadataWithOwnership,
} from "./channel-config-metadata.js";
import { resolveChannelPreferOverIds } from "./plugin-auto-enable.prefer-over.js";
import {
  isPluginExplicitlySelectedByAlias,
  isPluginPolicyDisabled,
} from "./plugin-replacement-eligibility.js";
import { getGatewayAmbientEnvTriggerPolicy } from "./runtime-snapshot.js";
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
  /**
   * Must match what Gateway startup passes. `server-startup-bootstrap` defaults to `"suppress"`,
   * but `--ambient-channels` raises it to `"allow"` for the whole run, so a fixed default here
   * would disagree with activation on exactly the setups that opted in. Omitted callers fall back
   * to the policy the running Gateway recorded at startup, and only then to `"suppress"` for a
   * cold config file with no Gateway behind it.
   */
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): ChannelOwnershipPolicy {
  // Policy lists accept a plugin's channel ids and legacy ids; Gateway startup canonicalizes them
  // through the registry, so ownership has to resolve them the same way.
  const resolveAlias = createManifestPluginAliasResolver(params.registry);
  const sourceConfig = params.sourceConfig ?? params.config;

  // Explicit selection is keyed by whatever the OPERATOR wrote — a legacy id, a channel alias, a
  // padded or differently-cased variant — while Gateway startup normalizes those written keys
  // through its own resolver and runs the plugin. `isPluginExplicitlySelectedByAlias` canonicalizes
  // both sides, and auto-enable's preservation check now shares it, so the two cannot disagree
  // about whether the operator hand-picked a plugin.
  const canonicalId = (pluginId: string) => resolveAlias(normalizePluginId(pluginId));
  // Auto-enable's per-channel candidate set is what activation actually selects from. Once any
  // claimant declares `preferOver`, that set narrows to the declaring pair, so a third claimant is
  // never auto-enabled on that channel however close its origin sits. Ownership read only "not
  // policy-disabled" and could hand it the strict schema anyway, leaving the operator's config
  // validated against a plugin the runtime never loads.
  //
  // Read through the leaf contract rather than the auto-enable barrel: importing the barrel pulls
  // the plugin loader graph into an import cycle, and re-deriving the rule here would let it drift
  // from the one activation applies.
  //
  // Presence uses auto-enable's own decision, not an approximation of it. An authored-config-only
  // check looked safely conservative and was not: a channel configured purely through env vars is
  // one auto-enable narrows, so declining to narrow there kept the very defect this fixes — the
  // Control UI could offer a field from a claimant that never loads, and saving it would make the
  // config meaningful, flip ownership to the real pair, and reject the field just offered.
  let configuredChannelIds: Set<string> | undefined;
  const isChannelConfiguredForActivation = (channelId: string): boolean => {
    configuredChannelIds ??= new Set(
      collectAutoEnableConfiguredChannelIds(
        sourceConfig,
        params.env,
        undefined,
        params.ambientEnvTriggers ?? getGatewayAmbientEnvTriggerPolicy(),
      ),
    );
    return configuredChannelIds.has(channelId);
  };
  const candidatesByChannel = new Map<string, Set<string>>();
  const channelCandidates = (channelId: string): Set<string> | undefined => {
    const key = normalizeChatChannelId(channelId) ?? channelId;
    const cached = candidatesByChannel.get(key);
    if (cached) {
      return cached;
    }
    if (!isChannelConfiguredForActivation(key)) {
      return undefined;
    }
    const candidates = new Set(
      collectPluginIdsForConfiguredChannel(key, params.registry, params.env),
    );
    candidatesByChannel.set(key, candidates);
    return candidates;
  };

  return {
    isPluginActive: (pluginId, channelId) => {
      if (isPluginPolicyDisabled(params.config, pluginId, resolveAlias)) {
        return false;
      }
      const alias = canonicalId(pluginId);
      // An operator can activate a plugin by hand, which bypasses candidate discovery entirely:
      // `plugins.entries.<id>.enabled: true` is explicit activation at startup. Narrowing to the
      // auto-enable candidates alone would report such a claimant inactive while the runtime runs
      // it, which is the same disagreement in the other direction.
      if (isPluginExplicitlySelectedByAlias(sourceConfig, alias, canonicalId, params.registry)) {
        return true;
      }
      const candidates = channelCandidates(channelId);
      if (!candidates) {
        // The operator has not configured this channel, so activation materializes nothing to
        // narrow with. Policy disablement stays the only signal, as before.
        return true;
      }
      return candidates.has(pluginId) || candidates.has(alias);
    },
    isPluginExplicitlySelected: (pluginId) =>
      isPluginExplicitlySelectedByAlias(sourceConfig, pluginId, canonicalId, params.registry),
    isPluginPolicyDisabled: (pluginId) =>
      isPluginPolicyDisabled(params.config, pluginId, resolveAlias),
    resolveChannelPreferOverIds: (record, channelId) =>
      resolveChannelPreferOverIds({
        record,
        channelId,
        env: params.env,
        registry: params.registry,
      }),
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
