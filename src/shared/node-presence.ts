// Node presence helpers normalize live node presence and heartbeat metadata.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { NODE_PRESENCE_ALIVE_REASONS } from "../../packages/gateway-protocol/src/node-presence.js";
import type { NodePresenceAliveReason } from "../../packages/gateway-protocol/src/schema/nodes.js";

/** Gateway event name used by node hosts to refresh their last-seen presence. */
export const NODE_PRESENCE_ALIVE_EVENT = "node.presence.alive";

/** Gateway event name used by interactive nodes to report recent local input. */
export const NODE_PRESENCE_ACTIVITY_EVENT = "node.presence.activity";

const NODE_PRESENCE_ALIVE_REASON_SET = new Set<string>(Object.values(NODE_PRESENCE_ALIVE_REASONS));

/** Normalizes untrusted presence trigger values, defaulting unknown input to background. */
export function normalizeNodePresenceAliveReason(value: unknown): NodePresenceAliveReason {
  const normalized = normalizeOptionalString(value)?.toLowerCase();
  if (normalized && NODE_PRESENCE_ALIVE_REASON_SET.has(normalized)) {
    return normalized as NodePresenceAliveReason;
  }
  return "background";
}
