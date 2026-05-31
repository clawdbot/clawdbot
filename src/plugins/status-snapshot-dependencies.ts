import fs from "node:fs";
import path from "node:path";
import type {
  PluginDependencyEntry,
  PluginDependencySpecMap,
  PluginDependencyStatus,
} from "./status-dependencies.js";

// Keep this helper separate from status-dependencies.ts. That module is also
// imported by plugin discovery, and the CLI startup bundle otherwise pulls the
// full discovery chunk for `plugins list --json`.
function dependencyPathSegments(name: string): string[] | null {
  const segments = name.split("/");
  if (segments.length === 1 && segments[0]) {
    return [segments[0]];
  }
  if (segments.length === 2 && segments[0]?.startsWith("@") && segments[1]) {
    return segments;
  }
  return null;
}

function findDependencyPackageDir(params: { fromDir: string; name: string }): string | undefined {
  const segments = dependencyPathSegments(params.name);
  if (!segments) {
    return undefined;
  }
  let current = path.resolve(params.fromDir);
  while (true) {
    const candidate = path.join(current, "node_modules", ...segments);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

function buildDependencyEntries(params: {
  rootDir: string | undefined;
  dependencies: PluginDependencySpecMap;
  optional: boolean;
}): PluginDependencyEntry[] {
  return Object.entries(params.dependencies)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([name, spec]) => {
      const resolvedPath = params.rootDir
        ? findDependencyPackageDir({ fromDir: params.rootDir, name })
        : undefined;
      const entry: PluginDependencyEntry = {
        name,
        spec,
        installed: resolvedPath !== undefined,
        optional: params.optional,
      };
      if (resolvedPath) {
        entry.resolvedPath = resolvedPath;
      }
      return entry;
    });
}

export function buildSnapshotPluginDependencyStatus(params: {
  rootDir?: string;
  dependencies?: PluginDependencySpecMap;
  optionalDependencies?: PluginDependencySpecMap;
}): PluginDependencyStatus {
  const dependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencies: params.dependencies ?? {},
    optional: false,
  });
  const optionalDependencies = buildDependencyEntries({
    rootDir: params.rootDir,
    dependencies: params.optionalDependencies ?? {},
    optional: true,
  });
  const missing = dependencies.filter((entry) => !entry.installed).map((entry) => entry.name);
  const missingOptional = optionalDependencies
    .filter((entry) => !entry.installed)
    .map((entry) => entry.name);
  const requiredInstalled = missing.length === 0;
  const optionalInstalled = missingOptional.length === 0;
  return {
    hasDependencies: dependencies.length > 0 || optionalDependencies.length > 0,
    installed: requiredInstalled,
    requiredInstalled,
    optionalInstalled,
    missing,
    missingOptional,
    dependencies,
    optionalDependencies,
  };
}
