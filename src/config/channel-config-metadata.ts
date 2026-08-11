/**
 * Converts plugin manifest metadata into deterministic config UI metadata for docs, validation, and runtime schema.
 * When multiple plugin origins expose the same id/channel, the closest origin owns the surfaced schema.
 */
import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord, isRecord } from "@openclaw/normalization-core/record-coerce";
import type { AmbientEnvTriggerPolicy } from "../channels/config-presence.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import type { PluginOrigin } from "../plugins/plugin-origin.types.js";
import { declaresPluginPreferenceOver } from "../plugins/plugin-policy-id.js";
import {
  collectPluginIdsForConfiguredChannel,
  isPluginSelectedWithAliases,
  normalizeManifestChannelId,
  normalizePluginsConfigWithManifestAliases,
  type ChannelClaimantDecision,
} from "./channel-claimant-plugins.js";
import { widenOfficialExternalChannelSecretSchema } from "./official-external-channel-secret-schema.js";
import { detectPluginAutoEnableCandidates } from "./plugin-auto-enable.detect.js";
import {
  hasRelevantSetupCandidateConfig,
  planPluginAutoEnable,
} from "./plugin-auto-enable.shared.js";
import type { ChannelUiMetadata, PluginUiMetadata } from "./schema.js";
import type { OpenClawConfig } from "./types.openclaw.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

type ChannelSchemaMetadataWithOwnership = ChannelUiMetadata & {
  schemaPluginId?: string;
  schemaPluginOrigin?: PluginOrigin;
};

type ChannelPresentationField = "label" | "description" | "configUiHints";

type ChannelPresentationWrite = { rank: number; pluginId: string };

type ChannelMetadataRecord = ChannelSchemaMetadataWithOwnership & {
  /** Rank and writer of each presentation field; an unwritten field carries none. */
  presentationRanks: Partial<Record<ChannelPresentationField, ChannelPresentationWrite>>;
};

// Per-field origin precedence: each presentation field belongs to the closest claim that
// supplied it. A strictly closer claim replaces the field, an equal-or-farther claim fills only
// absence, and the schema owner (with its root catalog metadata) wins ties. A claim also
// replaces its OWN earlier value at equal rank — its root catalog value is written before its
// channel-specific presentation, and the specific value must win. A sparse closer claim
// therefore cannot starve fields it never supplied, and assembled metadata does not depend on
// registry traversal order between claims of distinct ranks.
function writeChannelPresentationField<Field extends ChannelPresentationField>(
  record: ChannelMetadataRecord,
  field: Field,
  value: ChannelMetadataRecord[Field],
  rank: number,
  pluginId: string,
  ownerTieBreak: boolean,
): void {
  if (value === undefined) {
    return;
  }
  const current = record.presentationRanks[field];
  if (
    current === undefined ||
    rank < current.rank ||
    (rank === current.rank && (ownerTieBreak || current.pluginId === pluginId))
  ) {
    record[field] = value;
    record.presentationRanks[field] = { rank, pluginId };
  }
}

// Config UI hints merge per key instead of replacing the map: a closer losing claim's
// presentation hints must not strip the schema owner's — dropping a `sensitive` hint would
// render a credential in Control UI raw-config diffs. Rank still decides per-key precedence
// (the winning map's keys overwrite), while non-conflicting keys survive from every claim.
function mergeChannelConfigUiHints(
  record: ChannelMetadataRecord,
  value: ChannelMetadataRecord["configUiHints"],
  rank: number,
  pluginId: string,
  ownerTieBreak: boolean,
): void {
  if (value === undefined) {
    return;
  }
  const current = record.presentationRanks.configUiHints;
  if (
    current === undefined ||
    rank < current.rank ||
    (rank === current.rank && (ownerTieBreak || current.pluginId === pluginId))
  ) {
    record.configUiHints = { ...record.configUiHints, ...value };
    record.presentationRanks.configUiHints = { rank, pluginId };
    return;
  }
  record.configUiHints = { ...value, ...record.configUiHints };
}

