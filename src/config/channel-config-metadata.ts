import {
  hasSensitiveUrlHintTag,
  SENSITIVE_URL_HINT_TAG,
} from "@openclaw/net-policy/redact-sensitive-url";
/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog } from "../../packages/terminal-core/src/ansi.js";
import { normalizeChatChannelId } from "../channels/registry.js";
import { resolveManifestChannelPreferOverIds } from "../plugins/manifest-channel-preference.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { collectPreferenceCycleComponents } from "./channel-preference-cycles.js";
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
   * Whether the plugin is active enough to own this channel's surfaced schema. Auto-enable ignores
   * a denied or disabled plugin and activates another claimant, so an inactive plugin must never
   * supply the schema an active one is validated against.
   *
   * Scoped to a channel because activation is: auto-enable materializes a per-channel candidate
   * set, and once any claimant declares `preferOver` that set narrows to the declaring pair. A
   * third claimant of the same channel is then never activated there, however close its origin
   * sits, while remaining perfectly active on channels where it is a candidate.
   */
  isPluginActive: (pluginId: string, channelId: string) => boolean;
  /**
   * Whether the operator selected this plugin by hand. Auto-enable leaves such a plugin enabled
   * even when another claimant declares it in `preferOver`, so both stay active and the runtime
   * channel facade falls back to registration order. Ownership must stop applying the declaration
   * there instead of handing the schema to the replacement.
   */
  isPluginExplicitlySelected: (pluginId: string) => boolean;
  /**
   * Whether the operator disabled this plugin outright. Distinct from `isPluginActive`, which is
   * also false for a claimant that is merely displaced: a displaced claimant keeps declaring so a
   * replacement chain closes the same way in both views, but a plugin the operator switched off
   * declares nothing at all. Auto-enable skips it as a declarant for the same reason.
   */
  isPluginPolicyDisabled: (pluginId: string) => boolean;
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

/**
 * Ownership from manifests alone, for callers with no operator config to consult: every claimant
 * counts as active and nothing is explicitly selected, so registry and origin order decide. Docs
 * generation is the intended user. Anything holding a config must build the configured policy
 * instead, or it will describe an owner the runtime does not activate.
 */
