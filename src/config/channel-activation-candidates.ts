// The per-channel candidate set activation selects from, as a leaf contract.
//
// Auto-enable owns activation, but channel schema ownership has to agree with it: a claimant
// activation never selects must not supply the schema an operator's config is validated against.
// Both sides import this module rather than one importing the other, because routing ownership
// through the auto-enable barrel drags the whole plugin loader graph into an import cycle, and a
// second copy of the rule would be free to drift from the one activation actually applies.
import {
  type AmbientEnvTriggerPolicy,
  type ChannelPresenceSignalSource,
  listPotentialConfiguredChannelPresenceSignals,
} from "../channels/config-presence.js";
import {
  hasBundledChannelConfiguredState,
  listBundledChannelIdsWithConfiguredState,
} from "../channels/plugins/configured-state.js";
import { normalizeChatChannelId } from "../channels/registry.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { createManifestPluginAliasResolver } from "../plugins/manifest-plugin-alias.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { isChannelConfigured } from "./channel-configured.js";
import { resolveChannelPreferOverIds } from "./plugin-auto-enable.prefer-over.js";
import type { OpenClawConfig } from "./types.openclaw.js";

export function normalizeManifestChannelId(channelId: string): string {
  return normalizeChatChannelId(channelId) ?? channelId;
}

export function collectPluginIdsForConfiguredChannel(
  channelId: string,
  registry: PluginManifestRegistry,
  env: NodeJS.ProcessEnv,
): string[] {
  const normalizedChannelId = normalizeManifestChannelId(channelId);
  const builtInId = normalizeChatChannelId(normalizedChannelId);
  const claims: Array<{ plugin: PluginManifestRecord; preferOver: readonly string[] }> = [];
  for (const record of registry.plugins) {
    if (
      (record.channels ?? []).some((id) => normalizeManifestChannelId(id) === normalizedChannelId)
    ) {
      claims.push({
        plugin: record,
        // Every source auto-enable honors, not just `channelConfigs`: a catalog-declared
        // replacement has to reach the preferOver filter below or it is never a candidate, and
        // channel schema ownership resolves the same facts.
        preferOver: resolveChannelPreferOverIds({
          record,
          channelId: normalizedChannelId,
          env,
          registry,
        }),
      });
    }
  }

  if (claims.length === 0) {
    return builtInId ? [builtInId] : [];
  }

  // Claim ids and the ids a declaration names are both canonical here: `resolveChannelPreferOverIds`
  // resolves the declaration, and a manifest record's own id is already the canonical one.
  const resolveAlias = createManifestPluginAliasResolver(registry);
  const claimIds = new Set(claims.map((claim) => claim.plugin.id));
  if (builtInId) {
    claimIds.add(resolveAlias(builtInId));
  }
  const preferredIds = new Set<string>();
  for (const claim of claims) {
    for (const canonicalPreferredOverId of claim.preferOver) {
      // A claimant naming one of its own aliases resolves to itself. A manifest that names itself
      // declares nothing — `shouldSkipPreferredPluginAutoEnable` and the `channel-config-metadata.ts`
      // fixpoint both skip the self comparison — so reading it as a contest here narrowed the
      // candidates to that claimant alone and dropped the registry-first fallback.
      if (canonicalPreferredOverId === claim.plugin.id) {
        continue;
      }
      if (claimIds.has(canonicalPreferredOverId)) {
        // Keep both sides as candidates. The preferOver filter later disables
        // the lower-priority plugin unless the preferred plugin is explicitly
        // disabled/denied, preserving fallback to bundled channel support.
        preferredIds.add(claim.plugin.id);
        preferredIds.add(canonicalPreferredOverId);
      }
    }
  }

  if (preferredIds.size > 0) {
    return [...preferredIds].toSorted((left, right) => left.localeCompare(right));
  }
  return [claims[0]?.plugin.id ?? builtInId ?? normalizedChannelId];
}

function isAutoEnableConfiguredChannelSignal(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  channelId: string;
  source: ChannelPresenceSignalSource;
  configuredStateChannelIds: ReadonlySet<string>;
  discovery?: PluginDiscoveryResult;
}): boolean {
  if (
    params.source === "env" &&
    params.configuredStateChannelIds.has(params.channelId) &&
    !hasBundledChannelConfiguredState({
      channelId: params.channelId,
      cfg: params.cfg,
      env: params.env,
      discovery: params.discovery,
    })
  ) {
    return false;
  }
  return isChannelConfigured(params.cfg, params.channelId, params.env);
}

/** The channels auto-enable treats as configured — config, env, and persisted state alike. */
export function collectAutoEnableConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  discovery?: PluginDiscoveryResult,
  ambientEnvTriggers: AmbientEnvTriggerPolicy = "allow",
): string[] {
  const configuredStateChannelIds = new Set(listBundledChannelIdsWithConfiguredState(discovery));
  return listPotentialConfiguredChannelPresenceSignals(cfg, env, {
    includePersistedAuthState: false,
    discovery,
    ambientEnvTriggers,
  })
    .map((signal) => ({
      source: signal.source,
      channelId: normalizeChatChannelId(signal.channelId) ?? signal.channelId,
    }))
    .filter(({ channelId, source }) =>
      isAutoEnableConfiguredChannelSignal({
        cfg,
        env,
        channelId,
        source,
        configuredStateChannelIds,
        discovery,
      }),
    )
    .map(({ channelId }) => channelId);
}
