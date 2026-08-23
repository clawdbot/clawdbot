// Line plugin module implements group history behavior.
import { createChannelHistoryWindow, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";

type LineGroupHistoryReservation = {
  inboundHistory?: HistoryEntry[];
  commit: () => void;
  release: () => void;
};

// Entries stay in the bounded history map while a turn owns them so failed
// turns need no reinsertion or ordering repair. Other overlapping turns skip
// these exact objects until the owner commits or releases the reservation.
const reservedEntries = new WeakSet<HistoryEntry>();

// Fire-and-forget webhook dispatch runs group events in parallel, so a plain
// (unmentioned) message can be recorded while the agent is still handling a
// mention. Reserve the available entry objects and render their bounded window
// in one synchronous step. Object identity distinguishes otherwise identical
// concurrent messages without serializing whole agent turns.
export function reserveLineGroupHistory(
  historyMap: Map<string, HistoryEntry[]> | undefined,
  historyKey: string | undefined,
  limit: number,
): LineGroupHistoryReservation {
  if (!historyMap || !historyKey || limit <= 0) {
    return { commit: () => {}, release: () => {} };
  }
  const consumedEntries = (historyMap.get(historyKey) ?? []).filter(
    (entry) => !reservedEntries.has(entry),
  );
  for (const entry of consumedEntries) {
    reservedEntries.add(entry);
  }
  const inboundHistory = createChannelHistoryWindow({
    historyMap: new Map([[historyKey, consumedEntries]]),
  }).buildInboundHistory({
    historyKey,
    limit,
  });
  let settled = false;
  const settle = () => {
    if (settled) {
      return false;
    }
    settled = true;
    for (const entry of consumedEntries) {
      reservedEntries.delete(entry);
    }
    return true;
  };
  return {
    inboundHistory,
    commit: () => {
      if (!settle() || consumedEntries.length === 0) {
        return;
      }
      const consumed = new Set(consumedEntries);
      const kept = (historyMap.get(historyKey) ?? []).filter((entry) => !consumed.has(entry));
      if (kept.length > 0) {
        historyMap.set(historyKey, kept);
      } else {
        historyMap.delete(historyKey);
      }
    },
    release: () => {
      settle();
    },
  };
}
