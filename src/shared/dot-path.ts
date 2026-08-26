/** Joins path segments into their dotted-path representation. */
export function toDotPath(segments: readonly string[]): string {
  return segments.join(".");
}
