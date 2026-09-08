import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isBlockedObjectKey } from "../infra/prototype-keys.js";

/** Fill undefined fields in place; newly assigned values retain their source references. */
export function mergeMissing(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || isBlockedObjectKey(key)) {
      continue;
    }
    const existing = target[key];
    if (existing === undefined) {
      target[key] = value;
      continue;
    }
    if (isRecord(existing) && isRecord(value)) {
      mergeMissing(existing, value);
    }
  }
}
