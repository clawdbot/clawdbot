import { resolveIncludeWriteBoundary } from "../../../config/include-write-boundary.js";
import { INCLUDE_KEY, isInternalIncludeWriteTarget } from "../../../config/includes.js";
import type { ConfigFileSnapshot } from "../../../config/types.openclaw.js";

export function containsAuthoredInclude(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.some(containsAuthoredInclude);
  }
  const record = value as Record<string, unknown>;
  return Object.hasOwn(record, INCLUDE_KEY) || Object.values(record).some(containsAuthoredInclude);
}

type ConfigPathMigrationOwnership =
  | { kind: "direct" }
  | { kind: "single-include"; targetPath: string }
  | { kind: "manual"; targetPaths: string[] };

/** Classify whether Doctor can safely persist a migration at one resolved config path. */
export function classifyConfigPathMigrationOwnership(params: {
  snapshot: Pick<ConfigFileSnapshot, "path" | "includeProvenance">;
  configPath: readonly string[];
}): ConfigPathMigrationOwnership {
  const owners = (params.snapshot.includeProvenance ?? []).filter(
    (entry) =>
      entry.path.length <= params.configPath.length &&
      entry.path.every((segment, index) => segment === params.configPath[index]),
  );
  if (owners.length === 0) {
    return { kind: "direct" };
  }

  const targetPaths = [
    ...new Set(
      owners.flatMap((owner) => owner.targetPaths ?? (owner.targetPath ? [owner.targetPath] : [])),
    ),
  ].toSorted();
  const boundary = resolveIncludeWriteBoundary({
    provenance: params.snapshot.includeProvenance,
    changed: { paths: [params.configPath], rootChanged: false },
  });
  // Canonical containment, not lexical: a symlink beneath the config directory
  // can target an external file the guarded writer rejects; that is manual.
  if (
    boundary &&
    isInternalIncludeWriteTarget({
      configPath: params.snapshot.path,
      includePath: boundary.includePath,
    })
  ) {
    return { kind: "single-include", targetPath: boundary.includePath };
  }

  return { kind: "manual", targetPaths };
}
