/** Prunes a Map in insertion order until it fits the requested maximum size. */
export function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  if (Number.isNaN(maxSize) || maxSize === Number.POSITIVE_INFINITY) {
    // Treat "unknown" or unlimited sizes as no-op so callers can wire optional caps directly.
    return;
  }
  const limit = Math.max(0, Math.floor(maxSize));
  if (limit <= 0) {
    map.clear();
    return;
  }

  if (map.size <= limit) {
    return;
  }
  // Reuse the insertion-order cursor so bulk pruning does not restart at deleted entries.
  const keys = map.keys();
  while (map.size > limit) {
    const oldest = keys.next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
}
