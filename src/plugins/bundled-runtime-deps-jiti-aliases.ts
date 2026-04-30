import fs from "node:fs";
import path from "node:path";
import { isPathInside, safeStatSync } from "./path-safety.js";
import { normalizeJitiAliasTargetPath } from "./sdk-alias.js";

type RuntimeDependencyPackageJson = {
  dependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  exports?: unknown;
  module?: string;
  main?: string;
};

const bundledRuntimeDependencyJitiAliases = new Map<string, string>();
const RUNTIME_DEPENDENCY_JITI_CONDITION_PASSES = [
  new Set(["node", "require", "default"]),
  new Set(["node", "import", "default"]),
] as const;

function readRuntimeDependencyPackageJson(
  packageJsonPath: string,
): RuntimeDependencyPackageJson | null {
  try {
    return JSON.parse(fs.readFileSync(packageJsonPath, "utf-8")) as RuntimeDependencyPackageJson;
  } catch {
    return null;
  }
}

function collectRuntimeDependencyNames(pkg: RuntimeDependencyPackageJson): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
  ].toSorted((left, right) => left.localeCompare(right));
}

function resolveRuntimePackageImportTargetForConditions(
  exportsField: unknown,
  activeConditions: ReadonlySet<string>,
): string | null {
  if (typeof exportsField === "string") {
    return exportsField;
  }
  if (Array.isArray(exportsField)) {
    for (const entry of exportsField) {
      const resolved = resolveRuntimePackageImportTargetForConditions(entry, activeConditions);
      if (resolved) {
        return resolved;
      }
    }
    return null;
  }
  if (!exportsField || typeof exportsField !== "object" || Array.isArray(exportsField)) {
    return null;
  }
  const record = exportsField as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, ".")) {
    return resolveRuntimePackageImportTargetForConditions(record["."], activeConditions);
  }
  for (const [condition, target] of Object.entries(record)) {
    if (!activeConditions.has(condition)) {
      continue;
    }
    const resolved = resolveRuntimePackageImportTargetForConditions(target, activeConditions);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function resolveRuntimePackageImportTarget(exportsField: unknown): string | null {
  for (const activeConditions of RUNTIME_DEPENDENCY_JITI_CONDITION_PASSES) {
    const resolved = resolveRuntimePackageImportTargetForConditions(exportsField, activeConditions);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

function collectRuntimePackageWildcardImportTargets(
  dependencyRoot: string,
  exportKey: string,
  targetPattern: string,
): Map<string, string> {
  const targets = new Map<string, string>();
  const wildcardIndex = exportKey.indexOf("*");
  const targetWildcardIndex = targetPattern.indexOf("*");
  if (wildcardIndex === -1 || targetWildcardIndex === -1) {
    return targets;
  }
  const exportPrefix = exportKey.slice(0, wildcardIndex);
  const exportSuffix = exportKey.slice(wildcardIndex + 1);
  const targetPrefix = targetPattern.slice(0, targetWildcardIndex);
  const targetSuffix = targetPattern.slice(targetWildcardIndex + 1);
  const targetBase = path.resolve(dependencyRoot, targetPrefix);
  if (!isPathInside(dependencyRoot, targetBase) || !safeStatSync(targetBase)?.isDirectory()) {
    return targets;
  }
  const stack = [targetBase];
  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name);
      if (!isPathInside(dependencyRoot, entryPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativeTarget = path.relative(targetBase, entryPath).split(path.sep).join("/");
      if (targetSuffix && !relativeTarget.endsWith(targetSuffix)) {
        continue;
      }
      const wildcardValue = targetSuffix
        ? relativeTarget.slice(0, -targetSuffix.length)
        : relativeTarget;
      targets.set(`${exportPrefix}${wildcardValue}${exportSuffix}`, entryPath);
    }
  }
  return targets;
}

function collectRuntimePackageImportTargets(
  dependencyRoot: string,
  pkg: RuntimeDependencyPackageJson,
): Map<string, string> {
  const targets = new Map<string, string>();
  const exportsField = pkg.exports;
  if (
    exportsField &&
    typeof exportsField === "object" &&
    !Array.isArray(exportsField) &&
    Object.keys(exportsField).some((key) => key.startsWith("."))
  ) {
    for (const [exportKey, exportValue] of Object.entries(exportsField)) {
      if (!exportKey.startsWith(".")) {
        continue;
      }
      const resolved = resolveRuntimePackageImportTarget(exportValue);
      if (resolved) {
        if (exportKey.includes("*")) {
          for (const [wildcardExportKey, targetPath] of collectRuntimePackageWildcardImportTargets(
            dependencyRoot,
            exportKey,
            resolved,
          )) {
            targets.set(wildcardExportKey, targetPath);
          }
        } else {
          targets.set(exportKey, resolved);
        }
      }
    }
    return targets;
  }
  const rootEntry = resolveRuntimePackageImportTarget(exportsField) ?? pkg.module ?? pkg.main;
  if (rootEntry) {
    targets.set(".", rootEntry);
  }
  return targets;
}

export function clearBundledRuntimeDependencyJitiAliases(): void {
  bundledRuntimeDependencyJitiAliases.clear();
}

export function registerBundledRuntimeDependencyJitiAliases(rootDir: string): void {
  const rootPackageJson = readRuntimeDependencyPackageJson(path.join(rootDir, "package.json"));
  if (!rootPackageJson) {
    return;
  }
  for (const dependencyName of collectRuntimeDependencyNames(rootPackageJson)) {
    const dependencyPackageJsonPath = path.join(
      rootDir,
      "node_modules",
      ...dependencyName.split("/"),
      "package.json",
    );
    const dependencyPackageJson = readRuntimeDependencyPackageJson(dependencyPackageJsonPath);
    if (!dependencyPackageJson) {
      continue;
    }
    const dependencyRoot = path.dirname(dependencyPackageJsonPath);
    for (const [exportKey, entry] of collectRuntimePackageImportTargets(
      dependencyRoot,
      dependencyPackageJson,
    )) {
      if (!entry || entry.startsWith("#")) {
        continue;
      }
      const targetPath = path.resolve(dependencyRoot, entry);
      if (!isPathInside(dependencyRoot, targetPath) || !fs.existsSync(targetPath)) {
        continue;
      }
      const aliasKey =
        exportKey === "." ? dependencyName : `${dependencyName}${exportKey.slice(1)}`;
      bundledRuntimeDependencyJitiAliases.set(aliasKey, normalizeJitiAliasTargetPath(targetPath));
    }
  }
}

export function resolveBundledRuntimeDependencyJitiAliasMap(): Record<string, string> | undefined {
  if (bundledRuntimeDependencyJitiAliases.size === 0) {
    return undefined;
  }
  return Object.fromEntries(
    [...bundledRuntimeDependencyJitiAliases.entries()].toSorted(
      ([left], [right]) => right.length - left.length || left.localeCompare(right),
    ),
  );
}
