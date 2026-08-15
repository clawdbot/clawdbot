/** Registry-owned message-tool metadata prepared once per channel registry generation. */
import { listLoadedChannelPluginsForRegistry } from "../channels/plugins/registry-loaded.js";
import type { ChannelMessageActionAdapter } from "../channels/plugins/types.core.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginChannelRegistrySnapshotFromState,
  type ActivePluginChannelRegistrySnapshot,
} from "./runtime-channel-state.js";

type PreparedMessageToolCatalogEntry = Readonly<{
  id: string;
  actions?: ChannelMessageActionAdapter;
  reconcilesUnknownSend: boolean;
}>;

export type PreparedMessageToolCatalog = Readonly<{
  version: number;
  channels: readonly PreparedMessageToolCatalogEntry[];
  getChannel: (id: string) => PreparedMessageToolCatalogEntry | undefined;
}>;

const catalogsByRegistry = new WeakMap<PluginRegistry, Map<number, PreparedMessageToolCatalog>>();
const latestCatalogByRegistry = new WeakMap<PluginRegistry, PreparedMessageToolCatalog>();

function selectedRegistry(
  snapshot: ActivePluginChannelRegistrySnapshot,
): PluginRegistry | undefined {
  return (snapshot.registry as PluginRegistry | null | undefined) ?? undefined;
}

/** Settles the catalog after the process-root registry changes. */
export function settlePreparedMessageToolCatalog(
  preparedRegistry?: PluginRegistry,
  preparedVersion?: number,
): PreparedMessageToolCatalog | undefined {
  const snapshot =
    preparedRegistry && preparedVersion !== undefined
      ? undefined
      : getActivePluginChannelRegistrySnapshotFromState();
  const registry = preparedRegistry ?? (snapshot ? selectedRegistry(snapshot) : undefined);
  if (!registry) {
    return undefined;
  }
  const version = preparedVersion ?? snapshot?.version ?? 0;
  let catalogs = catalogsByRegistry.get(registry);
  const existing = catalogs?.get(version);
  if (existing) {
    return existing;
  }
  const channels = Object.freeze(
    listLoadedChannelPluginsForRegistry(registry).map((plugin) =>
      Object.freeze({
        id: plugin.id,
        ...(plugin.actions ? { actions: plugin.actions } : {}),
        reconcilesUnknownSend:
          plugin.message?.durableFinal?.capabilities?.reconcileUnknownSend === true &&
          typeof plugin.message.durableFinal.reconcileUnknownSend === "function",
      }),
    ),
  );
  const byId = new Map(channels.map((entry) => [entry.id, entry] as const));
  const catalog = Object.freeze({
    version,
    channels,
    getChannel: (id: string) => byId.get(id),
  });
  if (!catalogs) {
    catalogs = new Map();
    catalogsByRegistry.set(registry, catalogs);
  }
  catalogs.set(version, catalog);
  latestCatalogByRegistry.set(registry, catalog);
  return catalog;
}

/** Returns the catalog for the active channel generation without rebuilding it. */
export function getPreparedMessageToolCatalog(): PreparedMessageToolCatalog | undefined {
  const snapshot = getActivePluginChannelRegistrySnapshotFromState();
  const registry = selectedRegistry(snapshot);
  if (!registry) {
    return undefined;
  }
  return catalogsByRegistry.get(registry)?.get(snapshot.version);
}

/** Returns the catalog settled for one exact runtime registry generation. */
export function getPreparedMessageToolCatalogForRegistry(
  registry: PluginRegistry,
): PreparedMessageToolCatalog | undefined {
  return latestCatalogByRegistry.get(registry);
}
