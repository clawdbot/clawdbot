/**
 * Resolves which installed plugins claim a configured channel id and how auto-enable decides one
 * claimant candidate. Auto-enable's ordered activation pass and the channel schema ownership
 * config validation reads must both consume these primitives, or validation applies one plugin's
 * channel schema while the runtime serves another's channel.
 */
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizePluginsConfigWithResolver } from "../plugins/config-policy.js";
import {
  isPluginExplicitlySelected,
  normalizePluginId,
  type NormalizedPluginsConfig,
} from "../plugins/config-state.js";
import { isActivatedManifestOwner } from "../plugins/manifest-owner-policy.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "../plugins/manifest-registry.js";
import {
  declaresPluginPreferenceOver,
  normalizePluginPolicyId,
} from "../plugins/plugin-policy-id.js";
import { listPluginRegistryNormalizerAliases } from "../plugins/plugin-registry-id-normalizer.js";
import { resolveChannelClaimPreferOver } from "./plugin-auto-enable.prefer-over.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Resolves a manifest-declared channel id to the built-in channel id when one exists. */
export function normalizeManifestChannelId(channelId: string): string {
  return normalizeChatChannelId(channelId) ?? channelId;
}

/**
 * Key for one plugin's claim on one channel. The planner's superseded-claim set and the loader's
 * channel-registration suppression must build it identically, or a claim the plan superseded
 * still races first-wins registration and serves a channel validation projected for its
 * replacement. JSON tuple encoding: ids are validated only as nonempty trimmed strings, so any
 * bare delimiter (even NUL) is ambiguous — ("a\0b","c") must not share a key with ("a","b\0c").
 */
export function channelClaimSuppressionKey(pluginId: string, channelId: string): string {
  return JSON.stringify([normalizePluginPolicyId(pluginId), normalizeManifestChannelId(channelId)]);
}

/**
 * Lists the plugin ids auto-enable considers for a configured channel: both sides of every declared
 * `preferOver` replacement, or — when no claim declares one — the first claimant in discovery order.
 */
export function collectPluginIdsForConfiguredChannel(
  channelId: string,
  registry: PluginManifestRegistry,
  env: NodeJS.ProcessEnv,
): string[] {
  const normalizedChannelId = normalizeManifestChannelId(channelId);
  const builtInId = normalizeChatChannelId(normalizedChannelId);
  // Edges resolve through the same chain the resolver honors (manifest channel config, plugin
  // catalog meta, built-in meta, external catalog). Reading only the manifest here leaves a
  // catalog-edged replacement uncollected: validation plans the discovery-first incumbent while
  // the live replacement's claim supersedes it the moment the runtime considers it.
  const preferOverCache = new Map<string, string[]>();
  const claims: Array<{ plugin: PluginManifestRecord; preferOver: readonly string[] }> = [];
  for (const record of registry.plugins) {
    if (
      (record.channels ?? []).some((id) => normalizeManifestChannelId(id) === normalizedChannelId)
    ) {
      claims.push({
        plugin: record,
        preferOver: resolveChannelClaimPreferOver({
          pluginId: record.id,
          channelId: normalizedChannelId,
          env,
          registry,
          cache: preferOverCache,
        }),
      });
    }
  }

  if (claims.length === 0) {
    return builtInId ? [builtInId] : [];
  }

  // A `preferOver` entry names a plugin through the derived policy key, so resolve it back to the
  // id the manifest declares; every downstream entry, allowlist, and disable path is keyed by that
  // declared id.
  const claimIdsByPolicyId = new Map(
    claims.map((claim) => [normalizePluginPolicyId(claim.plugin.id), claim.plugin.id]),
  );
  if (builtInId) {
    claimIdsByPolicyId.set(normalizePluginPolicyId(builtInId), builtInId);
  }
  const preferredIds = new Set<string>();
  for (const claim of claims) {
    for (const preferredOverId of claim.preferOver) {
      const claimedId = claimIdsByPolicyId.get(normalizePluginPolicyId(preferredOverId));
      if (claimedId) {
        // Keep both sides as candidates. The preferOver filter later disables
        // the lower-priority plugin unless the preferred plugin is explicitly
        // disabled/denied, preserving fallback to bundled channel support.
        preferredIds.add(claim.plugin.id);
        preferredIds.add(claimedId);
      }
    }
  }

  if (preferredIds.size > 0) {
    return [...preferredIds].toSorted((left, right) => left.localeCompare(right));
  }
  return [claims[0]?.plugin.id ?? builtInId ?? normalizedChannelId];
}

