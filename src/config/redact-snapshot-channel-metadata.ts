import { normalizeOwnedChannelId } from "../channels/ids.js";
import type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

/**
 * Normalizes one child key of the root `channels` container.
 *
 * Callers that still hold the object key must use this rather than
 * `normalizeChannelMetadataPath`: a channel id may itself contain dots (`channels` accepts any
 * trimmed string), so once the key is joined into a path there is no way to tell `Acme.Chat`'s
 * field `botToken` from channel `Acme`'s field `Chat.botToken`.
 */
export function normalizeChannelMetadataContainerKey(channelId: string): string {
  // These are core channel-container keys, not channel ownership ids. Every other key must match
  // the canonical metadata key while the result object keeps its authored spelling.
  if (
    !channelId ||
    channelId === "*" ||
    channelId === "defaults" ||
    channelId === "modelByChannel"
  ) {
    return channelId;
  }
  return normalizeOwnedChannelId(channelId);
}

/**
 * Best-effort normalization of an already-joined `channels.<id>...` path.
 *
 * This can only assume the id ends at the first dot. Prefer
 * `normalizeChannelMetadataContainerKey` wherever the object key is still in hand — a dotted id
 * normalized through here keeps the authored casing of every segment after the first dot, which
 * does not match the fully normalized key ownership metadata is stored under.
 */
export function normalizeChannelMetadataPath(path: string): string {
  const prefix = "channels.";
  if (!path.startsWith(prefix)) {
    return path;
  }
  const separator = path.indexOf(".", prefix.length);
  const end = separator === -1 ? path.length : separator;
  const channelId = path.slice(prefix.length, end);
  const normalized = normalizeChannelMetadataContainerKey(channelId);
  if (normalized === channelId) {
    return path;
  }
  return `${prefix}${normalized}${path.slice(end)}`;
}

function mergeRedactionHint(current: ConfigUiHint, incoming: ConfigUiHint): ConfigUiHint {
  const merged = { ...current, ...incoming };
  const tags = new Set([...(current.tags ?? []), ...(incoming.tags ?? [])]);
  if (tags.size > 0) {
    merged.tags = [...tags];
  }
  if (current.sensitive === true || incoming.sensitive === true) {
    merged.sensitive = true;
  } else if (current.sensitive === false || incoming.sensitive === false) {
    merged.sensitive = false;
  }
  return merged;
}

export function normalizeChannelMetadataHints(hints: ConfigUiHints): ConfigUiHints {
  // Hints describe an owned field rather than one authored spelling, so sensitive=false must
  // suppress heuristics across aliases just as sensitive=true must redact them. On collisions,
  // mergeRedactionHint makes true win so an alias cannot downgrade an explicitly sensitive path.
  const entries = Object.entries(hints);
  if (entries.every(([path]) => normalizeChannelMetadataPath(path) === path)) {
    return hints;
  }
  const normalized: ConfigUiHints = {};
  for (const [path, hint] of entries) {
    const metadataPath = normalizeChannelMetadataPath(path);
    const current = normalized[metadataPath];
    normalized[metadataPath] = current ? mergeRedactionHint(current, hint) : hint;
  }
  return normalized;
}
