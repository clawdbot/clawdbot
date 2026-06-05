// Channel id normalization through the active plugin registry.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelId } from "./plugins/channel-id.types.js";
import { findRegisteredChannelPluginEntry } from "./registry-lookup.js";

/** Normalizes user/config channel identifiers so aliases resolve to canonical channel ids. */
export function normalizeAnyChannelId(raw?: string | null): ChannelId | null {
  const key = normalizeOptionalLowercaseString(raw);
  if (!key) {
    return null;
  }
  return findRegisteredChannelPluginEntry(key)?.plugin.id ?? null;
}
