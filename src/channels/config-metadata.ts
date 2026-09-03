const CHANNEL_CONFIG_METADATA_KEYS = new Set(["defaults", "modelByChannel"]);

/** Returns true when a channels key contains shared metadata rather than a channel entry. */
export function isChannelConfigMetadataKey(value: string): boolean {
  return CHANNEL_CONFIG_METADATA_KEYS.has(value.trim());
}
