/** Parses JSON without throwing, returning undefined for invalid input. */
export function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}
