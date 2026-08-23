/** Returns the value or throws with the named context; use for genuine invariants only. */
export function expectDefined<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) {
    throw new Error("expected " + context + " to be defined");
  }
  return value;
}

/** First element with honest optionality; callers own the absent case. */
export function first<T>(values: readonly T[]): T | undefined {
  return values.at(0);
}

/** Last element with honest optionality; callers own the absent case. */
export function last<T>(values: readonly T[]): T | undefined {
  return values.at(-1);
}
