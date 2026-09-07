import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { formatConfigPatchPath, isMergePatchObjectKeyAllowed } from "./patch-replace-paths.js";

/** Projects runtime edits onto source values; only missing keys represent deletion. */
export function projectRuntimeChangesOntoSource(
  sourceConfig: unknown,
  runtimeConfig: unknown,
  nextConfig: unknown,
  options: { pruneUnauthoredDeletions?: boolean } = {},
): unknown {
  const absent = Symbol("absent config value");
  const unchanged = Symbol("unchanged config value");
  const project = (
    source: unknown,
    runtime: unknown,
    candidate: unknown,
    path: string,
    prune: boolean,
  ): unknown => {
    if (isDeepStrictEqual(runtime, candidate)) {
      return unchanged;
    }
    if (!isRecord(candidate)) {
      return structuredClone(candidate);
    }
    const sourceRecord = isRecord(source) ? source : {};
    const runtimeRecord = isRecord(runtime) ? runtime : {};
    const projected = structuredClone(sourceRecord);
    // Explicit empty objects and authored scalars own their replacement shape.
    const pruneChildren =
      prune && (source === undefined || isRecord(source)) && Object.keys(candidate).length > 0;
    let changed = !isRecord(runtime);
    for (const key of new Set([...Object.keys(runtimeRecord), ...Object.keys(candidate)])) {
      const sourceValue = Object.hasOwn(sourceRecord, key) ? sourceRecord[key] : undefined;
      const value = Object.hasOwn(candidate, key)
        ? project(
            sourceValue,
            Object.hasOwn(runtimeRecord, key) ? runtimeRecord[key] : absent,
            candidate[key],
            formatConfigPatchPath(path, key),
            pruneChildren,
          )
        : absent;
      if (value === unchanged || (value === absent && pruneChildren && sourceValue === undefined)) {
        continue;
      }
      changed = true;
      if (!isMergePatchObjectKeyAllowed(key, path)) {
        continue;
      }
      if (value === absent) {
        delete projected[key];
      } else {
        projected[key] = value;
      }
    }
    return changed ? projected : unchanged;
  };
  const projected = project(
    sourceConfig,
    runtimeConfig,
    nextConfig,
    "",
    options.pruneUnauthoredDeletions === true,
  );
  return projected === unchanged ? structuredClone(sourceConfig) : projected;
}
