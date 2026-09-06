import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { formatHumanList } from "../shared/human-list.js";

/** Parses an optional exact-match CLI enum before command-owned work begins. */
export function parseCliEnumFilter<T extends string>(
  raw: string | undefined,
  flag: string,
  values: readonly T[],
): T | undefined {
  const normalized = normalizeOptionalString(raw);
  if (normalized === undefined) {
    return undefined;
  }
  const match = values.find((value) => value === normalized);
  if (!match) {
    throw new Error(`${flag} must be ${formatHumanList(values)}.`);
  }
  return match;
}
