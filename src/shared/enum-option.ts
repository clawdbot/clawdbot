import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { formatHumanList } from "./human-list.js";

export function createEnumOptionParser(ErrorType: new (message: string) => Error = Error) {
  return <T extends string>(raw: unknown, allowed: readonly T[], label: string): T | undefined => {
    const normalized = normalizeOptionalLowercaseString(raw);
    if (!normalized) {
      return undefined;
    }
    const value = allowed.find((entry) => entry.toLowerCase() === normalized);
    if (value === undefined) {
      throw new ErrorType(`${label} must be one of ${formatHumanList(allowed)}`);
    }
    return value;
  };
}