/**
 * True when config forbids a plugin through the denylist. `plugins.deny` is keyed by the derived
 * policy id once config is normalized, and the gateway normalizes policy lists through the
 * registry alias map — a deny under a documented legacy id blocks the current plugin at load, so
 * a current-id-only read here enables a plugin the runtime refuses and orphans its channel.
 */
export function isPluginPolicyDenied(
  cfg: OpenClawConfig,
  pluginId: string,
  registry: PluginManifestRegistry,
): boolean {
  const deny = cfg.plugins?.deny;
  if (!Array.isArray(deny)) {
    return false;
  }
  const selectionIds = collectPluginSelectionPolicyIds(registry, pluginId);
  return deny.some((entry) => selectionIds.has(normalizePluginPolicyId(entry)));
}

/**
 * True when config explicitly disables a plugin: a built-in channel switched off, or a
 * `plugins.entries` record under the derived policy key. Reading the declared id instead misses
 * the operator's record and lets auto-enable write `enabled: true` under the declared id, which
 * normalization folds over the operator's false and loads a plugin config disables.
 */
export function isPluginPolicyDisabled(
  cfg: OpenClawConfig,
  pluginId: string,
  registry: PluginManifestRegistry,
): boolean {
  const builtInChannelId = normalizeChatChannelId(pluginId);
  if (builtInChannelId) {
    const channels = cfg.channels as Record<string, unknown> | undefined;
    if (asOptionalRecord(channels?.[builtInChannelId])?.enabled === false) {
      return true;
    }
  }
  return resolveFoldedPluginEntry(cfg, pluginId, registry)?.enabled === false;
}

/**
 * Alias folds the runtime's registry-aware normalizer applies to config policy keys: an
 * operator's entry under ANY of a plugin's registry contribution aliases — channel ids,
 * provider ids, setup providers, CLI backends, catalog keys, auth aliases, documented legacy
 * ids — resolves to the current plugin id before enablement reads. Mirrors the runtime alias
 * walk (`listPluginRegistryNormalizerAliases`): plugins in id order, first declaration wins,
 * and a plugin's own id always beats another plugin's alias for the same key.
 */
type RegistryAliasFolds = {
  ownIds: ReadonlySet<string>;
  folds: ReadonlyMap<string, string>;
  aliasesByTarget: ReadonlyMap<string, ReadonlySet<string>>;
};

const registryAliasFoldsMemo = new WeakMap<PluginManifestRegistry, RegistryAliasFolds>();

function resolveRegistryAliasFolds(registry: PluginManifestRegistry): RegistryAliasFolds {
  let resolved = registryAliasFoldsMemo.get(registry);
  if (!resolved) {
    const folds = new Map<string, string>();
    const aliasesByTarget = new Map<string, Set<string>>();
    // Plain lowercase, NEVER the built-in fallback alias map: the runtime registry normalizer
    // preserves installed current ids, and expanding the hard-coded fallbacks here would
    // collapse two distinct installed plugins (google vs google-gemini-cli) into one entry.
    const ownIds = new Set(registry.plugins.map((plugin) => normalizePluginPolicyId(plugin.id)));
    for (const plugin of [...registry.plugins].toSorted((left, right) =>
      left.id.localeCompare(right.id),
    )) {
      const target = normalizePluginPolicyId(plugin.id);
      for (const alias of listPluginRegistryNormalizerAliases(plugin)) {
        const aliasKey = normalizePluginPolicyId(alias);
        if (aliasKey && !ownIds.has(aliasKey) && !folds.has(aliasKey)) {
          folds.set(aliasKey, target);
          const targetAliases = aliasesByTarget.get(target) ?? new Set<string>();
          targetAliases.add(aliasKey);
          aliasesByTarget.set(target, targetAliases);
        }
      }
    }
    resolved = { ownIds, folds, aliasesByTarget };
    registryAliasFoldsMemo.set(registry, resolved);
  }
  return resolved;
}

function createRegistryPluginKeyResolver(registry: PluginManifestRegistry): (id: string) => string {
  const { ownIds, folds } = resolveRegistryAliasFolds(registry);
  return (id) => {
    const key = normalizePluginPolicyId(id);
    // An installed plugin's current id always denotes itself; a registry alias folds onto its
    // declarer; only an id the registry knows nothing about falls back to the built-in alias
    // map, which exists for configs naming plugins that are not installed.
    if (ownIds.has(key)) {
      return key;
    }
    return folds.get(key) ?? normalizePluginId(id);
  };
}

