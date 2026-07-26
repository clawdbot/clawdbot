// Resolves bundled plugin load-path aliases for package output.
import path from "node:path";

/** Alias class for current packaged paths and legacy bundled extension paths. */
type BundledPluginLoadPathAliasKind = "current" | "legacy";

/** Load path alias used while resolving bundled plugins across package layouts. */
type BundledPluginLoadPathAlias = {
  kind: BundledPluginLoadPathAliasKind;
  path: string;
};

/** Parsed path metadata for a bundled plugin in a packaged dist root. */
type PackagedBundledPluginPath = {
  packageRoot: string;
  bundledRoot: string;
  bundledLeaf: string;
};

/** Parsed path metadata for a bundled plugin in the legacy extensions root. */
type LegacyBundledPluginPath = {
  packageRoot: string;
  legacyRoot: string;
  bundledLeaf: string;
};

const PACKAGED_BUNDLED_ROOTS = [
  path.join("dist", "extensions"),
  path.join("dist-runtime", "extensions"),
] as const;

/** Normalizes bundled lookup paths without preserving trailing separators. */
export function normalizeBundledLookupPath(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  const root = path.parse(normalized).root;
  let trimmed = normalized;
  while (trimmed.length > root.length && (trimmed.endsWith(path.sep) || trimmed.endsWith("/"))) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function findPackagedBundledRoot(localPath: string): {
  packageRoot: string;
  bundledRoot: string;
} | null {
  const normalized = normalizeBundledLookupPath(localPath);
  for (const packagedRoot of PACKAGED_BUNDLED_ROOTS) {
    const marker = `${path.sep}${packagedRoot}`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const markerEnd = markerIndex + marker.length;
    if (normalized.length !== markerEnd && normalized[markerEnd] !== path.sep) {
      continue;
    }
    return {
      packageRoot: normalized.slice(0, markerIndex),
      bundledRoot: normalized.slice(0, markerEnd),
    };
  }
  return null;
}

/** Parses a path under a packaged bundled plugin root. */
export function parsePackagedBundledPluginPath(
  localPath: string,
): PackagedBundledPluginPath | null {
  const packaged = findPackagedBundledRoot(localPath);
  if (!packaged) {
    return null;
  }
  const normalized = normalizeBundledLookupPath(localPath);
  if (normalized === packaged.bundledRoot) {
    return null;
  }
  return {
    ...packaged,
    bundledLeaf: normalized.slice(packaged.bundledRoot.length + path.sep.length),
  };
}

/** Builds the legacy extensions-root alias for a packaged bundled plugin path. */
function buildLegacyBundledPath(localPath: string): string | null {
  const packaged = parsePackagedBundledPluginPath(localPath);
  if (!packaged) {
    return null;
  }
  return path.join(packaged.packageRoot, "extensions", packaged.bundledLeaf);
}

/** Builds the legacy extensions root for a packaged bundled plugin root. */
export function buildLegacyBundledRootPath(localPath: string): string | null {
  const packaged = findPackagedBundledRoot(localPath);
  return packaged ? path.join(packaged.packageRoot, "extensions") : null;
}

/** Parses a path under the legacy bundled extensions root. */
export function parseLegacyBundledPluginPath(localPath: string): LegacyBundledPluginPath | null {
  const normalized = normalizeBundledLookupPath(localPath);
  const marker = `${path.sep}extensions`;
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex === -1) {
    return null;
  }
  const markerEnd = markerIndex + marker.length;
  if (normalized.length === markerEnd || normalized[markerEnd] !== path.sep) {
    return null;
  }
  return {
    packageRoot: normalized.slice(0, markerIndex),
    legacyRoot: normalized.slice(0, markerEnd),
    bundledLeaf: normalized.slice(markerEnd + path.sep.length),
  };
}

/** Builds current and legacy aliases for a packaged bundled plugin path. */
export function buildBundledPluginLoadPathAliases(localPath: string): BundledPluginLoadPathAlias[] {
  const legacyPath = buildLegacyBundledPath(localPath);
  if (!legacyPath) {
    return [];
  }
  return [
    { kind: "current", path: localPath },
    { kind: "legacy", path: legacyPath },
  ];
}
