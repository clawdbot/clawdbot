/** Replace or remove one keyed Lit state value without mutating the published record. */
export function updateModelProviderKeyedState<T>(
  state: Readonly<Record<string, T>>,
  key: string,
  value: T | undefined,
): Record<string, T> {
  const next = { ...state };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}
