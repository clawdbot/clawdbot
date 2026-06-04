/** Returns unique normalized string values while preserving first-seen order. */
export function uniqueStrings(
  values: readonly string[] | undefined,
  normalize: (value: string) => string = (value) => value,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const normalized = normalize(value);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
