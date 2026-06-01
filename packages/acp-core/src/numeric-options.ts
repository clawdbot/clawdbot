import { resolveIntegerOption as resolveSharedIntegerOption } from "@openclaw/normalization-core/number-coercion";

/** Resolves ACP integer options through the shared normalization contract. */
export function resolveIntegerOption(
  value: number | undefined,
  fallback: number,
  params: { min: number },
): number {
  return resolveSharedIntegerOption(value, fallback, params);
}
