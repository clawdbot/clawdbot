// One-shot entry animation for freshly submitted user turns.
import { isPendingSendMessage } from "../chat-thread.ts";

/** One-shot entry animation state for submitted user turns, keyed by message
 * key (send identity). An entry records first sight for the send's lifetime —
 * value is the animation start, or 0 for seen-without-animating — so
 * re-renders during the animation keep the class while later renders or
 * virtualizer remounts of the same (possibly still pending) row never replay
 * it. Insertion-ordered cap bounds the map instead of time-based pruning,
 * which would forget long-lived pending rows; keys are per-send UUIDs, so the
 * map is never reset across panes or sessions. */
const userTurnEntrySeenByMessageKey = new Map<string, number>();
const USER_TURN_ENTRY_ANIMATION_WINDOW_MS = 400;
/** Only just-submitted bubbles animate; restored outbox rows render still.
 * Accepted tradeoff: a full page reload within this window re-animates the
 * just-submitted bubble once, which matches the fresh paint around it. */
const USER_TURN_ENTRY_FRESH_SUBMIT_MS = 2_000;
const USER_TURN_ENTRY_SEEN_CAP = 256;

export function shouldAnimateUserTurnEntry(messageKey: string, message: unknown): boolean {
  const now = Date.now();
  const seen = userTurnEntrySeenByMessageKey.get(messageKey);
  if (seen !== undefined) {
    return seen > 0 && now - seen < USER_TURN_ENTRY_ANIMATION_WINDOW_MS;
  }
  // Only a locally pending submit starts the animation; loaded history and
  // remote echoes render without one.
  if (!isPendingSendMessage(message)) {
    return false;
  }
  // SAFETY: reads timestamp as unknown; the typeof check below validates it.
  const submittedAt = (message as { timestamp?: unknown }).timestamp;
  const freshSubmit =
    typeof submittedAt === "number" && now - submittedAt < USER_TURN_ENTRY_FRESH_SUBMIT_MS;
  while (userTurnEntrySeenByMessageKey.size >= USER_TURN_ENTRY_SEEN_CAP) {
    const oldest = userTurnEntrySeenByMessageKey.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    userTurnEntrySeenByMessageKey.delete(oldest);
  }
  userTurnEntrySeenByMessageKey.set(messageKey, freshSubmit ? now : 0);
  return freshSubmit;
}
