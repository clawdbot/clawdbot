import { resolveIncludeWriteBoundary } from "../../../config/include-write-boundary.js";
import { INCLUDE_KEY, isInternalIncludeWriteTarget } from "../../../config/includes.js";
import type { ConfigFileSnapshot } from "../../../config/types.openclaw.js";
import { isRecord } from "../../../utils.js";

export function containsAuthoredInclude(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsAuthoredInclude);
  }
  if (!isRecord(value)) {
    return false;
  }
  return Object.hasOwn(value, INCLUDE_KEY) || Object.values(value).some(containsAuthoredInclude);
}

type ConfigPathMigrationOwnership =
  | { kind: "direct" }
  | { kind: "single-include"; targetPath: string }
  | { kind: "manual"; targetPaths: string[] };

type OtelGrpcMigrationOwnership = ConfigPathMigrationOwnership | { kind: "resolved-only" };

/** Classify whether Doctor can safely persist a migration at one resolved config path. */
function classifyConfigPathMigrationOwnership(params: {
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

function readOtelProtocol(config: unknown): unknown {
  const root = isRecord(config) ? config : null;
  const diagnostics = isRecord(root?.diagnostics) ? root.diagnostics : null;
  const otel = isRecord(diagnostics?.otel) ? diagnostics.otel : null;
  return otel?.protocol;
}

/** Classify ownership for the sole legacy migration that consults resolved config values. */
export function classifyOtelGrpcMigrationOwnership(params: {
  snapshot: Pick<ConfigFileSnapshot, "path" | "includeProvenance">;
  authoredConfig: unknown;
  resolvedConfig: unknown;
}): OtelGrpcMigrationOwnership | null {
  if (readOtelProtocol(params.resolvedConfig) !== "grpc") {
    return null;
  }
  const ownership = classifyConfigPathMigrationOwnership({
    snapshot: params.snapshot,
    configPath: ["diagnostics", "otel", "protocol"],
  });
  if (ownership.kind !== "direct") {
    return ownership;
  }
  return readOtelProtocol(params.authoredConfig) === "grpc" ? ownership : { kind: "resolved-only" };
}
