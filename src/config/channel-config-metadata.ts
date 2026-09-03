/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { widenOfficialExternalChannelSecretSchema } from "./official-external-channel-secret-schema.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

type ChannelSchemaMetadataWithOwnership = ChannelUiMetadata & {
  schemaPluginId?: string;
  schemaPluginOrigin: PluginOrigin;
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

const CHANNEL_HEARTBEAT_VISIBILITY_JSON_SCHEMA =
  ChannelHeartbeatVisibilitySchema.unwrap().toJSONSchema({ target: "draft-07" });

function normalizeCoreOwnedChannelSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const normalized = structuredClone(schema);
  let changed = false;
  const normalizeNode = (
    node: Record<string, unknown>,
    accountMap = false,
    rootScope = true,
  ): void => {
    let withinRootScope = rootScope && (node === normalized || typeof node.$id !== "string");
    if (typeof node.$ref === "string") {
      const match = withinRootScope
        ? /^#\/(\$defs|definitions)\/([A-Za-z0-9_.-]+)$/.exec(node.$ref)
        : null;
      const definitions = match?.[1] ? normalized[match[1]] : undefined;
      const target = isRecord(definitions) && match?.[2] ? definitions[match[2]] : undefined;
      if (
        !isRecord(target) ||
        Object.keys(node).some(
          (key) => !["$ref", "$defs", "definitions", "$id", "$schema"].includes(key),
        ) ||
        ["$id", "$anchor", "$dynamicAnchor", "$recursiveAnchor", "$schema", "$ref"].some((key) =>
          Object.hasOwn(target, key),
        )
      ) {
        return;
      }
      // Inline only this owner; changing shared definitions would affect unrelated consumers.
      const owner = { ...node };
      Object.assign(node, structuredClone(target), owner);
      delete node.$ref;
      changed = true;
      withinRootScope = node === normalized;
    }

    for (const key of ["allOf", "anyOf", "oneOf"] as const) {
      const variants = node[key];
      for (const variant of Array.isArray(variants) ? variants : []) {
        if (isRecord(variant)) {
          normalizeNode(variant, accountMap, withinRootScope);
        }
      }
    }

    if (accountMap) {
      if (node.additionalProperties === true) {
        node.additionalProperties = {};
        changed = true;
      }
      const entries = [
        node.additionalProperties,
        ...Object.values(isRecord(node.properties) ? node.properties : {}),
        ...Object.values(isRecord(node.patternProperties) ? node.patternProperties : {}),
      ];
      for (const entry of entries) {
        if (isRecord(entry)) {
          normalizeNode(entry, false, withinRootScope);
        }
      }
      return;
    }

    const properties = isRecord(node.properties) ? node.properties : {};
    if (
      JSON.stringify(properties.heartbeatVisibility) !==
      JSON.stringify(CHANNEL_HEARTBEAT_VISIBILITY_JSON_SCHEMA)
    ) {
      node.properties = {
        ...properties,
        heartbeatVisibility: CHANNEL_HEARTBEAT_VISIBILITY_JSON_SCHEMA,
      };
      changed = true;
    }

    // Account maps are containers; only each account entry owns heartbeat visibility.
    const accounts = properties.accounts;
    if (isRecord(accounts)) {
      normalizeNode(accounts, true, withinRootScope);
    }
  };

  normalizeNode(normalized);
  return changed ? normalized : schema;
}

/** Collects plugin config UI metadata with deterministic origin precedence and output ordering. */
export function collectPluginSchemaMetadataCore(
  registry: PluginManifestRegistry,
): PluginUiMetadata[] {
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

function prepareChannelConfigSchema(
  origin: PluginOrigin,
  channelId: string,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (origin === "bundled") {
    return widenOfficialExternalChannelSecretSchema({ channelId, schema });
  }
  try {
    const coreOwnedSchema = schema === undefined ? schema : normalizeCoreOwnedChannelSchema(schema);
    return widenOfficialExternalChannelSecretSchema({ channelId, schema: coreOwnedSchema });
  } catch {
    // Normalization and official-channel widening both clone and walk the schema, so a deeply
    // nested external manifest overflows here, before any validator runs. Surfacing the raw
    // schema keeps metadata collection total and leaves the diagnostic to the one owner of it,
    // validatePluginSchemaValue.
    return schema;
  }
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
          schemaPluginOrigin: current?.schemaPluginOrigin ?? record.origin,
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
      const configSchema = prepareChannelConfigSchema(
        record.origin,
        channelId,
        channelConfig.schema,
      );
      byChannelId.set(channelId, {
        id: channelId,
        label: channelConfig.label ?? rootLabel ?? current?.label,
        description: channelConfig.description ?? rootDescription ?? current?.description,
        configSchema,
        configUiHints: channelConfig.uiHints as ChannelUiMetadata["configUiHints"],
        schemaPluginId: configSchema === undefined ? undefined : record.id,
        schemaPluginOrigin: record.origin,
        originRank,
      });
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ originRank: _originRank, ...entry }) => entry);
}

/** Collects public per-channel config UI metadata without internal schema ownership. */
export function collectChannelSchemaMetadataCore(
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
