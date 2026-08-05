import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { INCLUDE_KEY } from "../../../config/includes.js";
import type { ConfigFileSnapshot, OpenClawConfig } from "../../../config/types.openclaw.js";
import { isPathInside } from "../../../infra/path-safety.js";
import { isRecord } from "../../../utils.js";

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
  | { kind: "single-top-level-include"; targetPath: string }
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
  const owner = owners[0];
  const configDir = path.dirname(path.resolve(params.snapshot.path));
  if (
    owners.length === 1 &&
    owner?.path.length === 1 &&
    owner.path[0] === params.configPath[0] &&
    owner.kind === "single" &&
    !owner.hasSiblingOverrides &&
    owner.targetPath &&
    isPathInside(configDir, path.resolve(owner.targetPath))
  ) {
    return { kind: "single-top-level-include", targetPath: owner.targetPath };
  }

  return { kind: "manual", targetPaths };
}

export function isSingleTopLevelIncludeMigration(params: {
  parsed: unknown;
  sourceConfig: OpenClawConfig;
  candidate: OpenClawConfig;
}): boolean {
  if (!isRecord(params.parsed)) {
    return false;
  }
  const keys = new Set([...Object.keys(params.sourceConfig), ...Object.keys(params.candidate)]);
  const sourceConfig = params.sourceConfig as Record<string, unknown>;
  const candidate = params.candidate as Record<string, unknown>;
  const changed = [...keys].filter((key) => !isDeepStrictEqual(sourceConfig[key], candidate[key]));
  const changedKey = changed.length === 1 ? changed[0] : undefined;
  if (changedKey === undefined) {
    return false;
  }
  const authoredSection = params.parsed[changedKey];
  return (
    isRecord(authoredSection) &&
    Object.keys(authoredSection).length === 1 &&
    typeof authoredSection[INCLUDE_KEY] === "string"
  );
}
