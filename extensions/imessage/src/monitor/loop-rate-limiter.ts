/**
 * Per-conversation rate limiter that detects rapid-fire identical echo
 * patterns and suppresses them before they amplify into queue overflow.
 */

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_HITS = 5;
const CLEANUP_INTERVAL_MS = 120_000;

type ConversationWindow = {
  timestamps: number[];
};

export type LoopRateLimiter = {
  /** Returns true if this conversation has exceeded the rate limit. */
  isRateLimited: (conversationKey: string) => boolean;
  /** Record an inbound message for a conversation. */
  record: (conversationKey: string) => void;
};

export function createLoopRateLimiter(opts?: {
  windowMs?: number;
  maxHits?: number;
}): LoopRateLimiter {
  const windowMs = opts?.windowMs ?? DEFAULT_WINDOW_MS;
  const maxHits = opts?.maxHits ?? DEFAULT_MAX_HITS;
  const conversations = new Map<string, ConversationWindow>();
  let lastCleanup = Date.now();

  function cleanup() {
    const now = Date.now();
    if (now - lastCleanup < CLEANUP_INTERVAL_MS) {
      return;
    }
    lastCleanup = now;
    for (const [key, win] of conversations.entries()) {
      const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
      if (recent.length === 0) {
        conversations.delete(key);
      } else {
        win.timestamps = recent;
      }
    }
  }

  return {
    record(conversationKey: string) {
      cleanup();
      let win = conversations.get(conversationKey);
      if (!win) {
        win = { timestamps: [] };
        conversations.set(conversationKey, win);
      }
      win.timestamps.push(Date.now());
    },

    isRateLimited(conversationKey: string): boolean {
      cleanup();
      const win = conversations.get(conversationKey);
      if (!win) {
        return false;
      }
      const now = Date.now();
      const recent = win.timestamps.filter((ts) => now - ts <= windowMs);
      win.timestamps = recent;
      return recent.length >= maxHits;
    },
  };
}
