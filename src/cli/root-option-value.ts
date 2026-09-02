// Shared parser for root options that may be passed as `--flag=value` or `--flag value`.
import { isValueToken } from "../infra/cli-root-options.js";
import { parseInlineOptionToken } from "../infra/inline-option-token.js";

/** Return the normalized option value and whether the next argv token was consumed. */
export function takeCliRootOptionValue(
  raw: string,
  next: string | undefined,
): {
  value: string | null;
  consumedNext: boolean;
} {
  const parsed = parseInlineOptionToken(raw);
  if (parsed.hasInlineValue) {
    const trimmed = (parsed.inlineValue ?? "").trim();
    return { value: trimmed || null, consumedNext: false };
  }
  const consumedNext = isValueToken(next);
  const trimmed = consumedNext ? next!.trim() : "";
  return { value: trimmed || null, consumedNext };
}
