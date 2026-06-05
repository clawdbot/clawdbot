// Vitest config path helpers resolve test config fixture paths.
import path from "node:path";

// Path normalization helpers for Vitest config snapshot assertions.

/** Convert absolute paths to cwd-relative POSIX-style paths. */
export function normalizeConfigPath(value: unknown): unknown {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    return value;
  }
  return path.relative(process.cwd(), value).split(path.sep).join("/");
}

/** Normalize one or many config path values. */
export function normalizeConfigPaths(
  values: readonly unknown[] | string | undefined,
): unknown[] | undefined {
  if (values === undefined) {
    return undefined;
  }
  if (!Array.isArray(values)) {
    return [normalizeConfigPath(values)];
  }
  return values.map((value) => normalizeConfigPath(value));
}
