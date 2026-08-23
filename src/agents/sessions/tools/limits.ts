/**
 * Byte-limit helpers for session tool stderr/stdout tails.
 *
 * Tail storage is byte-bounded but decoded as UTF-8, so truncation avoids
 * splitting multi-byte characters in display output.
 */
import { resolveIntegerOption } from "@openclaw/normalization-core/number-coercion";
import { truncateUtf8Suffix } from "../../../utils/utf8-truncate.js";

/** Normalizes optional positive numeric limits to a finite integer. */
export function normalizePositiveLimit(value: number | undefined, fallback: number): number {
  return resolveIntegerOption(value, fallback, { min: 1 });
}

/** Default stderr tail retained for long-running session tools. */
export const SESSION_TOOL_STDERR_TAIL_BYTES = 64 * 1024;

/** Appends a chunk while retaining only the UTF-8-safe tail within maxBytes. */
export function appendBoundedTextTail(
  current: string,
  chunk: string,
  maxBytes = SESSION_TOOL_STDERR_TAIL_BYTES,
): string {
  const effectiveMaxBytes = normalizePositiveLimit(maxBytes, SESSION_TOOL_STDERR_TAIL_BYTES);
  return truncateUtf8Suffix(`${current}${chunk}`, effectiveMaxBytes);
}
