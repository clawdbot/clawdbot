import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
// Assembles the channel ownership policy from operator config so config validation and the
// operator-facing runtime schema pick the same channel owner plugin activation does.
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizePluginsConfig } from "../plugins/config-state.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  collectAutoEnableConfiguredChannelIds,
  collectConfiguredChannelCandidateSet,
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
   * and policy disablement must be read from it: auto-enable writes `plugins.entries.<id>.enabled`
   * for the plugins it turns on and for a replacement chain's displaced middle claimant, so
   * reading the materialized config would report every auto-enabled plugin as hand-picked and a
   * synthesized disable as operator policy. `disableImplicitPreferredOverPlugin` checks its own
   * `originalConfig` for the same reason. Defaults to `config` for callers that validate a raw
   * config file.
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
  //
  // Explicit selection is keyed by whatever the OPERATOR wrote — a legacy id, a channel alias, a
  // padded or differently-cased variant — while Gateway startup normalizes those written keys
  // through its own resolver and runs the plugin. `isPluginExplicitlySelectedByAlias` canonicalizes
  // both sides, and auto-enable's preservation check now shares it, so the two cannot disagree
  // about whether the operator hand-picked a plugin. The resolver must see the written id before
  // any built-in legacy fold: startup pre-seeds exact installed ids, so an installed plugin whose
  // manifest id IS a fold key ("minimax-portal") would otherwise have its policy attributed to
  // the bundled owner the fold names.
  const canonicalId = createManifestPluginAliasResolver(params.registry);
  const sourceConfig = params.sourceConfig ?? params.config;
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
  // Candidacy is what auto-enable SELECTS, not everything startup LOADS. The shared activation
  // contract (`resolvePluginActivationDecisionShared`) also enables plugins no candidate set ever
  // names: an installed config/global plugin with no adverse policy and a bundled plugin with
  // default enablement load anyway and register their claimed channels.
  // `isActivatedManifestOwner` is that decision without the auto-enable arm, read from the
  // effective config like `isPluginActive`'s policy check: a claimant only candidacy would load
  // stays inactive, while one the runtime serves regardless stays active.
  let normalizedPluginsPolicy: ReturnType<typeof normalizePluginsConfig> | undefined;
  // Memoized like `configuredChannelIds` and `candidatesByChannel`: the displacement walk's
  // fixpoint asks per claimant per pass, so a linear registry scan per call is quadratic on large
  // registries. First manifest record per canonical id wins, matching the `.find` it replaces,
  // and the per-alias answer is cached because the walk re-asks for the same claimant.
  let recordByCanonicalId: Map<string, PluginManifestRecord> | undefined;
  const activatedWithoutCandidacyByAlias = new Map<string, boolean>();
  const isActivatedWithoutCandidacy = (canonicalPluginId: string): boolean => {
    const cached = activatedWithoutCandidacyByAlias.get(canonicalPluginId);
    if (cached !== undefined) {
      return cached;
    }
    if (recordByCanonicalId === undefined) {
      recordByCanonicalId = new Map();
      for (const plugin of params.registry.plugins) {
        const key = canonicalId(plugin.id);
        if (!recordByCanonicalId.has(key)) {
          recordByCanonicalId.set(key, plugin);
        }
      }
    }
    const record = recordByCanonicalId.get(canonicalPluginId);
    let activated = false;
    if (record) {
      normalizedPluginsPolicy ??= normalizePluginsConfig(params.config.plugins);
      activated = isActivatedManifestOwner({
        plugin: record,
        normalizedConfig: normalizedPluginsPolicy,
        rootConfig: params.config,
      });
    }
    activatedWithoutCandidacyByAlias.set(canonicalPluginId, activated);
    return activated;
  };
  const candidatesByChannel = new Map<
    string,
    { ids: Set<string>; narrowedByDeclaration: boolean }
  >();
  const channelCandidates = (
    channelId: string,
  ): { ids: Set<string>; narrowedByDeclaration: boolean } | undefined => {
    const key = normalizeChatChannelId(channelId) ?? channelId;
    const cached = candidatesByChannel.get(key);
    if (cached) {
      return cached;
    }
    if (!isChannelConfiguredForActivation(key)) {
      return undefined;
    }
    const candidateSet = collectConfiguredChannelCandidateSet(key, params.registry, params.env);
    const candidates = {
      ids: new Set(candidateSet.pluginIds),
      narrowedByDeclaration: candidateSet.narrowedByDeclaration,
    };
    candidatesByChannel.set(key, candidates);
    return candidates;
  };

  return {
    isPluginActive: (pluginId, channelId) => {
      if (isPluginPolicyDisabled(params.config, pluginId, canonicalId, params.registry)) {
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
      if (candidates.ids.has(pluginId) || candidates.ids.has(alias)) {
        return true;
      }
      // Once a claimant declares `preferOver`, the loader normally cedes the other claimants'
      // registrations to the channel's computed winner — a registration survives only when the
      // winner is inactive or outside a scoped load, or the pair's declaration was set aside —
      // so on a declared channel the candidate set is the closest static proxy for the serving
      // set, and everything outside it is treated as inactive however it loads.
      if (candidates.narrowedByDeclaration) {
        return false;
      }
      // With nothing declared there are no cedes at all: the channel goes to whichever loaded
      // claimant registers, and the unnarrowed candidate set names only the claim auto-enable
      // would turn on — it never asks whether that claimant is disabled. Equating the two
      // reported the default-loaded fallback inactive exactly when the first claim is
      // policy-disabled, and validation kept the disabled claimant's strict schema for a channel
      // the fallback serves.
      return isActivatedWithoutCandidacy(alias);
    },
    isPluginExplicitlySelected: (pluginId) =>
      isPluginExplicitlySelectedByAlias(sourceConfig, pluginId, canonicalId, params.registry),
    // Authored policy only, like explicit selection: auto-enable synthesizes `enabled: false` for
    // the displaced middle of a replacement chain, and reading that back as operator intent kept
    // the middle claimant's edge from propagating — runtime ownership fell through to the third
    // claimant while validation of the raw config closed the chain and selected the head.
    // `isPluginActive` above keeps the effective config: a synthesized disable really does keep
    // the plugin from loading.
    isPluginPolicyDisabled: (pluginId) =>
      isPluginPolicyDisabled(sourceConfig, pluginId, canonicalId, params.registry),
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
