export function createAgentTerminalBoundary(
  markTerminal?: () => void,
  onObserverError?: (error: unknown) => void,
): {
  mark: () => void;
  settle: <T>(pending: Promise<T>) => Promise<T>;
} {
  let marked = false;
  const mark = () => {
    if (marked) {
      return;
    }
    marked = true;
    try {
      markTerminal?.();
    } catch (error) {
      try {
        onObserverError?.(error);
      } catch {
        // Terminal accounting is observational and cannot replace task outcome.
      }
    }
  };
  return {
    mark,
    async settle<T>(pending: Promise<T>): Promise<T> {
      try {
        const result = await pending;
        mark();
        return result;
      } catch (error) {
        mark();
        throw error;
      }
    },
  };
}