/** One plugin's claim on a channel id, with the policy facts that decide ownership. */
type ChannelSchemaClaim = {
  record: PluginManifestRecord;
  preferOver?: readonly string[];
  originRank: number;
  // Registry position doubles as load order: the loader iterates candidates in discovery order
  // and channel registration keeps the first registrant, so among simultaneously active claims
  // the lowest index is the plugin the runtime actually serves.
  discoveryIndex: number;
  claimsChannel: boolean;
  explicitlySelected: boolean;
  suppliesSchema: boolean;
  behindCloserDeclaration: boolean;
  plannedActive: boolean;
  // True when the completed pass accounted for this claimant's liveness — a per-channel decision
  // or a capability-decided global fate. A claim active with neither is live only through default
  // activation, which the projection's probe-skipping plan may not account for (setup-derived
  // kills and re-selections), so load-order projection is sound only among accounted claims.
  planDecided: boolean;
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

function keepHighestRanked<T>(claims: readonly T[], rank: (claim: T) => number): readonly T[] {
  const best = Math.max(...claims.map(rank));
  return claims.filter((claim) => rank(claim) === best);
}

/**
 * Ranks a claim above the claims it supersedes and below the claims that supersede it. Only an
 * implicitly selected claim can be displaced: auto-enable leaves an explicitly selected plugin
 * enabled and reports duplicate channel diagnostics, and channel registration then keeps the first
 * registrant, so `preferOver` decides nothing once the operator selected both plugins.
 */
function channelReplacementRank(
  claim: ChannelSchemaClaim,
  claims: readonly ChannelSchemaClaim[],
): number {
  const supersedes = claims.some(
    (other) =>
      other !== claim &&
      !other.explicitlySelected &&
      declaresPluginPreferenceOver(claim.preferOver, other.record.id),
  );
  const superseded =
    !claim.explicitlySelected &&
    claims.some(
      (other) => other !== claim && declaresPluginPreferenceOver(other.preferOver, claim.record.id),
    );
  return (supersedes ? 1 : 0) - (superseded ? 1 : 0);
}

/** One channel's completed-plan view: claimant decisions plus the activation world they live in. */
type ChannelPlanView = {
  decisions: ReadonlyMap<string, ChannelClaimantDecision>;
  completedActivation(record: PluginManifestRecord): boolean;
  // Plugin-level end-state liveness from the pass: a capability candidate decides a claimant's
  // fate globally with no per-channel decision, and such claimants are still load-order ranked.
  claimantLive(pluginId: string): boolean;
  // True when the config cannot produce setup-derived candidates (the probes the projection
  // skips), so this probe-skipping plan IS the plan the runtime executes: every completed
  // activation fact — including a default-active claimant never decided anywhere — is
  // plan-accounted and load-order eligible.
  planExact: boolean;
};

/** The completed auto-enable pass projected for ownership, per channel. */
type ChannelClaimantPlanProjection = {
  planFor(channelId: string): ChannelPlanView;
};

/**
 * Executes auto-enable's completed activation pass once and projects each channel's claimant
 * decisions from it. Channels the completed pass never visited (not configured yet) replay the
 * same ordered pass with their own claimants appended, so a configured channel's claimant that
 * supersedes one of them disables it exactly as auto-enable would the moment the channel becomes
 * configured. Activation for claimants the pass left alone reads the completed config — the one
 * the runtime loads from — so the projection can only diverge from auto-enable by diverging from
 * its own output.
 */
function planChannelClaimantDecisions(params: {
  registry: PluginManifestRegistry;
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
}): ChannelClaimantPlanProjection {
  // Auto-enable is inert while plugins are globally disabled; claimants keep their configured state.
  const inert = params.config.plugins?.enabled === false;
  const candidates = inert
    ? []
    : detectPluginAutoEnableCandidates({
        config: params.config,
        env: params.env,
        manifestRegistry: params.registry,
        ...(params.ambientEnvTriggers ? { ambientEnvTriggers: params.ambientEnvTriggers } : {}),
        // Validation, preflights, and schema builds read this projection, so it must never load
        // plugin setup modules or run their probes: plugin code must not execute inside
        // `config validate`, and a throwing probe must never abort it. Setup-derived candidates
        // exist only for plugins no manifest fact triggers; dropping them can diverge only for
        // such a plugin's catalog-level preferOver claim, or its default-off claim on a channel
        // it is not a candidate for — an accepted, named tradeoff over running plugin code here.
        setupProbes: "skip",
      });
  const plan = inert
    ? undefined
    : planPluginAutoEnable({
        config: params.config,
        candidates,
        env: params.env,
        manifestRegistry: params.registry,
      });
  const activationOf = (completed: OpenClawConfig) => {
    // Completed-activation reads must fold legacy-keyed entries onto the current id the way the
    // runtime's registry-aware normalizer does, or a legacy-keyed disable projects the incumbent
    // active while the runtime loads only its replacement.
    const completedPlugins = normalizePluginsConfigWithManifestAliases(
      completed.plugins,
      params.registry,
    );
    return (record: PluginManifestRecord): boolean =>
      isActivatedManifestOwner({
        plugin: record,
        normalizedConfig: completedPlugins,
        rootConfig: completed,
      });
  };
  const emptyDecisions = new Map<string, ChannelClaimantDecision>();
  const baseActivation = activationOf(plan?.config ?? params.config);
  const replayViews = new Map<string, ChannelPlanView>();
  return {
    planFor: (rawChannelId) => {
      if (!plan) {
        // Inert (plugins globally disabled): nothing loads, so no claimant is pass-live.
        return {
          decisions: emptyDecisions,
          completedActivation: baseActivation,
          claimantLive: () => false,
          planExact: false,
        };
      }
      const channelId = normalizeManifestChannelId(rawChannelId);
      const planned = plan.channelDecisions.get(channelId);
      if (planned) {
        return {
          decisions: planned,
          completedActivation: baseActivation,
          claimantLive: plan.isClaimantLive,
          planExact: !hasRelevantSetupCandidateConfig(params.config, params.registry),
        };
      }
      const cached = replayViews.get(channelId);
      if (cached) {
        return cached;
      }
      // Hypothetical claims join the channel-candidate phase, where a really configured channel's
      // claims run (resolveConfiguredPluginAutoEnableCandidates lists every channel candidate
      // before the other kinds), so replacement chains and cycles replay in the runtime pass's
      // order instead of after a provider- or tool-triggered candidate has already been decided.
      const hypotheticalClaims = collectPluginIdsForConfiguredChannel(
        channelId,
        params.registry,
        params.env,
      ).map((pluginId) => ({
        pluginId,
        kind: "channel-configured" as const,
        channelId,
      }));
      // A disabled channel replays as if enabled: validating its saved keys must mirror the plan
      // the channel gets the moment the operator re-enables it, not the activation unrelated
      // candidates produced while it was off.
      const channelsRecord = params.config.channels as Record<string, unknown> | undefined;
      const channelEntry = asOptionalRecord(channelsRecord?.[rawChannelId]);
      const replayConfig =
        channelEntry?.enabled === false
          ? {
              ...params.config,
              channels: { ...channelsRecord, [rawChannelId]: { ...channelEntry, enabled: true } },
            }
          : params.config;
      const replay = planPluginAutoEnable({
        config: replayConfig,
        candidates: [
          ...candidates.filter((entry) => entry.kind === "channel-configured"),
          ...hypotheticalClaims,
          ...candidates.filter((entry) => entry.kind !== "channel-configured"),
        ],
        env: params.env,
        manifestRegistry: params.registry,
      });
      // The replay's decisions live in the replay's completed world: a claimant the original
      // pass killed can be alive here (its killer died to this channel's claimant), so activation
      // for claims the replay never decided must read the replay's config, not the original's.
      const view: ChannelPlanView = {
        decisions: replay.channelDecisions.get(channelId) ?? emptyDecisions,
        completedActivation: activationOf(replay.config),
        claimantLive: replay.isClaimantLive,
        planExact: !hasRelevantSetupCandidateConfig(replayConfig, params.registry),
      };
      replayViews.set(channelId, view);
      return view;
    },
  };
}

/**
 * True when the claimant serves the channel once auto-enable applies its planned selection to this
 * config: the plan enables it, or it leaves the claimant alone (operator-kept despite a
 * replacement, or never considered) and the completed config activates it. A supersede-keep only
 * refuses to disable the claimant — it never loads one the completed config still leaves inactive.
 * A claim whose manifest never lists the channel can only come from merged catalog metadata, which
 * auto-enable never selects, so it can describe the channel but never serve it.
 */
function resolvePlannedActive(
  claim: ChannelSchemaClaim,
  view: ChannelPlanView | undefined,
): boolean {
  if (!view) {
    return true;
  }
  const decision = view.decisions.get(claim.record.id);
  if (decision === "enable") {
    return true;
  }
  // An IMPLICITLY superseded claim never serves its channel: the loader suppresses its
  // registration even when a configured provider capability keeps the plugin loaded, so the
  // replacement owns the channel in any load order. Treating such a claim as a live contender
  // would validate the schema of a channel implementation the runtime refuses to register.
  if (decision === "supersede-disable") {
    return false;
  }
  // A supersede-KEEP claim stays a live contender when the completed config activates it: the
  // manifest contract preserves explicit operator selections and reports duplicate channel
  // diagnostics instead of suppressing them, so the kept claim races first-wins registration.
  // Undecided claims (and forbidden ones, which never load) read the same completed activation.
  return claim.claimsChannel && view.completedActivation(claim.record);
}

/**
 * Selects one owner across every claim on a channel id, strongest tier first: a declared schema
 * (a claim that validates nothing must never take validation ownership from one that supplies a
 * schema; its label and hints merge through the presentation fill instead), then auto-enable's
 * planned selection (an inactive plugin must never own the schema that validates a live channel),
 * then origin closeness, then explicit operator selection (runtime only supersedes an implicitly
 * selected plugin, so an explicit one keeps the schema that validates its existing keys), then the
 * declared preferOver replacement, then the incumbent a closer-origin declaration already froze.
 * Claims that tie on every tier keep the last-claim-wins registry order.
 *
 * Implicit claims the completed pass leaves simultaneously active skip the replacement tier for
 * actual load order: registration is first-wins in discovery order and never consults preferOver
 * once both plugins stay loaded, so the projection follows the first loaded claimant instead of
 * a supersession that failed to remove the incumbent.
 */
function selectChannelSchemaOwner(claims: readonly ChannelSchemaClaim[]): ChannelSchemaClaim {
  let eligible = keepHighestRanked(claims, (claim) => (claim.suppliesSchema ? 1 : 0));
  eligible = keepHighestRanked(eligible, (claim) => (claim.plannedActive ? 1 : 0));
  eligible = keepHighestRanked(eligible, (claim) => -claim.originRank);
  // Simultaneously active claims mirror the runtime winner regardless of explicit selection:
  // registration is first-wins in load order and consults neither operator intent nor
  // preferOver once both plugins stay loaded. Undecided survivors keep the predictive tiers —
  // see planDecided.
  const coActive =
    eligible.length > 1 && eligible.every((claim) => claim.plannedActive && claim.planDecided);
  if (coActive) {
    const owners = keepHighestRanked(eligible, (claim) => -claim.discoveryIndex);
    return expectDefined(owners.at(-1), "channel schema owner");
  }
  eligible = keepHighestRanked(eligible, (claim) => (claim.explicitlySelected ? 1 : 0));
  const contenders = eligible;
  eligible = keepHighestRanked(contenders, (claim) => channelReplacementRank(claim, contenders));
  const owners = keepHighestRanked(eligible, (claim) => (claim.behindCloserDeclaration ? 0 : 1));
  return expectDefined(owners.at(-1), "channel schema owner");
}

/** Resolves the winning channel config claim per channel id before any metadata is written. */
function selectChannelSchemaOwners(
  registry: PluginManifestRegistry,
  config?: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options?: ChannelSchemaOwnershipOptions,
): Map<string, ChannelSchemaClaim> {
  // Claims group by CANONICAL channel identity — the identity activation planning and runtime
  // registration reconcile on. Raw manifest spellings (built-in aliases, case variants) would
  // split one logical channel into per-spelling groups, each electing its own owner, and the
  // superseded incumbent's schema would validate a channel its replacement serves.
  const claimsByChannelId = new Map<string, ChannelSchemaClaim[]>();
  const closestDeclaredRank = new Map<string, number>();
  const declareChannel = (channelId: string, originRank: number): void => {
    const closest = closestDeclaredRank.get(channelId);
    if (closest === undefined || originRank < closest) {
      closestDeclaredRank.set(channelId, originRank);
    }
  };

  for (const [discoveryIndex, record] of registry.plugins.entries()) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    for (const channelId of record.channels) {
      declareChannel(normalizeManifestChannelId(channelId), originRank);
    }
    const channelConfigs = Object.entries(record.channelConfigs ?? {});
    if (channelConfigs.length === 0) {
      continue;
    }
    // Auto-enable's replacement policy owns "did the operator choose this plugin?", so the explicit
    // tier reads that predicate — through the registry alias fold, like every planner selection
    // read: a legacy-keyed entry is the operator's choice of the current plugin. The activation
    // resolver's wider explicit set also counts bundled channel enablement and slots, which
    // auto-enable still supersedes — reading it would keep the schema of a plugin the runtime
    // disables and reject the replacement's own channel keys.
    const explicitlySelected = isPluginSelectedWithAliases(config?.plugins, record.id, registry);
    for (const [channelId, channelConfig] of channelConfigs) {
      const canonicalChannelId = normalizeManifestChannelId(channelId);
      const claim: ChannelSchemaClaim = {
        record,
        preferOver: channelConfig.preferOver,
        originRank,
        discoveryIndex,
        // Catalog metadata can merge a channelConfigs entry for a channel the manifest never
        // claims; auto-enable only considers manifest claimants, so only they can serve it.
        claimsChannel: (record.channels ?? []).some(
          (id) => normalizeManifestChannelId(id) === canonicalChannelId,
        ),
        explicitlySelected,
        suppliesSchema: channelConfig.schema !== undefined,
        // A closer-origin plugin that declared this channel id first keeps the incumbent owner,
        // so a farther-origin claim behind it cannot take a schema that closer metadata shadows.
        behindCloserDeclaration:
          (closestDeclaredRank.get(canonicalChannelId) ?? originRank) < originRank,
        plannedActive: true,
        planDecided: false,
      };
      declareChannel(canonicalChannelId, originRank);
      const claims = claimsByChannelId.get(canonicalChannelId);
      if (claims) {
        claims.push(claim);
      } else {
        claimsByChannelId.set(canonicalChannelId, [claim]);
      }
    }
  }

  // Ownership follows the one completed activation pass auto-enable applies to this config,
  // instead of predicting it from parallel per-channel policy reads. Without config every plugin
  // counts as an equally eligible owner, which keeps registry-only callers (docs baseline,
  // contract tests) on pure manifest metadata.
  const claimantPlan = config
    ? planChannelClaimantDecisions({
        registry,
        config,
        env,
        ...(options?.ambientEnvTriggers ? { ambientEnvTriggers: options.ambientEnvTriggers } : {}),
      })
    : undefined;
  return new Map(
    [...claimsByChannelId].map(([channelId, claims]) => {
      const view = claimantPlan?.planFor(channelId);
      const planned = claims.map((claim) => ({
        ...claim,
        plannedActive: resolvePlannedActive(claim, view),
        // Accounted liveness: a per-channel decision, a capability-decided global fate, or an
        // exact plan (no setup-derived candidate can exist for this config, so completed
        // activation facts — default-active omitted claimants included — are exhaustive).
        planDecided:
          view !== undefined &&
          (view.planExact ||
            view.decisions.has(claim.record.id) ||
            view.claimantLive(claim.record.id)),
      }));
      return [channelId, selectChannelSchemaOwner(planned)];
    }),
  );
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

/** Collects per-channel config metadata with the plugin that supplied the selected schema. */
/** Options for channel schema ownership collection. */
type ChannelSchemaOwnershipOptions = {
  /** Ambient env-trigger policy of the plan being mirrored; env-only channels obey it. */
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
};

export function collectChannelSchemaMetadataWithOwnership(
  registry: PluginManifestRegistry,
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  options?: ChannelSchemaOwnershipOptions,
): ChannelSchemaMetadataWithOwnership[] {
  const byChannelId = new Map<string, ChannelMetadataRecord>();
  const schemaOwners = selectChannelSchemaOwners(registry, config, env, options);

  // Emitted metadata carries the canonical channel id: claims under variant manifest spellings
  // merge into the one logical channel activation and validation resolve, instead of surfacing a
  // second entry whose schema competes with the selected owner's.
  const entryFor = (channelId: string): ChannelMetadataRecord => {
    const id = normalizeManifestChannelId(channelId);
    const existing = byChannelId.get(id);
    if (existing) {
      return existing;
    }
    const created: ChannelMetadataRecord = { id, presentationRanks: {} };
    byChannelId.set(id, created);
    return created;
  };

  for (const record of registry.plugins) {
    const originRank = PLUGIN_ORIGIN_RANK[record.origin] ?? Number.MAX_SAFE_INTEGER;
    const rootLabel = record.channelCatalogMeta?.label;
    const rootDescription = record.channelCatalogMeta?.blurb;

    // Root channel catalog metadata fills labels/descriptions before a channel-specific config
    // block appears. The equal-rank tie-break belongs only to the selected schema owner here
    // too: an equal-origin losing record traversed after the owner must fill absence only, or
    // the surfaced text would describe one plugin beside another plugin's fields and flip with
    // registry order.
    for (const channelId of record.channels) {
      const entry = entryFor(channelId);
      const ownsChannel =
        schemaOwners.get(normalizeManifestChannelId(channelId))?.record === record;
      writeChannelPresentationField(entry, "label", rootLabel, originRank, record.id, ownsChannel);
      writeChannelPresentationField(
        entry,
        "description",
        rootDescription,
        originRank,
        record.id,
        ownsChannel,
      );
    }

    for (const [channelId, channelConfig] of Object.entries(record.channelConfigs ?? {})) {
      const entry = entryFor(channelId);
      const uiHints = channelConfig.uiHints as ChannelUiMetadata["configUiHints"];
      // Ownership is decided across every claim on this channel id before any metadata is
      // written, so registry traversal order can no longer overwrite the selected owner. A claim
      // that lost ownership still fills channel presentation per field: a strictly closer loser
      // replaces, an equal-or-farther loser fills absence — it can never relabel presentation an
      // equally close or closer claim wrote, and a sparse closer loser cannot starve fields it
      // never supplied.
      const owner = schemaOwners.get(normalizeManifestChannelId(channelId));
      if (owner?.record !== record) {
        writeChannelPresentationField(
          entry,
          "label",
          channelConfig.label,
          originRank,
          record.id,
          false,
        );
        writeChannelPresentationField(
          entry,
          "description",
          channelConfig.description,
          originRank,
          record.id,
          false,
        );
        mergeChannelConfigUiHints(entry, uiHints, originRank, record.id, false);
        continue;
      }
      // The owner's presentation joins with the tie-break (an equal-rank loser never displaces
      // it), while any field a strictly closer losing claim wrote stays.
      writeChannelPresentationField(
        entry,
        "label",
        channelConfig.label ?? rootLabel,
        originRank,
        record.id,
        true,
      );
      writeChannelPresentationField(
        entry,
        "description",
        channelConfig.description ?? rootDescription,
        originRank,
        record.id,
        true,
      );
      mergeChannelConfigUiHints(entry, uiHints, originRank, record.id, true);
      // Installed plugin schemas can lag core; bundled schemas share its release and identity.
      const coreOwnedSchema =
        record.origin === "bundled" || channelConfig.schema === undefined
          ? channelConfig.schema
          : normalizeCoreOwnedChannelSchema(channelConfig.schema);
      // Official external channels widen their secret fields (upstream #107295): ownership
      // facts key off the WIDENED schema, which can exist even without a declared one.
      const configSchema = widenOfficialExternalChannelSecretSchema({
        channelId,
        schema: coreOwnedSchema,
      });
      entry.configSchema = configSchema;
      entry.schemaPluginId = configSchema === undefined ? undefined : record.id;
      entry.schemaPluginOrigin = configSchema === undefined ? undefined : record.origin;
    }
  }

  return [...byChannelId.values()]
    .toSorted((left, right) => left.id.localeCompare(right.id))
    .map(({ presentationRanks: _presentationRanks, ...entry }) => entry);
}

/** Collects public per-channel config UI metadata without internal schema ownership. */
export function collectChannelSchemaMetadataCore(
  registry: PluginManifestRegistry,
  config?: OpenClawConfig,
  env?: NodeJS.ProcessEnv,
  options?: ChannelSchemaOwnershipOptions,
): ChannelUiMetadata[] {
  return collectChannelSchemaMetadataWithOwnership(registry, config, env, options).map(
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
