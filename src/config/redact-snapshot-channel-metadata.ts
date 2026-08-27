import { normalizeOwnedChannelId } from "../channels/ids.js";
import type { ConfigUiHint, ConfigUiHints } from "../shared/config-ui-hints-types.js";

export function normalizeChannelMetadataPath(path: string): string {
  const prefix = "channels.";
  if (!path.startsWith(prefix)) {
    return path;
  }
  const separator = path.indexOf(".", prefix.length);
  const end = separator === -1 ? path.length : separator;
  const channelId = path.slice(prefix.length, end);
  // These are core channel-container keys, not channel ownership ids. Every other first segment
  // must match the canonical metadata key while the result object keeps its authored spelling.
  if (
    !channelId ||
    channelId === "*" ||
    channelId === "defaults" ||
    channelId === "modelByChannel"
  ) {
    return path;
  }
  return `${prefix}${normalizeOwnedChannelId(channelId)}${path.slice(end)}`;
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
