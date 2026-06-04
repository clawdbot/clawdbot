// Parses numeric CLI and config options with shared bounds.
import {
  resolveIntegerOption as resolveSharedIntegerOption,
  resolveNonNegativeIntegerOption as resolveSharedNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";

// Numeric option facades keep legacy infra imports aligned with shared
// normalization-core semantics.
/** Resolve a non-negative integer option or return the fallback. */
export function resolveNonNegativeIntegerOption(value: number, fallback: number): number {
  return resolveSharedNonNegativeIntegerOption(value, fallback);
}

/** Resolve an integer option with a minimum bound or return the fallback. */
export function resolveIntegerOption(
  value: number,
  fallback: number,
  params: { min: number },
): number {
  return resolveSharedIntegerOption(value, fallback, params);
}
