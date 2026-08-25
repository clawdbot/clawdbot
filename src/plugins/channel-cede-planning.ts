/**
 * Cede planning for contested channels, on manifest and config metadata alone.
 *
 * Deliberately a leaf: Gateway config reload needs this answer on a cold control-plane path, and
 * importing it from the runtime loader made ESM evaluate that module's whole runtime graph — the
 * context-engine registry, the global hook runner, the memory dreaming runtime and the active
 * plugin registry — none of which reload ownership reads.
 */
import { collectRuntimeChannelOwnership } from "../config/channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "../config/channel-ownership-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeCededChannelId } from "./channel-validation.js";
import type { PluginManifestRegistry } from "./manifest-registry.js";

export type AuthorizedDreamingSidecar = {
  engineId: string;
  selectedMemoryPluginId: string;
};

export function matchesScopedPluginOrDreamingSidecar(params: {
  onlyPluginIdSet: ReadonlySet<string> | null;
  pluginId: string;
  sidecar: AuthorizedDreamingSidecar | null;
}): boolean {
  if (!params.onlyPluginIdSet || params.onlyPluginIdSet.has(params.pluginId)) {
    return true;
  }
  return (
    params.pluginId === params.sidecar?.engineId &&
    params.onlyPluginIdSet.has(params.sidecar.selectedMemoryPluginId)
  );
}

/**
 * Which channels each plugin has ceded to a preferred replacement, keyed by plugin id, plus the
 * claimant each ceded channel went to, keyed by canonical channel id.
 *
 * Displacement and the per-channel winner here are the rule channel schema ownership applies —
 * declared replacement wins, a hand-selected claimant is never displaced — read over the runtime
 * claimant set, where a bare `record.channels` claim serves a channel with or without a schema
 * descriptor. Sharing the rule is what keeps the runtime owner and the validated schema the same
 * plugin by construction; a second registration-time answer would leave the two free to disagree,
 * which is the defect this whole path exists to close.
 *
 * A cede only stands when a claimant it yields to is part of this load. Schema ownership is
 * computed from the whole manifest registry, but a scoped load can contain the ceding plugin
 * without the preferred claimant, and skipping registration then would strand the channel with no
 * runtime owner at all instead of the fallback that served it.
 *
 * Built once per load: the policy resolves preferences from the manifest, the built-in channel
 * registration, and any external catalog, and the map is small — a plugin cedes nothing on a
 * channel unless some claimant declared a preference there.
 */
export function collectCededChannelIdsByPlugin(params: {
  registry: PluginManifestRegistry;
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  onlyPluginIdSet: ReadonlySet<string> | null;
  dreamingSidecar: AuthorizedDreamingSidecar | null;
}): {
  cededChannelIdsByPlugin: Map<string, string[]>;
  cededChannelOwners: Map<string, string>;
} {
  const policy = createConfiguredChannelOwnershipPolicy({
    config: params.config,
    sourceConfig: params.sourceConfig,
    registry: params.registry,
    env: params.env,
  });
  const { displaced, winners, isPairSuppressed } = collectRuntimeChannelOwnership(
    params.registry,
    policy,
  );
  const claimantsByChannel = new Map<string, string[]>();
  for (const record of params.registry.plugins) {
    for (const channelId of record.channels) {
      const claimedId = normalizeCededChannelId(channelId);
      const claimants = claimantsByChannel.get(claimedId) ?? [];
      claimantsByChannel.set(claimedId, claimants);
      claimants.push(record.id);
    }
  }
  const cededChannelIdsByPlugin = new Map<string, string[]>();
  const cededChannelOwners = new Map<string, string>();
  for (const [channelId, pluginIds] of displaced) {
    const claimedId = normalizeCededChannelId(channelId);
    // The channel goes to the winner schema ownership computed — the same claimant validation and
    // the Control UI name — and only when this load can register it. The winner is inactive only
    // in the all-claimants-inactive state, where nothing registers and no cede should stand; a
    // winner outside a scoped load must not collect cedes either, or the load strands the channel
    // with no runtime owner instead of the fallback that served it.
    const winner = winners.get(channelId);
    const cededTo =
      winner !== undefined &&
      policy.isPluginActive(winner, claimedId) &&
      matchesScopedPluginOrDreamingSidecar({
        onlyPluginIdSet: params.onlyPluginIdSet,
        pluginId: winner,
        sidecar: params.dreamingSidecar,
      })
        ? winner
        : undefined;
    if (cededTo === undefined) {
      continue;
    }
    cededChannelOwners.set(claimedId, cededTo);
    // Every claimant that is not the winner cedes here, not only the ids the declaration
    // displaced. Independent declarations (A replaces B, C replaces D) leave two active,
    // undisplaced claimants; ceding only the displaced ids let registration order pick between
    // them while schema ownership named its one winner, the exact two-plane split this map exists
    // to close. The displaced ids stay ceded unconditionally because the pair's named target
    // remains an activation candidate, and reading activity alone would hand it back the very
    // channel the declaration takes away. One exemption: a claimant whose declaration with the
    // winner was set aside — a preferOver cycle member or a pair whose target the operator
    // selected — must keep registering, because a set-aside declaration displaces nobody: every
    // member registers and the first registrant keeps the channel. Ceding it would displace the
    // very claimant the suppression exists to protect.
    const cedingPluginIds = new Set(pluginIds);
    for (const claimantId of claimantsByChannel.get(claimedId) ?? []) {
      if (claimantId === cededTo) {
        continue;
      }
      if (
        policy.isPluginActive(claimantId, claimedId) &&
        isPairSuppressed(channelId, cededTo, claimantId)
      ) {
        continue;
      }
      cedingPluginIds.add(claimantId);
    }
    for (const pluginId of cedingPluginIds) {
      const channels = cededChannelIdsByPlugin.get(pluginId) ?? [];
      cededChannelIdsByPlugin.set(pluginId, channels);
      channels.push(channelId);
    }
  }
  return { cededChannelIdsByPlugin, cededChannelOwners };
}
