/**
 * Strict numeric parsers for browser route input.
 *
 * Converts query/body values into finite integer/timeout numbers while
 * preserving route-specific error messages for JSON responses.
 */
import {
  parseStrictFiniteNumber,
  parseStrictInteger,
  parseStrictNonNegativeInteger,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import { normalizeBrowserTimerDelayMs } from "../timer-delay.js";

function hasRouteInputValue(value: unknown): boolean {
  return value != null;
}

/** Read an optional finite number route field. */
export function readRouteFiniteNumber(value: unknown, fieldName: string): number | undefined {
  const parsed = parseStrictFiniteNumber(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(`${fieldName} must be a finite number.`);
  }
  return parsed;
}

/** Read an optional finite number, treating blank strings as absent. */
export function readOptionalRouteFiniteNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (typeof value === "string" && value.trim() === "") {
    return undefined;
  }
  return readRouteFiniteNumber(value, fieldName);
}

/** Read an optional integer route field. */
export function readRouteInteger(
  value: unknown,
  fieldName: string,
  options?: { invalidMessage?: string },
): number | undefined {
  const parsed = parseStrictInteger(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(options?.invalidMessage ?? `${fieldName} must be an integer.`);
  }
  return parsed;
}

/** Read an optional positive integer route field. */
export function readRoutePositiveInteger(
  value: unknown,
  fieldName: string,
  options?: { invalidMessage?: string },
): number | undefined {
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(options?.invalidMessage ?? `${fieldName} must be a positive integer.`);
  }
  return parsed;
}

/** Read and normalize an optional positive timeout value. */
export function readRouteTimerTimeoutMs(
  value: unknown,
  fieldName = "timeoutMs",
  opts?: { minMs?: number; invalidMessage?: string },
): number | undefined {
  const parsed = readRoutePositiveInteger(value, fieldName, opts);
  return parsed === undefined ? undefined : normalizeBrowserTimerDelayMs(parsed, opts);
}

/** Read an optional non-negative integer route field. */
export function readRouteNonNegativeInteger(
  value: unknown,
  fieldName: string,
  options?: { invalidMessage?: string },
): number | undefined {
  const parsed = parseStrictNonNegativeInteger(value);
  if (parsed === undefined && hasRouteInputValue(value)) {
    throw new Error(options?.invalidMessage ?? `${fieldName} must be a non-negative integer.`);
  }
  return parsed;
}