/**
 * Canonical plugins-config normalization through the registry's legacy-alias folds. Every
 * planner or projection read of a COMPLETED config's activation state must use this form: the
 * plain normalizer strands legacy-keyed fields under the alias, activating a plugin whose
 * operator disable the runtime's registry-aware fold honors.
 */
export function normalizePluginsConfigWithManifestAliases(
  plugins: OpenClawConfig["plugins"],
  registry: PluginManifestRegistry,
): NormalizedPluginsConfig {
  return normalizePluginsConfigWithResolver(plugins, createRegistryPluginKeyResolver(registry));
}

/**
 * The folded plugin entry the runtime loads: canonical normalization folds case-variant, legacy
 * alias, and duplicate entry keys onto one key, merging FIELD-WISE in object order — a later
 * variant's field wins only when present, so a config-only variant retains an earlier variant's
 * disablement. Every planner read must consume this same merged entry: an exact-key read misses
 * the operator's normalized entry for a mixed-case manifest id, and a registry-blind fold strands
 * a legacy-keyed `enabled: false` under the alias, activating a plugin the runtime disables.
 */
// Planner policy reads fold entries repeatedly against the same config object — inside decide()'s
// recursion and every group scan — and canonical normalization is pure in the plugins object
// while apply-phase writes replace it wholesale, so one normalization per distinct object serves
// every read. Without the memo, compat migration sweeps re-normalize per policy check. The
// registry is process-stable, so the per-registry inner map holds one entry in production.
const foldedPluginEntriesMemo = new WeakMap<
  object,
  WeakMap<PluginManifestRegistry, NormalizedPluginsConfig["entries"]>
>();

export function resolveFoldedPluginEntry(
  cfg: OpenClawConfig,
  pluginId: string,
  registry: PluginManifestRegistry,
): NormalizedPluginsConfig["entries"][string] | undefined {
  const plugins = cfg.plugins;
  if (!plugins) {
    return undefined;
  }
  let byRegistry = foldedPluginEntriesMemo.get(plugins);
  if (!byRegistry) {
    byRegistry = new WeakMap();
    foldedPluginEntriesMemo.set(plugins, byRegistry);
  }
  const resolvePluginKey = createRegistryPluginKeyResolver(registry);
  let entries = byRegistry.get(registry);
  if (!entries) {
    entries = normalizePluginsConfigWithResolver(plugins, resolvePluginKey).entries;
    byRegistry.set(registry, entries);
  }
  return entries[resolvePluginKey(pluginId)];
}

/**
 * Policy ids that select a plugin: its own derived key plus every registry contribution alias
 * the runtime normalizer folds onto it (channel ids, provider ids, setup providers, CLI
 * backends, catalog keys, auth aliases, documented legacy ids). Selection and apply-key reads
 * must honor the same contract or a replacement disables a plugin the operator configured
 * under one of its aliases.
 */
export function collectPluginSelectionPolicyIds(
  registry: PluginManifestRegistry,
  pluginId: string,
): ReadonlySet<string> {
  // Derived from the registry alias folds, so selection, deny, allowlist, and entry-key reads
  // can only agree with the entry folding above: an alias claimed by an earlier-sorted plugin
  // or colliding with an installed plugin's own id is absent here exactly as the fold skips it.
  const { aliasesByTarget } = resolveRegistryAliasFolds(registry);
  const policyId = normalizePluginPolicyId(pluginId);
  return new Set([policyId, ...(aliasesByTarget.get(policyId) ?? [])]);
}

/** `isPluginExplicitlySelected` through the plugin's selection policy ids, legacy aliases included. */
export function isPluginSelectedWithAliases(
  plugins: OpenClawConfig["plugins"],
  pluginId: string,
  registry: PluginManifestRegistry,
): boolean {
  return [...collectPluginSelectionPolicyIds(registry, pluginId)].some((aliasId) =>
    isPluginExplicitlySelected(plugins, aliasId),
  );
}

/** Auto-enable's decision for one channel claimant candidate. */
export type ChannelClaimantDecision =
  | "enable"
  | "forbidden"
  | "supersede-keep"
  | "supersede-disable";

