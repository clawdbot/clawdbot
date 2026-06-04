/**
 * Shared string helpers for plugin SDK contract tests.
 */
import { sortUniqueStrings } from "../../../packages/normalization-core/src/string-normalization.js";

/** Sorts and deduplicates string values for stable contract assertions. */
export function uniqueSortedStrings(values: readonly string[]) {
  return sortUniqueStrings(values);
}
