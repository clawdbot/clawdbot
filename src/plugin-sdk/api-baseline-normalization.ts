// API baseline normalization removes machine-local path differences from compiler output.
import path from "node:path";

/** Normalize compiler source paths into stable repo-relative or node_modules-relative paths. */
export function normalizePluginSdkApiSourcePath(repoRoot: string, filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  const relative = path.relative(repoRoot, resolvedPath);
  const relativePosix = relative.split(path.sep).join(path.posix.sep);
  if (
    !relative.startsWith("..") &&
    !path.isAbsolute(relative) &&
    !relativePosix.startsWith("node_modules/")
  ) {
    return relativePosix;
  }

  const pathParts = resolvedPath.split(/[\\/]+/);
  const nodeModulesIndex = pathParts.lastIndexOf("node_modules");
  if (nodeModulesIndex >= 0 && nodeModulesIndex < pathParts.length - 1) {
    return ["node_modules", ...pathParts.slice(nodeModulesIndex + 1)].join(path.posix.sep);
  }

  return relativePosix;
}

function normalizeDeclarationImportSpecifier(repoRoot: string, value: string): string {
  if (!path.isAbsolute(value) && !/^[A-Za-z]:[\\/]/.test(value)) {
    return value;
  }

  const resolvedPath = path.resolve(value);
  const relative = path.relative(repoRoot, resolvedPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return value;
  }
  return relative.split(path.sep).join(path.posix.sep);
}

function isRepoOwnedImportSpecifier(value: string): boolean {
  return (
    value.startsWith("./") ||
    value.startsWith("../") ||
    /^(?:apps|extensions|packages|scripts|src|test|ui)\//u.test(value)
  );
}

/** Strip machine-local absolute paths from declaration text before hashing baseline output. */
export function normalizePluginSdkApiDeclarationText(repoRoot: string, value: string): string {
  const repoOwnedSpecifiers = new Set<string>();
  const normalized = value.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)/g,
    (match, specifier: string, suffix: string) => {
      const normalizedSpecifier = normalizeDeclarationImportSpecifier(repoRoot, specifier);
      if (normalizedSpecifier !== specifier || isRepoOwnedImportSpecifier(normalizedSpecifier)) {
        repoOwnedSpecifiers.add(normalizedSpecifier);
      }
      return normalizedSpecifier === specifier
        ? match
        : `import("${normalizedSpecifier}"${suffix})`;
    },
  );
  const withoutRepoQualifiers = normalized.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)((?:\.[A-Za-z_$][\w$]*)+)/g,
    (match, specifier: string, _suffix: string, qualifier: string) =>
      repoOwnedSpecifiers.has(specifier) ? qualifier.slice(1) : match,
  );
  return withoutRepoQualifiers.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)/g,
    (match, specifier: string, suffix: string) =>
      repoOwnedSpecifiers.has(specifier) ? `import("<repo>"${suffix})` : match,
  );
}
