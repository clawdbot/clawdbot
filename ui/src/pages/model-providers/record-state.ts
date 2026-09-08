export function updateRecordEntry<T>(
  record: Readonly<Record<string, T>>,
  key: string,
  value: T | null,
): Record<string, T> {
  const next = { ...record };
  if (value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}
