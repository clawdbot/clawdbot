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

/** Strip machine-local absolute paths from declaration text before hashing baseline output. */
export function normalizePluginSdkApiDeclarationText(repoRoot: string, value: string): string {
  return value.replaceAll(
    /import\("([^"]+)"((?:\s*,[^)]*)?)\)/g,
    (match, specifier: string, suffix: string) => {
      const normalized = normalizeDeclarationImportSpecifier(repoRoot, specifier);
      return normalized === specifier ? match : `import("${normalized}"${suffix})`;
    },
  );
}
