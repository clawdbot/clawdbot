// Decides whether operator policy has switched a plugin off for auto-enable and channel ownership.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
  isRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/registry.js";
import { isBundledChannelEnabledByChannelConfig } from "../plugins/config-normalization-shared.js";
import { normalizePluginId } from "../plugins/config-state.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { normalizeSlotValue, resolveSlotSelection } from "../plugins/slots.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/**
 * Resolves an operator-written id to the plugin that owns it. The default knows the built-in
 * aliases only; callers holding a manifest registry pass
 * `createManifestPluginAliasResolver` so a policy entry written as a channel id or a
 * `legacyPluginIds` entry lands on the same plugin Gateway startup picks.
 */
type PluginAliasResolver = (pluginId: string) => string;

function toPolicyId(pluginId: string, resolveAlias: PluginAliasResolver | undefined): string {
  // The registry resolver already falls back to the built-in fold for keys the registry does not
  // know, so folding again after it would rewrite an installed plugin whose exact id is a fold
  // key ("minimax-portal") onto the bundled owner — a plugin the runtime keeps running.
  return resolveAlias ? resolveAlias(pluginId) : normalizePluginId(pluginId);
}

/**
 * Whether the operator switched this plugin off: plugins disabled globally, denied, entry-disabled,
 * or — for a bundled channel plugin — disabled through its channel config. Auto-enable ignores such
 * a plugin and activates the fallback instead, so channel schema ownership must apply the same
 * filter or validation checks the fallback's config against the disabled plugin's schema and
 * rejects it.
 *
 * `plugins.deny` entries and `plugins.entries` keys are canonicalized only once the config is
 * normalized, so a raw lookup would miss a `deny: [" MODERN "]` that the loader honors. Comparing
 * through `normalizePluginId` (and `resolveAlias` where a registry is available) keeps this on the
 * loader's policy view without materializing the whole normalized config for every plugin id.
 */
export function isPluginPolicyDisabled(
  cfg: OpenClawConfig,
  pluginId: string,
  resolveAlias?: PluginAliasResolver,
): boolean {
  // The global switch stops all plugin discovery and load work, so no plugin is active enough to
  // take a channel from another. Auto-enable returns early on the same flag.
  if (cfg.plugins?.enabled === false) {
    return true;
  }
  const policyId = toPolicyId(pluginId, resolveAlias);
  const matchesPolicyId = (rawId: string): boolean => toPolicyId(rawId, resolveAlias) === policyId;
  const deny = cfg.plugins?.deny;
  if (Array.isArray(deny) && deny.some(matchesPolicyId)) {
    return true;
  }
  // Colliding keys merge rather than replace: `normalizePluginEntries` keeps an earlier boolean
  // when the later entry omits one, so an alias entry with no `enabled` must not erase a canonical
  // `enabled: false`. Read every match and let only a boolean overwrite.
  let entryEnabled: boolean | undefined;
  for (const [key, entry] of Object.entries(asOptionalObjectRecord(cfg.plugins?.entries) ?? {})) {
    const enabled = asOptionalRecord(entry)?.enabled;
    if (typeof enabled === "boolean" && matchesPolicyId(key)) {
      entryEnabled = enabled;
    }
  }
  if (entryEnabled === false) {
    return true;
  }
  const builtInChannelId = normalizeChatChannelId(policyId);
  if (!builtInChannelId) {
    return false;
  }
  const channels = asOptionalRecord(cfg.channels);
  return asOptionalRecord(channels?.[builtInChannelId])?.enabled === false;
}

function hasMaterialPluginEntryConfig(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return (
    entry.enabled === true ||
    isRecord(entry.config) ||
    isRecord(entry.hooks) ||
    isRecord(entry.subagent) ||
    isRecord(entry.llm) ||
    entry.apiKey !== undefined ||
    entry.env !== undefined
  );
}

/**
 * Whether the operator selected this plugin by hand rather than letting auto-enable decide.
 * Auto-enable leaves such a plugin enabled even when another claimant declares it in `preferOver`
 * (see `disableImplicitPreferredOverPlugin`), so both stay active and channel ownership falls back
 * to registration order.
 */
/**
 * Whether the operator hand-picked this plugin, matching however they spelled it.
 *
 * `plugins.allow` and `plugins.entries` are written by hand, so the same plugin can appear under a
 * legacy or channel alias. Comparing a canonical id against those raw spellings misses the
 * selection, and callers then disagree about whether the operator hand-picked the plugin.
 *
 * Entries are checked by scanning every spelling that canonicalizes onto the plugin rather than by
 * folding them into one map: startup field-merges alias collisions, so a later empty alias must not
 * be able to mask an earlier material entry.
 */
