import { isCronSessionKey } from "./session-key-utils.js";

export type SessionKind = "cron" | "direct" | "group" | "global" | "spawn-child" | "unknown";

/**
 * Classify a session key + entry into a display kind.
 *
 * Evaluation order matters — more-specific signals take priority:
 *   1. sentinel keys ("global", "unknown")
 *   2. cron key shape
 *   3. spawn-child (entry has `spawnedBy`) — checked before key-shape so ACP
 *      spawn-child sessions with opaque keys are not misclassified as "direct"
 *   4. group/channel chatType or key-shape substring
 *   5. fallback: "direct"
 */
export function classifySessionKind(
  key: string,
  entry?: { chatType?: string | null; spawnedBy?: string | null },
): SessionKind {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (isCronSessionKey(key)) {
    return "cron";
  }
  if (entry?.spawnedBy) {
    return "spawn-child";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}
