// Normalizes package tag inputs for install/update flows.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

/** Normalizes a package tag input, stripping known package-name prefixes when present. */
export function normalizePackageTagInput(
  value: string | undefined | null,
  packageNames: readonly string[],
): string | null {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return null;
  }

  for (const packageName of packageNames) {
    if (trimmed === packageName) {
      return null;
    }
    const prefix = `${packageName}@`;
    if (trimmed.startsWith(prefix)) {
      const tag = trimmed.slice(prefix.length).trim();
      return tag ? tag : null;
    }
  }

  return trimmed;
}
