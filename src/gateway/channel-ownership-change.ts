import { listAgentWorkspaceDirs } from "../agents/workspace-dirs.js";
import { collectChannelSchemaMetadataWithOwnership } from "../config/channel-config-metadata.js";
import { createConfiguredChannelOwnershipPolicy } from "../config/channel-ownership-policy.js";
import { resolveConfigWidePluginManifestRegistry } from "../config/io.plugin-metadata.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectCededChannelIdsByPlugin } from "../plugins/channel-cede-planning.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";

/**
 * Whether an authored path is under the broad source surface guarded for ownership changes.
 * Every key under `plugins` or `channels`, plus either bare root, matches; the ownership comparison
 * decides whether a particular edit actually moved an owner.
 */
export function isChannelOwnershipSourcePath(path: string): boolean {
  return (
    path === "plugins" ||
    path === "channels" ||
    path.startsWith("plugins.") ||
    path.startsWith("channels.")
  );
}

type ChannelOwnersSnapshot = {
  /** Selected schema owner per channel; undefined when no claimant ships a descriptor. */
  schemaOwners: Map<string, string | undefined>;
  /** Runtime cede owner per contested channel: the claimant registration hands the channel to. */
  runtimeOwners: Map<string, string>;
};

/**
 * The channel owner one side of a config transaction selects, keyed by canonical channel id, on
 * both planes the codebase distinguishes: the schema owner is computed with the same registry and
 * ownership policy the schema plane uses (`loadGatewayRuntimeConfigSchema` pairs them the same
 * way), and the runtime cede owner comes from the collector plugin registration shares, so the
 * reload path cannot judge ownership by a different rule than validation, the Control UI, or the
 * loader apply.
 *
 * The pairing matters: ownership reads explicit selection and the per-channel activation
 * candidates from the SOURCE config, because auto-enable materializes
 * `plugins.entries.<id>.enabled` into the runtime config and a materialized-config read would
 * report every auto-enabled claimant as hand-picked. The runtime config still supplies policy
 * disablement. A reusable metadata snapshot supplies the registry; without one, the resolver
 * derives the registry workspace roots from this side's runtime config.
 */
function collectChannelOwners(side: {
  config: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
}): ChannelOwnersSnapshot {
  const registry =
    side.pluginMetadataSnapshot?.manifestRegistry ??
    resolveConfigWidePluginManifestRegistry({
      config: side.config,
      env: process.env,
    });
  const policy = createConfiguredChannelOwnershipPolicy({
    config: side.config,
    sourceConfig: side.sourceConfig,
    registry,
    env: process.env,
  });
  const schemaOwners = new Map<string, string | undefined>();
  for (const entry of collectChannelSchemaMetadataWithOwnership(registry, policy)) {
    schemaOwners.set(entry.id, entry.schemaPluginId);
  }
  // A contest can exist with no schema descriptor on any side: a bare `record.channels` claim
  // serves a channel, and a `preferOver` declaration can travel on `channelCatalogMeta` alone,
  // which auto-enable honors like a `channelConfigs` one. The schema map reports no owner for
  // such a channel however ownership settles, so the runtime plane's cede owner — the same
  // shared rule plugin registration applies — travels alongside it, or a hot edit could still
  // restart the stale owner while activation would select the replacement. The two planes stay
  // in separate maps because manifest channel ids are arbitrary strings, so no composite key
  // can be proven collision-free.
  const { cededChannelOwners } = collectCededChannelIdsByPlugin({
    registry,
    config: side.config,
    sourceConfig: side.sourceConfig,
    env: process.env,
    onlyPluginIdSet: null,
    dreamingSidecar: null,
  });
  return { schemaOwners, runtimeOwners: cededChannelOwners };
}

function haveMatchingAgentWorkspaceRoots(
  previousConfig: OpenClawConfig,
  nextConfig: OpenClawConfig,
): boolean {
  try {
    const previousRoots = listAgentWorkspaceDirs(previousConfig);
    const nextRoots = listAgentWorkspaceDirs(nextConfig);
    return (
      previousRoots.length === nextRoots.length &&
      previousRoots.every((root, index) => root === nextRoots[index])
    );
  } catch {
    // A root-scoped snapshot is unsafe when either side's discovery roots cannot be proven equal.
    return false;
  }
}

export type ChannelOwnershipChange = {
  channelId: string;
  previousOwner: string | undefined;
  nextOwner: string | undefined;
};

/** The first channel whose selected owner differs between the two config pairs, on either plane. */
export function findChannelOwnershipChange(params: {
  previous: { config: OpenClawConfig; sourceConfig: OpenClawConfig };
  next: { config: OpenClawConfig; sourceConfig: OpenClawConfig };
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
}): ChannelOwnershipChange | null {
  // The pre-write snapshot describes the old discovery roots. Reuse it only while both runtime
  // configs resolve the same ordered roots; otherwise each side must build its own registry.
  const pluginMetadataSnapshot =
    params.pluginMetadataSnapshot &&
    haveMatchingAgentWorkspaceRoots(params.previous.config, params.next.config)
      ? params.pluginMetadataSnapshot
      : undefined;
  const previous = collectChannelOwners({
    ...params.previous,
    pluginMetadataSnapshot,
  });
  const next = collectChannelOwners({
    ...params.next,
    pluginMetadataSnapshot,
  });
  const planes: ReadonlyArray<
    [ReadonlyMap<string, string | undefined>, ReadonlyMap<string, string | undefined>]
  > = [
    [previous.schemaOwners, next.schemaOwners],
    [previous.runtimeOwners, next.runtimeOwners],
  ];
  for (const [previousOwners, nextOwners] of planes) {
    for (const channelId of new Set([...previousOwners.keys(), ...nextOwners.keys()])) {
      const previousOwner = previousOwners.get(channelId);
      const nextOwner = nextOwners.get(channelId);
      if (previousOwner !== nextOwner) {
        return { channelId, previousOwner, nextOwner };
      }
    }
  }
  return null;
}
