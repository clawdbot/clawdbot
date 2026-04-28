import { normalizeOptionalString } from "./string-coerce.js";

export const NODE_PRESENCE_ALIVE_EVENT = "node.presence.alive";

export const NODE_PRESENCE_ALIVE_REASONS = [
  "background",
  "silent_push",
  "bg_app_refresh",
  "significant_location",
  "manual",
  "connect",
] as const;

export type NodePresenceAliveReason = (typeof NODE_PRESENCE_ALIVE_REASONS)[number];

const NODE_PRESENCE_ALIVE_REASON_SET = new Set<string>(NODE_PRESENCE_ALIVE_REASONS);

export function normalizeNodePresenceAliveReason(value: unknown): NodePresenceAliveReason {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized && NODE_PRESENCE_ALIVE_REASON_SET.has(normalized)) {
    return normalized as NodePresenceAliveReason;
  }
  return "background";
}
