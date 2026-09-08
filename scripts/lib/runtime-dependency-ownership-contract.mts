import { packageNameFromSpecifier } from "./plugin-package-dependencies.mts";
import { isRecord } from "./record-shared.mjs";

export const RUNTIME_DEPENDENCY_OWNERSHIP_RELATIVE_PATH = "dist/runtime-dependency-ownership.json";
export const RUNTIME_DEPENDENCY_OWNERSHIP_ASSET_NAME = "runtime-dependency-ownership.json";
export const RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION = 1;

type RuntimeDependencyOwners = {
  extensions: string[];
  root: boolean;
};

export type RuntimeDependencyOwnership = {
  dependencies: Record<string, RuntimeDependencyOwners>;
  formatVersion: typeof RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION;
};

function isRuntimeDependencyOwners(value: unknown): value is RuntimeDependencyOwners {
  if (!isRecord(value) || typeof value.root !== "boolean" || !Array.isArray(value.extensions)) {
    return false;
  }
  if (!value.extensions.every((entry) => typeof entry === "string" && entry.length > 0)) {
    return false;
  }
  const extensions = value.extensions as string[];
  return (
    new Set(extensions).size === extensions.length &&
    extensions
      .toSorted((left, right) => left.localeCompare(right))
      .every((entry, index) => entry === extensions[index])
  );
}

export function parseRuntimeDependencyOwnership(value: unknown): RuntimeDependencyOwnership | null {
  if (
    !isRecord(value) ||
    value.formatVersion !== RUNTIME_DEPENDENCY_OWNERSHIP_FORMAT_VERSION ||
    !isRecord(value.dependencies)
  ) {
    return null;
  }
  for (const [dependencyName, owners] of Object.entries(value.dependencies)) {
    if (
      packageNameFromSpecifier(dependencyName) !== dependencyName ||
      !isRuntimeDependencyOwners(owners)
    ) {
      return null;
    }
  }
  return value as RuntimeDependencyOwnership;
}
