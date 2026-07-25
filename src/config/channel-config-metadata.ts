/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";

type ChannelSchemaMetadataWithOwnership = ChannelUiMetadata & {
  schemaPluginId?: string;
  schemaPluginOrigin?: PluginOrigin;
};

type ChannelMetadataRecord = ChannelSchemaMetadataWithOwnership & {
  originRank: number;
};

type ChannelDmAllowFromMode = "topOnly" | "topOrNested" | "nestedOnly";

type ChannelDmPolicyMetadata = {
  id: string;
  dmAllowFromMode?: ChannelDmAllowFromMode;
};

type ChannelDmPolicyMetadataRecord = ChannelDmPolicyMetadata & {
  originRank: number;
};

const PLUGIN_ORIGIN_RANK: Readonly<Record<PluginOrigin, number>> = {
  // Lower ranks are closer to the operator and should override farther bundled/global metadata.
  config: 0,
  workspace: 1,
  global: 2,
  bundled: 3,
};

/** Collects plugin config UI metadata with deterministic origin precedence and output ordering. */
export function collectPluginSchemaMetadata(registry: PluginManifestRegistry): PluginUiMetadata[] {
  const deduped = new Map<
    string,
    PluginUiMetadata & {
      originRank: number;
    }
  >();

  for (const record of registry.plugins) {
    const current = deduped.get(record.id);
    const nextRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    // Prefer the closest install origin when the same plugin id appears in multiple registries.
    if (current && current.originRank <= nextRank) {
      continue;
    }
    deduped.set(record.id, {
      id: record.id,
      name: record.name,
      description: record.description,
      configUiHints: record.configUiHints,
      configSchema: record.configSchema,
      originRank: nextRank,
    });
  }

  return [...deduped.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...record }) => record);
}

/** Collects per-channel config metadata with the plugin that supplied the selected schema. */
export function collectChannelSchemaMetadataWithOwnership(
  registry: PluginManifestRegistry,
): ChannelSchemaMetadataWithOwnership[] {
  const byChannelId = new Map<string, ChannelMetadataRecord>();

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const rootLabel = record.channelCatalogMeta?.label;
    const rootDescription = record.channelCatalogMeta?.blurb;

    for (const channelId of record.channels) {
      const current = byChannelId.get(channelId);
      // Root channel catalog metadata can fill labels/descriptions before a channel-specific
      // config block appears, but it must not overwrite a closer-origin channel entry.
      if (!current || originRank <= current.originRank) {
        byChannelId.set(channelId, {
          id: channelId,
          label: rootLabel ?? current?.label,
          description: rootDescription ?? current?.description,
          configSchema: current?.configSchema,
          configUiHints: current?.configUiHints,
          schemaPluginId: current?.schemaPluginId,
          schemaPluginOrigin: current?.schemaPluginOrigin,
          originRank,
        });
      }
    }

    for (const [channelId, channelConfig] of Object.entries(record.channelConfigs ?? {})) {
      const current = byChannelId.get(channelId);
      if (
        current &&
        current.originRank < originRank &&
        (current.configSchema !== undefined || current.configUiHints !== undefined)
      ) {
        // A closer-origin channel config owns schema/UI hints even if a farther plugin also
        // advertises the same channel id.
        continue;
      }
      byChannelId.set(channelId, {
        id: channelId,
        label: channelConfig.label ?? rootLabel ?? current?.label,
        description: channelConfig.description ?? rootDescription ?? current?.description,
        configSchema: channelConfig.schema,
        configUiHints: channelConfig.uiHints as ChannelUiMetadata["configUiHints"],
        schemaPluginId: channelConfig.schema === undefined ? undefined : record.id,
        schemaPluginOrigin: channelConfig.schema === undefined ? undefined : record.origin,
        originRank,
      });
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}

/** Collects public per-channel config UI metadata without internal schema ownership. */
export function collectChannelSchemaMetadata(
  registry: PluginManifestRegistry,
): ChannelUiMetadata[] {
  return collectChannelSchemaMetadataWithOwnership(registry).map(
    ({ schemaPluginId: _schemaPluginId, schemaPluginOrigin: _schemaPluginOrigin, ...entry }) =>
      entry,
  );
}

/** Collects channel DM policy metadata without importing doctor/runtime command modules. */
export function collectChannelDmPolicyMetadata(
  registry: PluginManifestRegistry,
): ChannelDmPolicyMetadata[] {
  const byChannelId = new Map<string, ChannelDmPolicyMetadataRecord>();

  const put = (
    channelId: string | undefined,
    originRank: number,
    dmAllowFromMode?: ChannelDmAllowFromMode,
  ): void => {
    const id = channelId?.trim();
    if (!id) {
      return;
    }
    const current = byChannelId.get(id);
    if (current && current.originRank < originRank) {
      return;
    }
    byChannelId.set(id, {
      id,
      ...(dmAllowFromMode ? { dmAllowFromMode } : {}),
      originRank,
    });
  };

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const packageChannelId = record.packageChannel?.id?.trim();
    const dmAllowFromMode = record.packageChannel?.doctorCapabilities?.dmAllowFromMode;
    for (const channelId of record.channels) {
      put(channelId, originRank, channelId === packageChannelId ? dmAllowFromMode : undefined);
    }
    put(packageChannelId, originRank, dmAllowFromMode);
    for (const channelId of Object.keys(record.channelConfigs ?? {})) {
      put(channelId, originRank, channelId === packageChannelId ? dmAllowFromMode : undefined);
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}
