import {
  resolveIntegerOption as resolveSharedIntegerOption,
  resolveNonNegativeIntegerOption as resolveSharedNonNegativeIntegerOption,
} from "../shared/number-coercion.js";

export function resolveNonNegativeIntegerOption(value: number, fallback: number): number {
  return resolveSharedNonNegativeIntegerOption(value, fallback);
}

export function resolveIntegerOption(
  value: number,
  fallback: number,
  params: { min: number },
): number {
  return resolveSharedIntegerOption(value, fallback, params);
}
