export function pruneMapToMaxSize<K, V>(map: Map<K, V>, maxSize: number): void {
  if (Number.isNaN(maxSize) || maxSize === Number.POSITIVE_INFINITY) {
    return;
  }
  const limit = Math.max(0, Math.floor(maxSize));
  if (limit <= 0) {
    map.clear();
    return;
  }

  while (map.size > limit) {
    const oldest = map.keys().next();
    if (oldest.done) {
      break;
    }
    map.delete(oldest.value);
  }
}