export function isPluginExplicitlySelectedByAlias(
  cfg: OpenClawConfig,
  pluginId: string,
  canonicalId: (id: string) => string,
  manifestRegistry?: PluginManifestRegistry,
): boolean {
  const target = canonicalId(pluginId);
  // `config-activation-shared.ts` also counts `channels.<id>.enabled: true` on a bundled plugin as
  // explicit selection. Omitting it here let the caller synthesize `plugins.entries.<id>.enabled:
  // false` over that choice while ownership ceded the channel, switching away from the operator's
  // pick. Gated on bundled origin so this stays exactly as wide as activation, no wider.
  if (
    manifestRegistry?.plugins.some(
      (plugin) => plugin.origin === "bundled" && canonicalId(plugin.id) === target,
    ) &&
    isBundledChannelEnabledByChannelConfig(cfg, pluginId)
  ) {
    return true;
  }
  // Both capability slots are explicit-selection causes in the activation contract, and activation
  // reads entry disablement before it reaches those branches.
  //
  // The two slots differ on an unset value and startup is the contract to match, not
  // `resolveSlotSelection`: `resolveMemorySlotStartupPluginId` falls back to the resolved default
  // when nothing is authored, while `resolveContextEngineSlotStartupPluginId` returns undefined.
  // Promoting the unset context-engine default marked whichever plugin carries that id explicitly
  // selected and suppressed a replacement's edge for a plugin startup never selects.
  const slots = cfg.plugins?.slots;
  // The context-engine slot is the one explicit-selection cause the workspace gate exempts, so it
  // selects even for an untrusted workspace plugin.
  //
  // Matched exactly, not through the resolver: startup canonicalizes an authored slot only to
  // decide which plugins to *consider* (`resolveContextEngineSlotStartupPluginId`), while the
  // activation cause this predicate mirrors is an exact match on the authored spelling —
  // normalization leaves slot values raw (`config-normalization-shared.ts`) and the cause
  // requires `slots.contextEngine === params.id` (`config-activation-shared.ts`). A slot
  // authored as a legacy alias therefore selects nothing, and the workspace gate disables the
  // claimant no matter how it was considered. Resolving the alias here marked that claimant
  // hand-picked while the runtime never loads it.
  const authoredContextEngine = normalizeSlotValue(slots?.contextEngine);
  if (authoredContextEngine && authoredContextEngine === target) {
    return true;
  }
  // The memory branch sits *after* that gate, so it never rescues a workspace plugin that is
  // neither allowlisted nor entry-enabled: startup returns `workspace-disabled-by-default` first.
  // Reading slot presence alone marked such a plugin selected here while the runtime never loads
  // it, which is the disagreement this predicate exists to prevent, pointing the other way.
  //
  // This arm still resolves the authored value through the resolver, and the memory activation
  // cause is the same exact match — the divergence fixed on the context-engine arm above is
  // latent here, not absent. No bundled memory plugin declares `legacyPluginIds`, so firing it
  // takes an externally installed legacy-aliased memory plugin; deferred on that basis.
  const memorySelection = resolveSlotSelection("memory", slots?.memory);
  if (memorySelection.kind !== "off" && canonicalId(memorySelection.pluginId) === target) {
    const isWorkspaceOrigin =
      manifestRegistry?.plugins.some(
        (plugin) => plugin.origin === "workspace" && canonicalId(plugin.id) === target,
      ) === true;
    const trustedByPolicy =
      (Array.isArray(cfg.plugins?.allow) &&
        cfg.plugins.allow.some((id) => typeof id === "string" && canonicalId(id) === target)) ||
      Object.entries(cfg.plugins?.entries ?? {}).some(
        ([writtenId, entry]) =>
          canonicalId(writtenId) === target && isRecord(entry) && entry.enabled === true,
      );
    if (!isWorkspaceOrigin || trustedByPolicy) {
      return true;
    }
  }
  // Activation gates its allowlist cause on non-bundled origin (`resolveExplicitPluginSelectionShared`,
  // "selected-in-allowlist"): for a bundled plugin the allowlist only permits loading, so a
  // disabled-by-default bundled fallback merely listed in `plugins.allow` stays off
  // ("bundled-disabled-by-default"). Counting the listing as selection here set aside the
  // replacement's edge and preserved a fallback the runtime never loads. A caller with no
  // registry cannot see origin and keeps the wide reading.
  const allow = cfg.plugins?.allow;
  if (
    Array.isArray(allow) &&
    allow.some((id) => typeof id === "string" && canonicalId(id) === target) &&
    !manifestRegistry?.plugins.some(
      (plugin) => plugin.origin === "bundled" && canonicalId(plugin.id) === target,
    )
  ) {
    return true;
  }
  return Object.entries(cfg.plugins?.entries ?? {}).some(
    ([writtenId, entry]) =>
      canonicalId(writtenId) === target && hasMaterialPluginEntryConfig(entry),
  );
}
