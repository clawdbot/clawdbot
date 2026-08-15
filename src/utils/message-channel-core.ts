// Message channel core helpers normalize channel families and internal ids.
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatChannelId } from "../channels/ids.js";
import { normalizeAnyChannelId } from "../channels/registry-normalize.js";
import { INTERNAL_MESSAGE_CHANNEL } from "./message-channel-constants.js";

/**
 * Shared message-channel normalization for delivery, routing, config, and gateway headers.
 *
 * Built-in aliases normalize through channel ids, while plugin-owned channel ids
 * stay accepted even when core has no bundled alias for them.
 */

/** Normalizes raw channel names, aliases, and internal webchat into canonical ids. */
export function normalizeMessageChannel(raw?: string | null): string | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  if (!normalized) {
    return undefined;
  }
  if (normalized === INTERNAL_MESSAGE_CHANNEL) {
    return INTERNAL_MESSAGE_CHANNEL;
  }
  const builtIn = normalizeChatChannelId(normalized);
  if (builtIn) {
    return builtIn;
  }
  // Preserve unknown-but-normalized ids so external plugin channels can route
  // before their full runtime is loaded.
  return normalizeAnyChannelId(normalized) ?? normalized;
}

/** Returns true for already-normalized channel ids except internal webchat. */
export function isNormalizedMessageChannel(value: string): boolean {
  const normalized = normalizeMessageChannel(value);
  return (
    normalized !== undefined && normalized !== INTERNAL_MESSAGE_CHANNEL && normalized === value
  );
}
