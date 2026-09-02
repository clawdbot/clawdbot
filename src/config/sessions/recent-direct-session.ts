import {
  isAcpSessionKey,
  isCronSessionKey,
  isSubagentSessionKey,
} from "../../sessions/session-key-utils.js";
import {
  deliveryContextFromSession,
  hasDeliveryTargetFields,
  sessionDeliveryOrigin,
} from "../../utils/delivery-context.shared.js";
import { isDeliverableMessageChannel } from "../../utils/message-channel-normalize.js";
import type { SessionEntry } from "./types.js";

/** Select a real operator conversation, never background activity or inherited child routing. */
export function findMostRecentDirectSessionWithRoute(
  store: Record<string, SessionEntry>,
): string | undefined {
  let latest: { key: string; lastInteractionAt: number } | undefined;
  for (const [key, entry] of Object.entries(store)) {
    const { lastInteractionAt } = entry;
    const context = deliveryContextFromSession(entry);
    if (
      key === "global" ||
      key === "unknown" ||
      isCronSessionKey(key) ||
      isAcpSessionKey(key) ||
      isSubagentSessionKey(key) ||
      entry.spawnedBy ||
      entry.parentSessionKey ||
      entry.heartbeatIsolatedBaseSessionKey ||
      entry.swarmCollector ||
      entry.archivedAt !== undefined ||
      entry.incognito ||
      typeof lastInteractionAt !== "number" ||
      !Number.isFinite(lastInteractionAt) ||
      lastInteractionAt <= 0 ||
      !hasDeliveryTargetFields(context) ||
      !isDeliverableMessageChannel(context.channel) ||
      (sessionDeliveryOrigin(entry)?.chatType ?? entry.chatType) !== "direct"
    ) {
      continue;
    }
    if (
      !latest ||
      lastInteractionAt > latest.lastInteractionAt ||
      (lastInteractionAt === latest.lastInteractionAt && key < latest.key)
    ) {
      latest = { key, lastInteractionAt };
    }
  }
  return latest?.key;
}
