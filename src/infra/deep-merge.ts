import { isPlainObject } from "./plain-object.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type DeepMergeOptions = {
  arrays?: "replace" | "concat";
  undefinedValues?: "skip" | "replace";
};

function sanitizePlainObject(value: Record<string, unknown>): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    sanitized[key] = isPlainObject(entry) ? sanitizePlainObject(entry) : entry;
  }
  return sanitized;
}

/** Merge plain objects while preserving OpenClaw's null, undefined, and array policies. */
export function mergeDeep(
  base: unknown,
  override: unknown,
  options: DeepMergeOptions = {},
): unknown {
  const arrays = options.arrays ?? "replace";
  const undefinedValues = options.undefinedValues ?? "skip";

  if (Array.isArray(base) && Array.isArray(override)) {
    return arrays === "concat" ? [...base, ...override] : override;
  }
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return override === undefined && undefinedValues === "skip" ? base : override;
  }

  // Clone nested records before merging so base-only and override-only branches
  // enforce the same blocked-key boundary.
  const merged = sanitizePlainObject(base);
  for (const [key, value] of Object.entries(override)) {
    if (isBlockedObjectKey(key) || (value === undefined && undefinedValues === "skip")) {
      continue;
    }
    const current = merged[key];
    if (isPlainObject(value)) {
      merged[key] = isPlainObject(current)
        ? mergeDeep(current, value, options)
        : sanitizePlainObject(value);
    } else if (arrays === "concat" && Array.isArray(current) && Array.isArray(value)) {
      merged[key] = [...current, ...value];
    } else {
      merged[key] = value;
    }
  }
  return merged;
}
