import bundledRuntimeSidecarPaths from "../../scripts/lib/bundled-runtime-sidecar-paths.json" with { type: "json" };

export function assertUniqueValues<T extends string>(
  values: readonly T[],
  label: string,
): readonly T[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      duplicates.add(value);
      continue;
    }
    seen.add(value);
  }
  if (duplicates.size > 0) {
    throw new Error(`Duplicate ${label}: ${Array.from(duplicates).join(", ")}`);
  }
  return values;
}

export const BUNDLED_RUNTIME_SIDECAR_PATHS = assertUniqueValues(
  bundledRuntimeSidecarPaths,
  "bundled runtime sidecar path",
);
