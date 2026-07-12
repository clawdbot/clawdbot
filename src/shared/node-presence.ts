// Node presence helpers normalize live node presence and heartbeat metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Gateway event name used by node hosts to refresh their last-seen presence. */
export const NODE_PRESENCE_ALIVE_EVENT = "node.presence.alive";

/** Gateway event name used by interactive nodes to report recent local input. */
export const NODE_PRESENCE_ACTIVITY_EVENT = "node.presence.activity";

/** Reasons accepted from native/background node presence events. */
const NODE_PRESENCE_ALIVE_REASONS = [
  "background",
  "silent_push",
  "bg_app_refresh",
  "significant_location",
  "manual",
  "connect",
] as const;

/** Canonical trigger reason stored with node presence updates. */
type NodePresenceAliveReason = (typeof NODE_PRESENCE_ALIVE_REASONS)[number];

const NODE_PRESENCE_ALIVE_REASON_SET = new Set<string>(NODE_PRESENCE_ALIVE_REASONS);

/** Normalizes untrusted presence trigger values, defaulting unknown input to background. */
export function normalizeNodePresenceAliveReason(value: unknown): NodePresenceAliveReason {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized && NODE_PRESENCE_ALIVE_REASON_SET.has(normalized)) {
    return normalized as NodePresenceAliveReason;
  }
  return "background";
}
