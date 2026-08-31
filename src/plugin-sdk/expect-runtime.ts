// Keep the public declaration local so sibling normalization helpers stay private.
export function expectDefined<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) {
    throw new Error("expected " + context + " to be defined");
  }
  return value;
}
