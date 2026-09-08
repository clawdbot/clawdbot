export function sortUniqueExecutionIdentityEntries<T>(
  values: readonly T[],
  key: (value: T) => string,
): T[] {
  // Last-key-wins UTF-16 ordering protects canonical execution-identity bytes.
  return [...new Map(values.map((value) => [key(value), value])).values()].toSorted((a, b) => {
    const left = key(a);
    const right = key(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
}
