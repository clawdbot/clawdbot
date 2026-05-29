import { resolveIntegerOption as resolveSharedIntegerOption } from "../shared/number-coercion.js";

export function resolveIntegerOption(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  return resolveSharedIntegerOption(value, fallback, params);
}
