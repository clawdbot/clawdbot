// Decides whether operator policy has switched a plugin off for auto-enable and channel ownership.
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { normalizeChatChannelId } from "../channels/registry.js";
import { normalizePluginId } from "../plugins/config-state.js";
import type { OpenClawConfig } from "./types.openclaw.js";

function matchesPolicyId(rawId: string, policyId: string): boolean {
  return normalizePluginId(rawId) === policyId;
}

/**
 * Whether the operator switched this plugin off: denied, entry-disabled, or — for a bundled
 * channel plugin — disabled through its channel config. Auto-enable ignores such a plugin and
 * activates the fallback instead, so channel schema ownership must apply the same filter or
 * validation checks the fallback's config against the disabled plugin's schema and rejects it.
 *
 * `plugins.deny` entries and `plugins.entries` keys are lowercased and alias-resolved only once
 * the config is normalized, so a raw lookup would miss a `deny: [" MODERN "]` that the loader
 * honors. Comparing through `normalizePluginId` keeps this on the loader's policy view without
 * materializing the whole normalized config for every plugin id.
 */
export function isPluginPolicyDisabled(cfg: OpenClawConfig, pluginId: string): boolean {
  const policyId = normalizePluginId(pluginId);
  const deny = cfg.plugins?.deny;
  if (Array.isArray(deny) && deny.some((entry) => matchesPolicyId(entry, policyId))) {
    return true;
  }
  // Normalization keeps the last colliding key, so read every match rather than the first.
  let entryEnabled: unknown;
  for (const [key, entry] of Object.entries(asOptionalObjectRecord(cfg.plugins?.entries) ?? {})) {
    if (matchesPolicyId(key, policyId)) {
      entryEnabled = asOptionalRecord(entry)?.enabled;
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
