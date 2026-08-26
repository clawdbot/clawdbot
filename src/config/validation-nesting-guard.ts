/**
 * Depth guard for config schema validation.
 *
 * `OpenClawSchema` is a Zod `strictObject`, so every unrecognized key at every
 * nesting level produces a validation issue whose path spans from the root to
 * that key. A pathologically deep object (e.g. 20 000 levels of `{"a":{…}}`)
 * makes Zod allocate O(n²) path elements inside `safeParse`, exhausting the V8
 * heap before the error wrapper can run.
 *
 * This guard measures structural depth iteratively (explicit stack, no
 * recursion) and rejects inputs above `MAX_VALIDATION_NESTING_DEPTH` before
 * `safeParse` runs. It protects every caller of `validateConfigObjectRaw`,
 * including paths that receive an already-parsed object and never cross a
 * raw-text parsing boundary.
 */
import { isRecord } from "../utils.js";

/**
 * Maximum structural nesting depth a config value may have when reaching schema
 * validation. Real configs rarely exceed 5–6 levels; 64 leaves ample headroom
 * while keeping Zod issue paths bounded.
 */
export const MAX_VALIDATION_NESTING_DEPTH = 64;

/** Error thrown when a config value exceeds the supported nesting depth. */
export class ConfigValidationNestingError extends Error {
  constructor(
    readonly measuredDepth: number,
    message: string,
  ) {
    super(message);
    this.name = "ConfigValidationNestingError";
  }
}

/**
 * Measures the maximum structural nesting depth of a parsed value.
 *
 * Iterative (explicit stack) so the measurement itself can never recurse or
 * overflow the stack on pathological input. Primitives have depth 0; a shallow
 * object or array has depth 1.
 */
export function measureConfigNestingDepth(value: unknown): number {
  let maxDepth = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 1 }];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) {
      continue;
    }
    const current = entry.value;
    if (Array.isArray(current)) {
      if (entry.depth > maxDepth) {
        maxDepth = entry.depth;
      }
      for (const item of current) {
        stack.push({ value: item, depth: entry.depth + 1 });
      }
    } else if (isRecord(current)) {
      if (entry.depth > maxDepth) {
        maxDepth = entry.depth;
      }
      for (const child of Object.values(current)) {
        stack.push({ value: child, depth: entry.depth + 1 });
      }
    }
  }
  return maxDepth;
}

/**
 * Asserts a parsed config value stays within the supported nesting depth.
 * Returns a typed issue array on violation so callers can fold it into their
 * existing validation-issue reporting instead of catching an exception.
 */
export function checkConfigNestingDepth(
  value: unknown,
  label: string,
): { ok: true } | { ok: false; issues: { path: string; message: string }[] } {
  const depth = measureConfigNestingDepth(value);
  if (depth <= MAX_VALIDATION_NESTING_DEPTH) {
    return { ok: true };
  }
  const message = `${label} exceeds the maximum supported nesting depth of ${MAX_VALIDATION_NESTING_DEPTH} (measured ${depth} levels)`;
  return {
    ok: false,
    issues: [{ path: "", message }],
  };
}