export const MANIFEST_ONLY_CHANNEL_OWNERSHIP_POLICY: ChannelOwnershipPolicy = {
  isPluginActive: () => true,
  isPluginExplicitlySelected: () => false,
  isPluginPolicyDisabled: () => false,
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
 * Replacement declarations set aside rather than applied, per claimed channel, keyed declarant id
 * to the ids it named. Two causes set one aside: the operator explicitly selected the named
 * plugin, or the two claimants named each other and neither can be said to replace the other.
 * Kept apart from `DisplacedChannelOwners` because a set-aside declaration displaces nobody —
 * both claimants stay active — yet the pair must not settle the way a pair nobody declared
 * anything about does.
 */
type SuppressedChannelDeclarations = Map<string, Map<string, Set<string>>>;

/**
 * Whether a declaration between the two claimants was set aside on this channel. Direction is
 * deliberately ignored: the runtime facade keeps the first registrant no matter which of the pair
 * did the declaring.
 */
function hasSuppressedChannelDeclaration(
  suppressed: SuppressedChannelDeclarations,
  channelId: string,
  pluginId: string,
  otherPluginId: string,
): boolean {
  const declared = suppressed.get(channelId);
  return (
    declared?.get(pluginId)?.has(otherPluginId) === true ||
    declared?.get(otherPluginId)?.has(pluginId) === true
  );
}

/**
 * Every claimant of each channel, keyed by claimed id. Only a record listed in `record.channels`
 * claims: auto-enable and the read-only channel facade build candidate sets from that list alone.
 */
function collectChannelClaimants(
  registry: PluginManifestRegistry,
): Map<string, PluginManifestRecord[]> {
  const claimantsByChannel = new Map<string, PluginManifestRecord[]>();
  for (const record of registry.plugins) {
    for (const channelId of record.channels) {
      const claimedId = normalizeClaimedChannelId(channelId);
      const claimants = claimantsByChannel.get(claimedId) ?? [];
      claimantsByChannel.set(claimedId, claimants);
      claimants.push(record);
    }
  }
  return claimantsByChannel;
}

/**
 * Records, per contested channel, which claimants another claimant declares it replaces.
 *
 * Built across the whole claimant set before any owner is chosen, because comparing each record
 * only against the current owner lets an A-replaces-B-replaces-C chain settle differently per
 * registry order, while `shouldSkipPreferredPluginAutoEnable` scans every configured candidate and
 * drops both B and C. Callers pass contested channels only, since resolving a preference can read
 * an external plugin catalog from disk.
 *
 * Inactive claimants normally declare nothing, so a denied replacement cannot take a channel from
 * the plugin activation would run instead. When no claimant is active there is no such plugin, and
 * dropping every declaration would leave registry order picking a winner; the declarations are
 * read from the whole claimant set in that case so the answer stays deterministic.
 *
 * Alongside the displaced set it reports the declarations it set aside because the named target is
 * explicitly selected: the ownership tie-break needs that distinction, and only this walk can see
 * the suppression happen.
 */
function collectDisplacedOwnersForClaimants(
  claimantsByChannel: ReadonlyMap<string, PluginManifestRecord[]>,
  policy: ChannelOwnershipPolicy,
): { displaced: DisplacedChannelOwners; suppressed: SuppressedChannelDeclarations } {
  const displaced: DisplacedChannelOwners = new Map();
  const suppressed: SuppressedChannelDeclarations = new Map();
  for (const [claimedId, claimants] of claimantsByChannel) {
    const activeClaimants = claimants.filter((record) =>
      policy.isPluginActive(record.id, claimedId),
    );
    const base = activeClaimants.length > 0 ? activeClaimants : claimants;
    // A claimant this channel has already displaced keeps declaring. Auto-enable disables the
    // middle of an A-replaces-B-replaces-C chain, and reading only active declarants then dropped
    // B's edge to C for exactly the plugin A had displaced: the source config resolved to A while
    // the materialized one left A and C to origin rank, so validation could check A's strict
    // schema against a config the Gateway then served with C. Re-run until the edge set settles so
    // both views answer the same way.
    for (;;) {
      const declarants = [
        ...base,
        ...claimants.filter(
          (record) =>
            !base.includes(record) &&
            isDisplacedChannelOwner(displaced, claimedId, record.id) &&
            // Only an implicitly displaced middle claimant propagates the chain. A plugin the
            // operator disabled is not inactive because something replaced it, and auto-enable
            // skips it as a declarant, so re-adding it here would apply an edge the runtime never
            // applies and strand the channel on a plugin the loader will not let register.
            !policy.isPluginPolicyDisabled(record.id),
        ),
      ];
      let added = false;
      const setAsideDeclaration = (declarantId: string, namedId: string) => {
        const declared = suppressed.get(claimedId) ?? new Map<string, Set<string>>();
        suppressed.set(claimedId, declared);
        const setAsideIds = declared.get(declarantId) ?? new Set<string>();
        declared.set(declarantId, setAsideIds);
        setAsideIds.add(namedId);
      };
      // Resolved once per declarant and read twice below: resolving can consult an external
      // plugin catalog, and the cycle computation must see exactly the edges the displacement
      // loop applies.
      const declarantEdges = new Map<string, string[]>();
      for (const record of declarants) {
        const resolved = policy.resolveChannelPreferOverIds(record, claimedId);
        const edges = declarantEdges.get(record.id);
        if (edges === undefined) {
          declarantEdges.set(record.id, [...resolved]);
        } else {
          edges.push(...resolved);
        }
      }
      // Declarants on one preference cycle settle nothing among themselves: every member both
      // displaces and is displaced, so no member outranks another. The reciprocal-pair rule was
      // the 2-member case of this, but a longer ring satisfies it in neither direction, so every
      // member got displaced and the tie fell to registry order while auto-enable settled the
      // same ring by processing order. Every pair in the component is set aside, declared edge
      // or not — a 4-cycle's opposite corners share no edge yet must tie-break exactly like the
      // mutual pair, or their comparison falls through to last-writer mid-ring.
      const componentByDeclarantId = new Map<string, number>();
      collectPreferenceCycleComponents(
        [...declarantEdges.keys()],
        (nodeId) => declarantEdges.get(nodeId) ?? [],
      ).forEach((members, componentIndex) => {
        members.forEach((member, memberIndex) => {
          componentByDeclarantId.set(member, componentIndex);
          // One direction per pair suffices: `hasSuppressedChannelDeclaration` is symmetric.
          for (const laterMember of members.slice(memberIndex + 1)) {
            setAsideDeclaration(member, laterMember);
          }
        });
      });
      for (const [declarantId, declaredIds] of declarantEdges) {
        for (const replacedId of declaredIds) {
          // A manifest that names itself declares nothing: `shouldSkipPreferredPluginAutoEnable`
          // skips the self comparison, so a self-edge would strand ownership on another claimant
          // while that plugin stays active.
          if (replacedId === declarantId) {
            continue;
          }
          // A declaration naming an explicitly selected plugin is set aside, not applied — the
          // operator's choice outranks it, so nobody is displaced. The ownership decision still
          // needs to know the pair was declared: with both claimants left active the runtime
          // facade rejects the later registration, while an undeclared pair stays on last-writer.
          // The two are indistinguishable at decision time, so record the suppression here.
          if (policy.isPluginExplicitlySelected(replacedId)) {
            setAsideDeclaration(declarantId, replacedId);
            continue;
          }
          // An edge between two members of one cycle component is the stand-off recorded above;
          // an edge from outside a component, or leaving one, displaces exactly as before.
          const componentIndex = componentByDeclarantId.get(declarantId);
          if (
            componentIndex !== undefined &&
            componentIndex === componentByDeclarantId.get(replacedId)
          ) {
            continue;
          }
          const replacedIds = displaced.get(claimedId) ?? new Set<string>();
          displaced.set(claimedId, replacedIds);
          if (!replacedIds.has(replacedId)) {
            replacedIds.add(replacedId);
            added = true;
          }
        }
      }
      if (!added) {
        break;
      }
    }
  }
  return { displaced, suppressed };
}

/**
 * Displacement over the claimant set, shared by both planes: a channel counts as contested once
 * two records claim it in `record.channels`, descriptors or not. A bare claim serves a channel —
 * `channelConfigs` is optional, and a channel declared without one still registers — so the
 * schema plane must count the contest exactly as the runtime plane does. Counting schema
 * descriptors here instead let a preferred replacement that ships no descriptor keep the count at
 * one: the channel then left displacement entirely, the fallback the replacement named was never
 * displaced on this plane, and the fallback's strict schema stayed surfaced for a channel the
 * loader cedes to the replacement — validation rejected every key the replacement accepts.
 */
function collectDisplacedChannelOwners(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy,
): { displaced: DisplacedChannelOwners; suppressed: SuppressedChannelDeclarations } {
  const claimantsByChannel = collectChannelClaimants(registry);
  for (const [claimedId, claimants] of claimantsByChannel) {
    if (claimants.length < 2) {
      claimantsByChannel.delete(claimedId);
    }
  }
  return collectDisplacedOwnersForClaimants(claimantsByChannel, policy);
}

/**
 * Runtime-plane displacement, read by the loader to decide which claimants cede a channel. It is
 * the same contest as the schema plane on purpose: the two planes counting differently is exactly
 * what let one plane keep a plugin the other had already ruled out.
 */
export function collectRuntimeDisplacedChannelOwners(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy,
): DisplacedChannelOwners {
  return collectDisplacedChannelOwners(registry, policy).displaced;
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
  pairDeclarationSuppressed: boolean;
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
  // Nothing separates the pair as compared here — and a suppressed pair arrives tied even across
  // origins, because the entry adopts the nearer record's rank before the comparison. How the tie
  // arose decides. A set-aside declaration — the operator selected its target, or the pair named
  // each other and neither replaces the other — leaves both claimants active, and the runtime
  // facade then rejects the later registration regardless of origin
  // (`registry-registrars-network.ts` keeps the first registrant), so the schema must stay with
  // the first claimant too. A pair with no declaration between them at all stays on the
  // long-standing last-writer answer.
  return params.pairDeclarationSuppressed ? "keepCurrent" : "takeChannel";
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
/** The attributes redaction consults, unioned across a channel's claimants. */
type ChannelRedactionHint = { sensitive: boolean; urlSecret: boolean };

export function collectChannelSchemaMetadataWithOwnership(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy = MANIFEST_ONLY_CHANNEL_OWNERSHIP_POLICY,
): ChannelSchemaMetadataWithOwnership[] {
  const byChannelId = new Map<string, ChannelMetadataRecord>();
  const { displaced: displacedOwners, suppressed: suppressedDeclarations } =
    collectDisplacedChannelOwners(registry, policy);
  // Who claims each channel, for the two descriptor gates below: a descriptor is read only from a
  // record that claims the channel, and a displaced claimant may not seed an empty channel while
  // an active claimant that beat it serves the channel.
  const claimantsByChannel = collectChannelClaimants(registry);
  // Redaction is a property of the field, not of whichever claimant wins the schema. A displaced
  // plugin's config can survive under the shared channel when the replacement accepts additional
  // properties, so dropping its hints with its schema would leave a retained secret with no hint
  // and no name-shaped fallback, and redaction would emit it.
  //
  // Both attributes the redaction path consults travel here: `redactConfigObject` and the system
  // agent gate on `sensitive === true || hasSensitiveUrlHintTag(hint)`, so carrying only the
  // former would still leak a URL-embedded credential the displaced owner alone tagged.
  const redactionByChannel = new Map<string, Map<string, ChannelRedactionHint>>();

  for (const record of registry.plugins) {
    const originRank = resolveOriginRank(record.origin);
    const rootLabel = record.channelCatalogMeta?.label;
    const rootDescription = record.channelCatalogMeta?.blurb;

    for (const declaredChannelId of record.channels) {
      // Key by the canonical id. Ownership below already decides on `normalizeClaimedChannelId`,
      // and the runtime config is canonical too, so keying the entry by the declared spelling put
      // a differently-spelled claimant in its own bucket that no `channels.<id>.*` path can reach.
      const channelId = normalizeClaimedChannelId(declaredChannelId);
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
        const recordActive = policy.isPluginActive(record.id, claimedId);
        // Ranks tie by the time the schema pass reaches this record, since the entry adopts this
        // record's rank right here, so only policy and the declaration separate the two.
        const keepOwnerPresentation =
          ownerId !== undefined &&
          ownerId !== record.id &&
          decideChannelSchemaOwnership({
            currentActive: policy.isPluginActive(ownerId, claimedId),
            incomingActive: recordActive,
            currentDisplaced: isDisplacedChannelOwner(displacedOwners, claimedId, ownerId),
            incomingDisplaced: isDisplacedChannelOwner(displacedOwners, claimedId, record.id),
            currentOriginRank: originRank,
            incomingOriginRank: originRank,
            pairDeclarationSuppressed: hasSuppressedChannelDeclaration(
              suppressedDeclarations,
              claimedId,
              ownerId,
              record.id,
            ),
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

    for (const [declaredChannelId, channelConfig] of Object.entries(record.channelConfigs ?? {})) {
      // Same canonicalization as the declaration loop: a sensitive hint collected under a
      // non-canonical spelling never lines up with the config path redaction actually reads.
      const channelId = normalizeClaimedChannelId(declaredChannelId);
      // Only a record that claims the channel in `record.channels` may supply its descriptor:
      // auto-enable and the channel facade build candidate sets from that list alone. Reading the
      // descriptor anyway let a closer-origin non-claimant win an unconfigured channel's schema —
      // with no candidate set yet every claimant counts as active — so the Control UI offered the
      // non-claimant's fields, and the first save narrowed candidates to real claimants and flipped
      // ownership to a strict schema that rejects the exact field the UI just offered. Manifest
      // validation only warns about the opposite gap (a claim without a descriptor), so the drop
      // is reported here where it is decided.
      if (!claimantsByChannel.get(channelId)?.includes(record)) {
        const message = `plugin ships channelConfigs metadata for ${sanitizeForLog(channelId)} (in its manifest or merged from the official plugin catalog) without declaring the channel in openclaw.plugin.json#channels; ignoring the descriptor. Only a claimant may supply a channel's config schema — add the channel to channels if this plugin should own it.`;
        const pluginId = sanitizeForLog(record.id);
        // The collector runs many times against one registry (validation, schema responses,
        // reloads), so an already-reported drop must not accumulate duplicates.
        if (
          !registry.diagnostics.some(
            (diagnostic) =>
              diagnostic.level === "warn" &&
              diagnostic.pluginId === pluginId &&
              diagnostic.message === message,
          )
        ) {
          registry.diagnostics.push({
            level: "warn",
            pluginId,
            source: sanitizeForLog(record.manifestPath),
            message,
          });
        }
        continue;
      }
      // Collect before any ownership decision: a claimant that loses the schema still contributes
      // sensitivity, and the decision below `continue`s past this point for losers.
      for (const [relPath, hint] of Object.entries(channelConfig.uiHints ?? {})) {
        const sensitive = hint?.sensitive === true;
        const urlSecret = hasSensitiveUrlHintTag(hint);
        if (!sensitive && !urlSecret) {
          continue;
        }
        const carried =
          redactionByChannel.get(channelId) ?? new Map<string, ChannelRedactionHint>();
        const seen = carried.get(relPath);
        carried.set(relPath, {
          sensitive: sensitive || seen?.sensitive === true,
          urlSecret: urlSecret || seen?.urlSecret === true,
        });
        redactionByChannel.set(channelId, carried);
      }
      const current = byChannelId.get(channelId);
      const currentOwnsSchema =
        current !== undefined &&
        (current.configSchema !== undefined || current.configUiHints !== undefined);
      if (currentOwnsSchema) {
        const claimedId = normalizeClaimedChannelId(channelId);
        const ownerId = current.schemaPluginId;
        const decision = decideChannelSchemaOwnership({
          currentActive: ownerId === undefined || policy.isPluginActive(ownerId, claimedId),
          incomingActive: policy.isPluginActive(record.id, claimedId),
          currentDisplaced:
            ownerId !== undefined && isDisplacedChannelOwner(displacedOwners, claimedId, ownerId),
          incomingDisplaced: isDisplacedChannelOwner(displacedOwners, claimedId, record.id),
          // The entry rank, not the schema owner's: a nearer claimant that ships no channel config
          // still shields the schema it adopted from farther records.
          currentOriginRank: current.originRank,
          incomingOriginRank: originRank,
          pairDeclarationSuppressed:
            ownerId !== undefined &&
            hasSuppressedChannelDeclaration(suppressedDeclarations, claimedId, ownerId, record.id),
        });
        if (decision === "keepCurrent") {
          continue;
        }
      } else if (
        isDisplacedChannelOwner(displacedOwners, channelId, record.id) &&
        claimantsByChannel
          .get(channelId)
          ?.some(
            (claimant) =>
              !isDisplacedChannelOwner(displacedOwners, channelId, claimant.id) &&
              policy.isPluginActive(claimant.id, channelId),
          )
      ) {
        // The ownership decision above only protects an existing owner, so the first descriptor
        // used to install unconditionally. When the claimant that wins the channel ships no
        // descriptor of its own, that seeded the displaced fallback's strict schema for a channel
        // the loader cedes to the winner, and validation then rejected every key the winner
        // accepts. A displaced claimant may not seed the schema while an active, non-displaced
        // claimant exists to serve the channel; with no descriptor from that winner the channel
        // correctly stays permissive. When every claimant is displaced or inactive nothing
        // outranks this record at runtime, so its descriptor still lands.
        continue;
      }
      // Accepted tradeoff, recorded so it is a decision and not an oversight: a replacement that
      // wins the channel supplies the schema, so a strict replacement can reject a key the operator
      // set for the plugin it displaced. Core does not migrate it — a plugin declaring `preferOver`
      // knows which keys it supersedes, and that repair belongs to its own doctor contract
      // (`legacyConfigRules`, `normalizeCompatibilityConfig`). Nothing catalogued is affected: the
      // only declared `preferOver` target accepts every property.
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
    .map(({ originRank: _originRank, ...entry }) => {
      const carried = redactionByChannel.get(entry.id);
      if (!carried) {
        return entry;
      }
      // Union only what redaction reads: the owner keeps its labels, help text, presentation, and
      // schema, and its other tags survive. `entry` is already a fresh object from the rest
      // destructure above, so assigning into it is local.
      const merged: NonNullable<ChannelUiMetadata["configUiHints"]> = { ...entry.configUiHints };
      for (const [relPath, redaction] of carried) {
        const owned = merged[relPath];
        const tags =
          redaction.urlSecret && !hasSensitiveUrlHintTag(owned)
            ? [...(owned?.tags ?? []), SENSITIVE_URL_HINT_TAG]
            : owned?.tags;
        merged[relPath] = {
          ...owned,
          ...(redaction.sensitive ? { sensitive: true } : {}),
          ...(tags ? { tags } : {}),
        };
      }
      entry.configUiHints = merged;
      return entry;
    });
}

/** Collects public per-channel config UI metadata without internal schema ownership. */
export function collectChannelSchemaMetadataCore(
  registry: PluginManifestRegistry,
  policy: ChannelOwnershipPolicy,
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
