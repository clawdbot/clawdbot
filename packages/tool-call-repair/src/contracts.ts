/** Parser limits and allowlist options for plain-text tool-call repair. */
export type PlainTextToolCallParseOptions = {
  /** Optional allowlist of tool names that may be repaired. */
  allowedToolNames?: Iterable<string>;
  /** Maximum serialized payload size accepted for one repaired call. */
  maxPayloadBytes?: number;
};

export type PlainTextToolCallNameMatcher = {
  hasExactName(name: string): boolean;
  hasNamePrefix(prefix: string): boolean;
};

/** Source range that must remain literal user-visible text. */
export type PlainTextToolCallProtectedRange = { end: number; start: number };

/** Resolves protected ranges against the exact text about to be scanned. */
export type PlainTextToolCallProtectedRangeResolver = (
  text: string,
) => readonly PlainTextToolCallProtectedRange[];

export function isOffsetInProtectedRanges(
  offset: number,
  ranges: readonly PlainTextToolCallProtectedRange[],
): boolean {
  return ranges.some((range) => offset >= range.start && offset < range.end);
}
