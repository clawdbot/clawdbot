/**
 * Tracks pending tool-call ids while repairing sanitized transcript messages.
 * The state object decides when dropped or reordered messages need synthetic
 * tool results flushed.
 *
 * Each pending id carries a deferred settlement promise so the flush boundary
 * can await the runner-owned tool-result write (the `delete(id)` call) instead
 * of guessing an event-loop tick count. A real in-flight HTTP result that
 * settles after the agent reports idle resolves its deferred before the guard
 * synthesizes a missing result; a result that never settles is still flushed
 * synthetically once the settlement timeout elapses.
 */
type PendingToolCall = { id: string; name?: string };

type PendingEntry = {
  name: string | undefined;
  settled: Promise<void>;
  resolve: () => void;
};

type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, string | undefined]>;
  getToolName: (id: string) => string | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  /**
   * Await the runner-owned completion of every still-pending tool-result write
   * (i.e. each tracked id being `delete`d), or return after `timeoutMs` so the
   * caller can flush the remainder as synthetic results. Never rejects: a
   * missing result is a flush decision, not an error.
   */
  waitForSettlement: (timeoutMs: number) => Promise<void>;
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

/** Tracks pending tool calls so sanitized transcript repair can flush in order. */
export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, PendingEntry>();

  return {
    size: () => pending.size,
    *entries(): IterableIterator<[string, string | undefined]> {
      for (const [id, entry] of pending) {
        yield [id, entry.name];
      }
    },
    getToolName: (id: string) => pending.get(id)?.name,
    delete: (id: string) => {
      const entry = pending.get(id);
      if (entry) {
        // Resolve first so a concurrent waitForSettlement sees the completion
        // before the entry disappears.
        entry.resolve();
        pending.delete(id);
      }
    },
    clear: () => {
      // Resolve every deferred so awaiting settlers are not left dangling when
      // the pending map is discarded (e.g. after a synthetic flush).
      for (const entry of pending.values()) {
        entry.resolve();
      }
      pending.clear();
    },
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        let resolve: () => void;
        const settled = new Promise<void>((r) => {
          resolve = r;
        });
        pending.set(call.id, { name: call.name, settled, resolve: resolve! });
      }
    },
    getPendingIds: () => Array.from(pending.keys()),
    waitForSettlement: async (timeoutMs: number): Promise<void> => {
      if (pending.size === 0) {
        return;
      }
      // Snapshot the deferreds so late trackToolCalls do not change what we
      // await this round; later writes settle on the next call.
      const settleAll = Promise.all(Array.from(pending.values(), (entry) => entry.settled));
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          settleAll,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
            timer.unref?.();
          }),
        ]);
      } finally {
        if (timer) {
          clearTimeout(timer);
        }
      }
    },
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
