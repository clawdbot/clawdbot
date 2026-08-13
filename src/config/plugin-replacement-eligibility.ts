// Decides whether operator policy has switched a plugin off for auto-enable and channel ownership.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizePluginId } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/**
 * Resolves an operator-written id to the plugin that owns it. The default knows the built-in
 * aliases only; callers holding a manifest registry pass
 * `createManifestPluginAliasResolver` so a policy entry written as a channel id or a
 * `legacyPluginIds` entry lands on the same plugin Gateway startup picks.
 */
type PluginAliasResolver = (pluginId: string) => string;

function toPolicyId(pluginId: string, resolveAlias: PluginAliasResolver | undefined): string {
  return normalizePluginId(resolveAlias ? resolveAlias(pluginId) : pluginId);
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
  const channels = cfg.channels as Record<string, unknown> | undefined;
  return asOptionalRecord(channels?.[builtInChannelId])?.enabled === false;
}
