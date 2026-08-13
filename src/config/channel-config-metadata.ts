/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/registry.js";
import { resolveManifestChannelPreferOverIds } from "../plugins/manifest-channel-preference.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { widenOfficialExternalChannelSecretSchema } from "./official-external-channel-secret-schema.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

type ChannelSchemaMetadataWithOwnership = ChannelUiMetadata & {
  schemaPluginId?: string;
  schemaPluginOrigin?: PluginOrigin;
};

type ChannelMetadataRecord = ChannelSchemaMetadataWithOwnership & {
  // Rank of the closest record that has claimed this channel, which decides who may still replace
  // the schema.
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

/** How a caller judges channel claimants; both decisions mirror what plugin activation does. */
export type ChannelOwnershipPolicy = {
  /**
   * Whether the plugin is active enough to own a channel's surfaced schema. Auto-enable ignores a
   * denied or disabled plugin and activates another claimant, so an inactive plugin must never
   * supply the schema an active one is validated against.
   */
  isPluginActive: (pluginId: string) => boolean;
  /**
   * Whether the operator selected this plugin by hand. Auto-enable leaves such a plugin enabled
   * even when another claimant declares it in `preferOver`, so both stay active and the runtime
   * channel facade falls back to registration order. Ownership must stop applying the declaration
   * there instead of handing the schema to the replacement.
   */
  isPluginExplicitlySelected: (pluginId: string) => boolean;
  /**
   * Replacement preference for one record on one channel. Defaults to the manifest declaration,
   * which is all config-independent metadata can see; a caller holding the operator config passes
   * auto-enable's full resolution so a built-in or catalog preference counts here too.
   */
  resolveChannelPreferOverIds: (
    record: PluginManifestRecord,
    channelId: string,
  ) => readonly string[];
};

const DEFAULT_CHANNEL_OWNERSHIP_POLICY: ChannelOwnershipPolicy = {
  isPluginActive: () => true,
  isPluginExplicitlySelected: () => false,
  resolveChannelPreferOverIds: resolveManifestChannelPreferOverIds,
};

function resolveOriginRank(origin: PluginOrigin): number {
  return PLUGIN_ORIGIN_RANK[origin] ?? Number.MAX_SAFE_INTEGER;
}

function normalizeClaimedChannelId(channelId: string): string {
  return normalizeChatChannelId(channelId) ?? channelId;
}

/** Plugin ids some other claimant declares it replaces, per claimed channel. */
type DisplacedChannelOwners = Map<string, Set<string>>;

function isDisplacedChannelOwner(
  displaced: DisplacedChannelOwners,
  channelId: string,
  pluginId: string,
): boolean {
  return displaced.get(channelId)?.has(pluginId) === true;
}

/**
 * Records, per channel, which claimants another claimant declares it replaces.
 *
 * Built across the whole registry before any schema is chosen, because comparing each record only
 * against the current owner lets an A-replaces-B-replaces-C chain settle differently per registry
 * order, while `shouldSkipPreferredPluginAutoEnable` scans every configured candidate and drops
 * both B and C. Only a record listed in `record.channels` contributes: auto-enable and the
 * read-only channel facade build claimants from that list alone. Contested channels only, since
 * resolving a preference can read an external plugin catalog from disk.
 *
 * Inactive claimants normally declare nothing, so a denied replacement cannot take a channel from
 * the plugin activation would run instead. When no claimant is active there is no such plugin, and
 * dropping every declaration would leave registry order picking a winner; the declarations are
 * read from the whole claimant set in that case so the answer stays deterministic.
 */
function collectDisplacedChannelOwners(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy,
): DisplacedChannelOwners {
  const schemaClaimantCounts = new Map<string, number>();
  for (const record of registry.plugins) {
    for (const channelId of Object.keys(record.channelConfigs ?? {})) {
      const claimedId = normalizeClaimedChannelId(channelId);
      schemaClaimantCounts.set(claimedId, (schemaClaimantCounts.get(claimedId) ?? 0) + 1);
    }
  }

  const claimantsByChannel = new Map<string, PluginManifestRecord[]>();
  for (const record of registry.plugins) {
    for (const channelId of record.channels) {
      const claimedId = normalizeClaimedChannelId(channelId);
      if ((schemaClaimantCounts.get(claimedId) ?? 0) < 2) {
        continue;
      }
      const claimants = claimantsByChannel.get(claimedId) ?? [];
      claimantsByChannel.set(claimedId, claimants);
      claimants.push(record);
    }
  }

  const displaced: DisplacedChannelOwners = new Map();
  for (const [claimedId, claimants] of claimantsByChannel) {
    const activeClaimants = claimants.filter((record) => policy.isPluginActive(record.id));
    const declarants = activeClaimants.length > 0 ? activeClaimants : claimants;
    for (const record of declarants) {
      for (const replacedId of policy.resolveChannelPreferOverIds(record, claimedId)) {
        // A manifest that names itself declares nothing: `shouldSkipPreferredPluginAutoEnable`
        // skips the self comparison, so a self-edge would strand ownership on another claimant
        // while that plugin stays active.
        if (replacedId === record.id || policy.isPluginExplicitlySelected(replacedId)) {
          continue;
        }
        const replacedIds = displaced.get(claimedId) ?? new Set<string>();
        displaced.set(claimedId, replacedIds);
        replacedIds.add(replacedId);
      }
    }
  }
  return displaced;
}

/**
 * Which of two records supplying a schema for the same channel owns it. Operator policy first,
 * then the declared replacement, then install origin, and registry order only when nothing else
 * separates them. Auto-enable applies the declaration with no origin restriction, so ranking
 * origin above it would activate one plugin and validate against another.
 */
function decideChannelSchemaOwnership(params: {
  currentActive: boolean;
  incomingActive: boolean;
  currentDisplaced: boolean;
  incomingDisplaced: boolean;
  currentOriginRank: number;
  incomingOriginRank: number;
}): "keepCurrent" | "takeChannel" {
  if (params.currentActive !== params.incomingActive) {
    return params.incomingActive ? "takeChannel" : "keepCurrent";
  }
  if (params.currentDisplaced !== params.incomingDisplaced) {
    return params.incomingDisplaced ? "keepCurrent" : "takeChannel";
  }
  if (params.currentOriginRank !== params.incomingOriginRank) {
    return params.currentOriginRank < params.incomingOriginRank ? "keepCurrent" : "takeChannel";
  }
  return "takeChannel";
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

/**
 * Collects per-channel config metadata with the plugin that supplied the selected schema.
 *
 * `policy` decides which claimants count, mirroring plugin activation. Omit it for
 * config-independent metadata (docs, generated baselines), where every declared replacement counts
 * and no operator config is in scope.
 */
export function collectChannelSchemaMetadataWithOwnership(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy = DEFAULT_CHANNEL_OWNERSHIP_POLICY,
): ChannelSchemaMetadataWithOwnership[] {
  const byChannelId = new Map<string, ChannelMetadataRecord>();
  const displacedOwners = collectDisplacedChannelOwners(registry, policy);

  for (const record of registry.plugins) {
    const originRank = resolveOriginRank(record.origin);
    const recordActive = policy.isPluginActive(record.id);
    const rootLabel = record.channelCatalogMeta?.label;
    const rootDescription = record.channelCatalogMeta?.blurb;

    for (const channelId of record.channels) {
      const current = byChannelId.get(channelId);
      // Root channel catalog metadata can fill labels/descriptions before a channel-specific
      // config block appears, but it must not overwrite a closer-origin channel entry.
      if (!current || originRank <= current.originRank) {
        // Presentation travels with the selected schema owner. A record that will not win the
        // schema must not relabel the channel, or docs and config UI show the replaced plugin's
        // name above the replacement's fields. Two ways to lose it: a same-origin claimant settled
        // by the preference below, or an inactive plugin that operator policy already ruled out
        // however close its origin sits. The winner re-sets both below.
        const ownerId = current?.schemaPluginId;
        const claimedId = normalizeClaimedChannelId(channelId);
        // Ranks tie by the time the schema pass reaches this record, since the entry adopts this
        // record's rank right here, so only policy and the declaration separate the two.
        const keepOwnerPresentation =
          ownerId !== undefined &&
          ownerId !== record.id &&
          decideChannelSchemaOwnership({
            currentActive: policy.isPluginActive(ownerId),
            incomingActive: recordActive,
            currentDisplaced: isDisplacedChannelOwner(displacedOwners, claimedId, ownerId),
            incomingDisplaced: isDisplacedChannelOwner(displacedOwners, claimedId, record.id),
            currentOriginRank: originRank,
            incomingOriginRank: originRank,
          }) === "keepCurrent";
        byChannelId.set(channelId, {
          id: channelId,
          label: keepOwnerPresentation
            ? (current?.label ?? rootLabel)
            : (rootLabel ?? current?.label),
          description: keepOwnerPresentation
            ? (current?.description ?? rootDescription)
            : (rootDescription ?? current?.description),
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
      const currentOwnsSchema =
        current !== undefined &&
        (current.configSchema !== undefined || current.configUiHints !== undefined);
      if (currentOwnsSchema) {
        const claimedId = normalizeClaimedChannelId(channelId);
        const ownerId = current.schemaPluginId;
        const decision = decideChannelSchemaOwnership({
          currentActive: ownerId === undefined || policy.isPluginActive(ownerId),
          incomingActive: recordActive,
          currentDisplaced:
            ownerId !== undefined && isDisplacedChannelOwner(displacedOwners, claimedId, ownerId),
          incomingDisplaced: isDisplacedChannelOwner(displacedOwners, claimedId, record.id),
          // The entry rank, not the schema owner's: a nearer claimant that ships no channel config
          // still shields the schema it adopted from farther records.
          currentOriginRank: current.originRank,
          incomingOriginRank: originRank,
        });
        if (decision === "keepCurrent") {
          continue;
        }
      }
      const coreOwnedSchema =
        record.origin === "bundled" || channelConfig.schema === undefined
          ? channelConfig.schema
          : normalizeCoreOwnedChannelSchema(channelConfig.schema);
      const configSchema = widenOfficialExternalChannelSecretSchema({
        channelId,
        schema: coreOwnedSchema,
      });
      byChannelId.set(channelId, {
        id: channelId,
        label: channelConfig.label ?? rootLabel ?? current?.label,
        description: channelConfig.description ?? rootDescription ?? current?.description,
        configSchema,
        configUiHints: channelConfig.uiHints as ChannelUiMetadata["configUiHints"],
        schemaPluginId: configSchema === undefined ? undefined : record.id,
        schemaPluginOrigin: configSchema === undefined ? undefined : record.origin,
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
  policy?: ChannelOwnershipPolicy,
): ChannelUiMetadata[] {
  return collectChannelSchemaMetadataWithOwnership(registry, policy).map(
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
