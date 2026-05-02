type PendingToolCall = { id: string; name?: string };

type PendingToolCallState = {
  size: () => number;
  entries: () => IterableIterator<[string, string | undefined]>;
  getToolName: (id: string) => string | undefined;
  delete: (id: string) => void;
  clear: () => void;
  trackToolCalls: (calls: PendingToolCall[]) => void;
  getPendingIds: () => string[];
  shouldFlushForSanitizedDrop: () => boolean;
  shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) => boolean;
  shouldFlushBeforeNewToolCalls: (toolCallCount: number) => boolean;
};

export function createPendingToolCallState(): PendingToolCallState {
  const pending = new Map<string, string | undefined>();

  return {
    size: () => pending.size,
    entries: () => pending.entries(),
    getToolName: (id: string) => pending.get(id),
    delete: (id: string) => {
      pending.delete(id);
    },
    clear: () => {
      pending.clear();
    },
    trackToolCalls: (calls: PendingToolCall[]) => {
      for (const call of calls) {
        pending.set(call.id, call.name);
      }
    },
    getPendingIds: () => Array.from(pending.keys()),
    shouldFlushForSanitizedDrop: () => pending.size > 0,
    shouldFlushBeforeNonToolResult: (nextRole: unknown, toolCallCount: number) =>
      pending.size > 0 && (toolCallCount === 0 || nextRole !== "assistant"),
    shouldFlushBeforeNewToolCalls: (toolCallCount: number) => pending.size > 0 && toolCallCount > 0,
  };
}
