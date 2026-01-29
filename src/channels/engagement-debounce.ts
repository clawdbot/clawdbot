/**
 * Debounce manager for engagement mode.
 *
 * Collects messages in bursts and processes them together after a quiet period.
 * This ensures the agent sees the full conversation context, not fragmented triggers.
 */

import type { EngagementState } from "../config/engagement.js";

export type PendingMessage<T> = {
  message: T;
  timestamp: number;
  /** Whether this message triggered engagement (vs just collected for context) */
  triggered: boolean;
  /** Engagement state to persist after processing */
  nextState?: EngagementState;
};

export type DebounceConfig = {
  /** Time to wait after last message before processing (ms) */
  debounceMs: number;
  /** Maximum time to wait before processing regardless of new messages (ms) */
  maxWaitMs: number;
};

export type DebounceBatch<T> = {
  messages: PendingMessage<T>[];
  firstMessageAt: number;
  lastMessageAt: number;
};

type GroupDebounceState<T> = {
  pending: PendingMessage<T>[];
  timer: ReturnType<typeof setTimeout> | null;
  firstMessageAt: number;
  maxWaitTimer: ReturnType<typeof setTimeout> | null;
};

export type DebounceManager<T> = {
  /**
   * Add a message to the pending batch.
   * Returns true if this is the first message (batch just started).
   */
  addMessage: (groupKey: string, message: PendingMessage<T>) => boolean;

  /**
   * Check if there's a pending batch for a group.
   */
  hasPending: (groupKey: string) => boolean;

  /**
   * Get and clear the pending batch for a group.
   */
  flush: (groupKey: string) => DebounceBatch<T> | null;

  /**
   * Cancel any pending timers for a group.
   */
  cancel: (groupKey: string) => void;

  /**
   * Set the callback to invoke when debounce timer fires.
   */
  onFlush: (callback: (groupKey: string, batch: DebounceBatch<T>) => void) => void;
};

/**
 * Create a debounce manager for engagement mode.
 */
export function createEngagementDebouncer<T>(config: DebounceConfig): DebounceManager<T> {
  const groups = new Map<string, GroupDebounceState<T>>();
  let flushCallback: ((groupKey: string, batch: DebounceBatch<T>) => void) | null = null;

  const getOrCreateState = (groupKey: string): GroupDebounceState<T> => {
    let state = groups.get(groupKey);
    if (!state) {
      state = {
        pending: [],
        timer: null,
        firstMessageAt: 0,
        maxWaitTimer: null,
      };
      groups.set(groupKey, state);
    }
    return state;
  };

  const clearTimers = (state: GroupDebounceState<T>) => {
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    if (state.maxWaitTimer) {
      clearTimeout(state.maxWaitTimer);
      state.maxWaitTimer = null;
    }
  };

  const triggerFlush = (groupKey: string) => {
    const state = groups.get(groupKey);
    if (!state || state.pending.length === 0) return;

    const batch: DebounceBatch<T> = {
      messages: [...state.pending],
      firstMessageAt: state.firstMessageAt,
      lastMessageAt: state.pending[state.pending.length - 1]?.timestamp ?? Date.now(),
    };

    // Clear state
    clearTimers(state);
    state.pending = [];
    state.firstMessageAt = 0;

    // Invoke callback
    if (flushCallback) {
      flushCallback(groupKey, batch);
    }
  };

  return {
    addMessage(groupKey: string, message: PendingMessage<T>): boolean {
      const state = getOrCreateState(groupKey);
      const isFirst = state.pending.length === 0;

      state.pending.push(message);

      if (isFirst) {
        state.firstMessageAt = message.timestamp;

        // Start max wait timer (cap total wait time)
        state.maxWaitTimer = setTimeout(() => {
          triggerFlush(groupKey);
        }, config.maxWaitMs);
      }

      // Reset debounce timer on each message
      if (state.timer) {
        clearTimeout(state.timer);
      }
      state.timer = setTimeout(() => {
        triggerFlush(groupKey);
      }, config.debounceMs);

      return isFirst;
    },

    hasPending(groupKey: string): boolean {
      const state = groups.get(groupKey);
      return Boolean(state && state.pending.length > 0);
    },

    flush(groupKey: string): DebounceBatch<T> | null {
      const state = groups.get(groupKey);
      if (!state || state.pending.length === 0) return null;

      const batch: DebounceBatch<T> = {
        messages: [...state.pending],
        firstMessageAt: state.firstMessageAt,
        lastMessageAt: state.pending[state.pending.length - 1]?.timestamp ?? Date.now(),
      };

      clearTimers(state);
      state.pending = [];
      state.firstMessageAt = 0;

      return batch;
    },

    cancel(groupKey: string): void {
      const state = groups.get(groupKey);
      if (state) {
        clearTimers(state);
        state.pending = [];
        state.firstMessageAt = 0;
      }
    },

    onFlush(callback: (groupKey: string, batch: DebounceBatch<T>) => void): void {
      flushCallback = callback;
    },
  };
}

/** Default debounce config for engagement mode */
export const DEFAULT_ENGAGEMENT_DEBOUNCE: DebounceConfig = {
  debounceMs: 2500, // Wait 2.5 seconds after last message
  maxWaitMs: 10000, // But never wait more than 10 seconds total
};
