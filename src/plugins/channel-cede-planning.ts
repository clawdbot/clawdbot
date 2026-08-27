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
import { hasKind } from "./slots.js";

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
  declaredChannelClaimants: Map<string, string[]>;
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
  // With `plugins.slots.memory` unset, the runtime slot goes to whichever single-kind memory
  // plugin the load reaches FIRST (`loader-runtime-candidate.ts` sets `selectedMemoryPluginId` on
  // the first one and the `selectedId` arm of `resolveMemorySlotDecision` disables every later
  // one). Load order is not knowable from manifests and config alone, so a winner drawn from that
  // pool might be switched off after the claimants it displaced have already stood down, leaving
  // the configured channel with no owner. The unset slot is the only order-dependent case: a slot
  // that names a plugin, or is off, is decided by config and already filtered in
  // `channel-ownership-policy.ts`. Declining the cede keeps the first-registrant rule, which is
  // the same answer the runtime reaches on its own.
  // Only plugins that can actually take the slot in THIS load contend for it: one the operator
  // disabled, or one outside a scoped load, never reaches `resolveMemorySlotDecision` and cannot
  // displace anyone. Counting them made a deterministic contest look order-dependent and declined
  // a cede that should have stood, leaving the earlier claimant serving a channel schema ownership
  // had already moved.
  const memorySlotIsUnset = params.config.plugins?.slots?.memory === undefined;
  const singleKindMemoryIds = new Set(
    params.registry.plugins
      .filter(
        (entry) =>
          hasKind(entry.kind, "memory") &&
          !(Array.isArray(entry.kind) && entry.kind.length > 1) &&
          !policy.isPluginPolicyDisabled(entry.id) &&
          matchesScopedPluginOrDreamingSidecar({
            onlyPluginIdSet: params.onlyPluginIdSet,
            pluginId: entry.id,
            sidecar: params.dreamingSidecar,
          }),
      )
      .map((entry) => entry.id),
  );
  const memorySlotIsContested = memorySlotIsUnset && singleKindMemoryIds.size > 1;
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
    // The winner may lose the unset memory slot to a claimant the load happens to reach first.
    if (memorySlotIsContested && singleKindMemoryIds.has(cededTo)) {
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
  // Who may register a channel some manifest declares a replacement for. Scoped to channels a
  // declaration reaches, because that is what this plan reasons about: a channel whose claimants
  // declare nothing between them keeps the first-registrant rule the runtime has always applied.
  // The claimant COUNT is deliberately not part of that test. A replacement can be the only
  // manifest claimant and still declare `preferOver` for a namesake that registers the channel
  // without claiming it, and requiring two claimants left exactly that channel unguarded: the
  // namesake registered first and kept a channel schema ownership had given to the replacement.
  // Set-aside declarations are included deliberately -- they resolve to no winner, so
  // `cededChannelOwners` has no entry, but the claimants are still the only plugins entitled to
  // the channel, and an operator who hand-picks a claimant must not get less protection than one
  // who lets auto-enable decide.
  const declaredChannelClaimants = new Map<string, string[]>();
  for (const [claimedId, claimants] of claimantsByChannel) {
    const declaresReplacement = claimants.some((claimantId) => {
      const claimant = params.registry.plugins.find((entry) => entry.id === claimantId);
      return claimant ? policy.resolveChannelPreferOverIds(claimant, claimedId).length > 0 : false;
    });
    if (declaresReplacement) {
      declaredChannelClaimants.set(claimedId, claimants);
    }
  }
  return { cededChannelIdsByPlugin, cededChannelOwners, declaredChannelClaimants };
}