export type ChannelClaimCandidate = {
  pluginId: string;
  channelId: string;
  /** False for capability candidates (provider/model/tool/web-fetch/setup); default true. */
  channelClaim?: boolean;
};

/** A plugin's landed end state while the resolve pass walks the candidates, by policy id. */
type ClaimantFate = "enable" | "dead" | "kept";

/**
 * Resolves auto-enable's claimant decisions over one coherent end state. `decide` is called once
 * per candidate in discovery order; landed decisions become authoritative fates, and a superseder
 * that is still undecided resolves by rule instead of by the mid-pass config: an explicit claim
 * is kept when a live claim supersedes it (then it is live only if the post-repair completed
 * config activates it — `keptActivationConfig`) and is otherwise enabled by this same pass; an
 * implicit claim holds discovery-order seniority inside the channel group being decided and
 * inside its own group, but is dead the moment a surviving claim from any other channel
 * supersedes it — its disable is already certain, so it must not take its own victims with it
 * and leave a configured channel with no runtime owner. Explicit selection reads
 * `selectionConfig` so generated entries never count as operator choices; deny/disable reads use
 * the source `config` (the pass's own disables land as fates, never as config reads).
 */
export function createChannelClaimantResolution(params: {
  candidates: readonly ChannelClaimCandidate[];
  config: OpenClawConfig;
  selectionConfig: OpenClawConfig;
  keptActivationConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  registry: PluginManifestRegistry;
  /**
   * Policy ids whose claims start with a landed live fate: the planner's re-grounding pins, and
   * structural anchors (a configured channel's sole activatable claimant, which a replacement
   * elsewhere must never plugin-globally disable).
   */
  pinnedLiveClaimants?: ReadonlySet<string>;
}): {
  decide: (candidate: ChannelClaimCandidate) => ChannelClaimantDecision;
  isLiveDecision: (candidate: ChannelClaimCandidate, decision: ChannelClaimantDecision) => boolean;
  isClaimantLive: (pluginId: string) => boolean;
} {
  const fates = new Map<string, ClaimantFate>();
  // Re-grounding: when default grounding leaves a configured channel unowned, the planner pins a
  // claimant live and replays; every other claim then resolves against this landed fate exactly
  // as it honors any fate the pass itself lands.
  for (const pinnedId of params.pinnedLiveClaimants ?? []) {
    fates.set(pinnedId, "enable");
  }
  const preferOverCache = new Map<string, string[]>();
  // Kept-claim activation must read the completed config through the same legacy-alias fold the
  // runtime's registry-aware normalizer applies, or a legacy-keyed disable projects a kept claim
  // live while the runtime never loads it.
  const keptActivationPlugins = normalizePluginsConfigWithManifestAliases(
    params.keptActivationConfig.plugins,
    params.registry,
  );

  const groupOf = (candidate: ChannelClaimCandidate): string =>
    normalizeManifestChannelId(candidate.channelId);
  const sourceForbidden = (pluginId: string): boolean =>
    isPluginPolicyDenied(params.config, pluginId, params.registry) ||
    isPluginPolicyDisabled(params.config, pluginId, params.registry);
  const declaresPreferenceOver = (claimant: ChannelClaimCandidate, pluginId: string): boolean =>
    declaresPluginPreferenceOver(
      resolveChannelClaimPreferOver({
        pluginId: claimant.pluginId,
        channelId: claimant.channelId,
        env: params.env,
        registry: params.registry,
        cache: preferOverCache,
      }),
      pluginId,
    );

  const keptClaimActivated = (pluginId: string): boolean => {
    // Callers pass declared manifest ids AND normalized policy ids (the anchor's SCC scan works
    // in policy-id space), so the record resolves through the derived policy key.
    const keptPolicyId = normalizePluginPolicyId(pluginId);
    const record = params.registry.plugins.find(
      (plugin) => normalizePluginPolicyId(plugin.id) === keptPolicyId,
    );
    // A claim the registry cannot load can never serve a channel, so it never suppresses one an
    // installed plugin serves.
    if (!record) {
      return false;
    }
    return isActivatedManifestOwner({
      plugin: record,
      normalizedConfig: keptActivationPlugins,
      rootConfig: params.keptActivationConfig,
    });
  };

  // Whether an evaluation consulted the recursion stack (cycle grounding): such a result is
  // stack-relative and must not be memoized; every other result is pure within one decision.
  type LivenessFrame = { tainted: boolean };
  // Per-decision memo for superseder liveness. Landed fates are frozen while one candidate is
  // decided, so an untainted evaluation is a pure function of (plugin, channel) — without the
  // memo, every scan re-evaluates the full killer subtree and a dense replacement DAG grows as
  // 2^N: a few dozen installed replacement plugins stall gateway startup and config validation.
  let liveMemo = new Map<string, boolean>();

  // End-state liveness of `other`'s plugin as a superseder while `group` is being decided.
  // `stack` grounds supersession cycles: a dependency that loops back onto a claim already being
  // judged resolves it as live, so the earliest claim in discovery order holds the assumption —
  // the same seniority the runtime pass's candidate order applies within a group. Deterministic
  // for a given config and registry.
  const liveAsSuperseder = (
    other: ChannelClaimCandidate,
    group: string,
    stack: Set<string>,
    frame: LivenessFrame,
  ): boolean => {
    const policyId = normalizePluginPolicyId(other.pluginId);
    if (sourceForbidden(other.pluginId)) {
      return false;
    }
    const fate = fates.get(policyId);
    if (fate === "dead") {
      return false;
    }
    if (fate === "enable") {
      return true;
    }
    if (fate === "kept") {
      return keptClaimActivated(other.pluginId);
    }
    if (stack.has(policyId)) {
      frame.tainted = true;
      return true;
    }
    const memoKey = `${policyId}\0${groupOf(other)}`;
    const memoized = liveMemo.get(memoKey);
    if (memoized !== undefined) {
      return memoized;
    }
    const local: LivenessFrame = { tainted: false };
    stack.add(policyId);
    let live: boolean;
    try {
      if (
        isPluginSelectedWithAliases(params.selectionConfig.plugins, other.pluginId, params.registry)
      ) {
        // Superseded-by-live means kept: keep never writes config, so the claim serves its
        // channel only when the post-repair completed config activates it. Not superseded means
        // this same pass enables the claim before the runtime reads it.
        live = isSupersededByLiveClaim(other.pluginId, group, stack, null, local)
          ? keptClaimActivated(other.pluginId)
          : true;
      } else {
        // Implicit claims: kills from the deciding group and the claim's own group stay on that
        // group's discovery order (the shipped candidate-order contract); a surviving claim from
        // any other channel already seals this claim's disable.
        live = !isSupersededByLiveClaim(other.pluginId, group, stack, groupOf(other), local);
      }
    } finally {
      stack.delete(policyId);
    }
    if (local.tainted) {
      frame.tainted = true;
    } else {
      liveMemo.set(memoKey, live);
    }
    return live;
  };

  // True when a live claim supersedes `pluginId`. `seniorityGroup` non-null skips killers from
  // the deciding group and from that group — the implicit-claim seniority rule above. The skip
  // covers only killers still undecided in this pass: a killer whose fate already landed is
  // honored the way the base pass honored landed config writes, and a killer on the recursion
  // stack means the supersession chain loops back across channels, where the stack rule must
  // ground the whole cycle on the claim being decided. Skipping either resolves claims against
  // assumptions the landed end state contradicts and can enable two claimants of one channel
  // with a preferOver edge between them.
  const isSupersededByLiveClaim = (
    pluginId: string,
    group: string,
    stack: Set<string>,
    seniorityGroup: string | null,
    frame: LivenessFrame,
  ): boolean => {
    const policyId = normalizePluginPolicyId(pluginId);
    return params.candidates.some((candidate) => {
      const candidatePolicyId = normalizePluginPolicyId(candidate.pluginId);
      if (candidatePolicyId === policyId) {
        return false;
      }
      // The edge check comes first so the skip's stack consultation below only ever taints for a
      // candidate that actually kills this plugin — a non-killer on the stack is irrelevant to
      // the outcome, and tainting on it would defeat the liveness memo entirely.
      if (!declaresPreferenceOver(candidate, pluginId)) {
        return false;
      }
      if (seniorityGroup !== null && !fates.has(candidatePolicyId)) {
        const candidateGroup = groupOf(candidate);
        if (candidateGroup === group || candidateGroup === seniorityGroup) {
          if (!stack.has(candidatePolicyId)) {
            return false;
          }
          // The stack bypassed a skip that would otherwise fire: the outcome is stack-relative.
          frame.tainted = true;
        }
      }
      return liveAsSuperseder(candidate, group, stack, frame);
    });
  };

  // Channel-scoped supersession for a claim whose plugin fate already landed. The global check
  // above (an edge from ANY channel) is what kills a plugin; reusing it per claim would let a
  // sibling channel's edge suppress a claim no same-channel replacement contests — an anchored
  // sole claimant's own channel, or a revived plugin's uncontested claim. Only a live claimant
  // of THIS channel replaces the claim.
  const isClaimSupersededOnOwnChannel = (candidate: ChannelClaimCandidate): boolean => {
    const policyId = normalizePluginPolicyId(candidate.pluginId);
    const group = groupOf(candidate);
    return params.candidates.some((other) => {
      if (normalizePluginPolicyId(other.pluginId) === policyId) {
        return false;
      }
      if (groupOf(other) !== group || !declaresPreferenceOver(other, candidate.pluginId)) {
        return false;
      }
      return liveAsSuperseder(other, group, new Set([policyId]), { tainted: false });
    });
  };

  return {
    decide(candidate: ChannelClaimCandidate): ChannelClaimantDecision {
      const policyId = normalizePluginPolicyId(candidate.pluginId);
      // An operator-forbidden plugin never activates and its replacement claims are dead; a
      // supersede-disable landed by an earlier candidate forbids later claims of the same plugin.
      if (sourceForbidden(candidate.pluginId)) {
        fates.set(policyId, "dead");
        return "forbidden";
      }
      // A configured capability candidate is never superseded by `preferOver`: replacement
      // replaces a CHANNEL claim, not the plugin's other capabilities, so the capability enables
      // the plugin even when its channel claim already landed dead — the operator configured the
      // provider/tool, and losing it to a channel replacement is a silent capability removal.
      if (candidate.channelClaim === false) {
        fates.set(policyId, "enable");
        return "enable";
      }
      // A landed fate — dead, or enable from an earlier claim, a capability, a pin, or an
      // anchor — is authoritative for the PLUGIN: re-deciding it would flip-flop a liveness other
      // claims were resolved against. It does not land ownership of THIS channel: a live
      // same-channel replacement still supersedes the claim, and only a recorded
      // supersede-disable reaches loader suppression and the validation projection — a
      // plugin-level forbidden or enable here lets a loaded plugin's replaced claim race
      // first-wins registration over its planned replacement.
      const landedFate = fates.get(policyId);
      if (landedFate === "dead" || landedFate === "enable") {
        liveMemo = new Map();
        if (isClaimSupersededOnOwnChannel(candidate)) {
          return "supersede-disable";
        }
        return landedFate === "dead" ? "forbidden" : "enable";
      }
      // Each decision starts a fresh memo: the fates a decision lands invalidate liveness
      // computed for earlier candidates.
      liveMemo = new Map();
      const superseded = isSupersededByLiveClaim(
        candidate.pluginId,
        groupOf(candidate),
        new Set([policyId]),
        null,
        { tainted: false },
      );
      if (!superseded) {
        fates.set(policyId, "enable");
        return "enable";
      }
      if (
        isPluginSelectedWithAliases(
          params.selectionConfig.plugins,
          candidate.pluginId,
          params.registry,
        )
      ) {
        // A keep never downgrades a landed enable: the earlier candidate's enable write persists
        // in the completed config, so the plugin stays live for later liveness reads.
        if (fates.get(policyId) !== "enable") {
          fates.set(policyId, "kept");
        }
        return "supersede-keep";
      }
      fates.set(policyId, "dead");
      return "supersede-disable";
    },
    // The same liveness the resolver applies to superseders: an enable serves its channel, a
    // keep serves it only when the post-repair completed config activates the claim. The planner
    // reads this to spot channels whose candidates all landed dead.
    isLiveDecision(candidate: ChannelClaimCandidate, decision: ChannelClaimantDecision): boolean {
      if (decision === "enable") {
        return true;
      }
      return decision === "supersede-keep" && keptClaimActivated(candidate.pluginId);
    },
    // Plugin-level END-STATE liveness: the fate the completed pass landed. A claimant whose
    // channel claims died can still end enabled through a later capability candidate; enablement
    // is plugin-global, so a live plugin serves every channel it claims and its channels need no
    // fallback. Per-decision reads see only the mid-pass snapshot and miss this.
    isClaimantLive(pluginId: string): boolean {
      const fate = fates.get(normalizePluginPolicyId(pluginId));
      if (fate === "enable") {
        return true;
      }
      return fate === "kept" && keptClaimActivated(pluginId);
    },
  };
}
