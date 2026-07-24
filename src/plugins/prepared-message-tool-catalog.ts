/** Registry-owned message-tool metadata prepared once per channel registry generation. */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { PreparedMessageToolCatalog } from "../channels/plugins/message-action-discovery.js";
import { CHAT_CHANNEL_ORDER } from "../channels/registry.js";
import type { PluginRegistry } from "./registry-types.js";
import {
  getActivePluginChannelRegistrySnapshotFromState,
  type ActivePluginChannelRegistrySnapshot,
} from "./runtime-channel-state.js";

const catalogsByRegistry = new WeakMap<PluginRegistry, Map<number, PreparedMessageToolCatalog>>();
const latestCatalogByRegistry = new WeakMap<PluginRegistry, PreparedMessageToolCatalog>();

export const EMPTY_PREPARED_MESSAGE_TOOL_CATALOG: PreparedMessageToolCatalog = Object.freeze({
  version: 0,
  channels: Object.freeze([]),
  getChannel: () => undefined,
});

function listPreparedChannels(registry: PluginRegistry) {
  const byId = new Map<string, PluginRegistry["channels"][number]["plugin"]>();
  (registry.channels ?? []).forEach((registration) => {
    const id = normalizeOptionalString(registration.plugin.id);
    if (id && !byId.has(id)) {
      byId.set(id, registration.plugin);
    }
  });
  return [...byId.values()].toSorted((left, right) => {
    const leftId = normalizeOptionalString(left.id) ?? "";
    const rightId = normalizeOptionalString(right.id) ?? "";
    const leftKnownOrder = CHAT_CHANNEL_ORDER.indexOf(leftId);
    const rightKnownOrder = CHAT_CHANNEL_ORDER.indexOf(rightId);
    const leftOrder = left.meta.order ?? (leftKnownOrder === -1 ? 999 : leftKnownOrder);
    const rightOrder = right.meta.order ?? (rightKnownOrder === -1 ? 999 : rightKnownOrder);
    return leftOrder === rightOrder ? leftId.localeCompare(rightId) : leftOrder - rightOrder;
  });
}

function selectedRegistry(
  snapshot: ActivePluginChannelRegistrySnapshot,
): PluginRegistry | undefined {
  return (snapshot.registry as PluginRegistry | null | undefined) ?? undefined;
}

/** Settles the catalog after the channel registry surface changes. */
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
    listPreparedChannels(registry).map((plugin) =>
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
