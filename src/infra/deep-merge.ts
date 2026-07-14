import defu from "defu";
import { isPlainObject } from "./plain-object.js";
import { isBlockedObjectKey } from "./prototype-keys.js";

type DeepMergeOptions = {
  arrays?: "replace" | "concat";
  undefinedValues?: "skip" | "replace";
};

const NULL_OVERRIDE = Symbol("null-override");
const UNDEFINED_OVERRIDE = Symbol("undefined-override");

class ArrayOverride {
  constructor(readonly value: unknown[]) {}
}

function prepareObject(
  value: Record<string, unknown>,
  undefinedValues: "skip" | "replace",
  encodeOverrides: boolean,
  arrays: "replace" | "concat",
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const prepared: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isBlockedObjectKey(key)) {
      continue;
    }
    const baseEntry = base?.[key];
    if (encodeOverrides && entry === null) {
      prepared[key] = NULL_OVERRIDE;
    } else if (encodeOverrides && entry === undefined && undefinedValues === "replace") {
      prepared[key] = UNDEFINED_OVERRIDE;
    } else if (encodeOverrides && Array.isArray(entry)) {
      // Defu concatenates arrays source-first. A non-plain wrapper carries the
      // caller's replacement or base-first concatenation policy through recursion.
      prepared[key] = new ArrayOverride(
        arrays === "concat" && Array.isArray(baseEntry) ? [...baseEntry, ...entry] : entry,
      );
    } else if (isPlainObject(entry)) {
      prepared[key] = prepareObject(
        entry,
        undefinedValues,
        encodeOverrides,
        arrays,
        isPlainObject(baseEntry) ? baseEntry : undefined,
      );
    } else {
      prepared[key] = entry;
    }
  }
  return prepared;
}

function decodeOverrides(value: unknown): unknown {
  if (value instanceof ArrayOverride) {
    return value.value;
  }
  if (value === NULL_OVERRIDE) {
    return null;
  }
  if (value === UNDEFINED_OVERRIDE) {
    return undefined;
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decodeOverrides(entry)]),
  );
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

  // defu intentionally treats null/undefined as absent. Sentinels retain explicit
  // overrides while its recursive merge remains the single merge implementation.
  const preparedBase = prepareObject(base, undefinedValues, false, arrays);
  const preparedOverride = prepareObject(override, undefinedValues, true, arrays, base);
  return decodeOverrides(defu(preparedOverride, preparedBase));
}
