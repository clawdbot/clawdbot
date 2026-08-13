// Reads a manifest record's channel replacement preference without pulling in the registry builder.
import type { PluginManifestRecord } from "./manifest-registry.js";

/**
 * Manifest-declared `preferOver` ids for one channel on one record. A channel-specific
 * declaration wins over the record's catalog-level one so a plugin can replace a single channel
 * without claiming every channel it ships. Shared so schema ownership and auto-enable read the
 * same declaration; two copies of this precedence would let the validator and the runtime
 * disagree about which plugin owns a channel. It lives outside `manifest-registry.ts` because
 * config validation reads it on a cold path that must not load the registry builder.
 */
export function resolveManifestChannelPreferOverIds(
  record: PluginManifestRecord,
  channelId: string,
): readonly string[] {
  const channelPreferOver = record.channelConfigs?.[channelId]?.preferOver;
  if (channelPreferOver?.length) {
    return channelPreferOver;
  }
  // Catalog metadata describes exactly one channel, so its preference must not leak to the other
  // channels the same plugin ships — otherwise a preference declared for channel A lets the plugin
  // claim channel B. The runtime facade gates catalog metadata the same way (see
  // resolveManifestChannelPlugin in src/channels/plugins/read-only.ts).
  if (record.channelCatalogMeta?.id !== channelId) {
    return [];
  }
  return record.channelCatalogMeta.preferOver ?? [];
}
