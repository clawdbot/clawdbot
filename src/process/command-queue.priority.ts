import { STARVATION_PROMOTION_MS } from "./lanes.js";

/** Leaf ranking shape. Do not import command-queue.state (madge cycle). */
type QueueHead = {
  priority: number;
  enqueuedAt: number;
  sequence: number;
};

/** Numeric priority for user/foreground work. Must stay above aged lower tiers. */
const FOREGROUND_QUEUE_PRIORITY = 1;

/**
 * Promote entries that have waited longer than STARVATION_PROMOTION_MS by one
 * tier, capped strictly below foreground so fresh user work still wins.
 */
export function effectivePriority(entry: QueueHead): number {
  if (entry.priority >= FOREGROUND_QUEUE_PRIORITY) {
    return entry.priority;
  }
  if (Date.now() - entry.enqueuedAt >= STARVATION_PROMOTION_MS) {
    return Math.min(entry.priority + 1, FOREGROUND_QUEUE_PRIORITY - 1);
  }
  return entry.priority;
}

/**
 * Highest effective priority wins. Ties break by enqueue time, then sequence.
 * Used to choose among ring heads without scanning or moving ring membership.
 */
export function pickNextAmongHeads<T extends QueueHead>(heads: readonly T[]): T | undefined {
  const first = heads[0];
  if (!first) {
    return undefined;
  }
  let best = first;
  let bestPri = effectivePriority(first);
  for (let i = 1; i < heads.length; i++) {
    const candidate = heads[i];
    if (!candidate) {
      continue;
    }
    const pri = effectivePriority(candidate);
    if (
      pri > bestPri ||
      (pri === bestPri &&
        (candidate.enqueuedAt < best.enqueuedAt ||
          (candidate.enqueuedAt === best.enqueuedAt && candidate.sequence < best.sequence)))
    ) {
      best = candidate;
      bestPri = pri;
    }
  }
  return best;
}
