/** Notifies every registered listener while isolating individual listener failures. */
export function notifyListeners<T>(
  listeners: Iterable<(event: T) => void>,
  event: T,
  onError?: (error: unknown) => void,
): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (error) {
      onError?.(error);
    }
  }
}

/** Registers a listener in a Set and returns an idempotent unsubscribe handle. */
export function registerListener<T>(
  listeners: Set<(event: T) => void>,
  listener: (event: T) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
