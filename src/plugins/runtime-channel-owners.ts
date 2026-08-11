// Landed channel ownership from the process's active plugin registry.
import { normalizeManifestChannelId } from "../config/channel-claimant-plugins.js";
import { getActivePluginRegistry } from "./runtime.js";

/**
 * Maps canonical channel ids to the plugin whose registration actually serves them in this
 * process. Registration is first-wins and a failed replacement's contributions roll back before
 * the suppressed incumbent is restored, so each channel carries exactly the plugin the runtime
 * answers with — schema projections consume this so validation and advertised schemas follow
 * the LANDED owner instead of a prediction the load already contradicted. Returns undefined
 * outside a gateway process (no active registry), keeping those callers predictive.
 */
export function resolveActiveRuntimeChannelOwners(): ReadonlyMap<string, string> | undefined {
  const registry = getActivePluginRegistry();
  if (!registry || registry.channels.length === 0) {
    return undefined;
  }
  const owners = new Map<string, string>();
  for (const entry of registry.channels) {
    const channelId = normalizeManifestChannelId(entry.plugin.id);
    if (!owners.has(channelId)) {
      owners.set(channelId, entry.pluginId);
    }
  }
  return owners;
}
