import { resolveIntegerOption as resolveSharedIntegerOption } from "@openclaw/normalization-core/number-coercion";

export function resolveIntegerOption(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  return resolveSharedIntegerOption(value, fallback, params);
}
