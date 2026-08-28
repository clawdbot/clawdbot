// Matrix plugin module implements bounded in-memory cache insertion.
export function setBoundedMap<K, V>(map: Map<K, V>, key: K, value: V, maxEntries: number): void {
  map.set(key, value);
  if (map.size <= maxEntries) {
    return;
  }
  // Map insertion order keeps eviction FIFO without moving refreshed keys.
  const oldest = map.keys().next();
  if (!oldest.done) {
    map.delete(oldest.value);
  }
}
