import path from "node:path";
import { isWindowsDrivePath } from "./archive-path.js";

// Creation and verification must agree on which archive paths can be restored.
function assertPortableRelativePathSyntax(
  value: string,
  label: string,
  reportedValue = value,
): void {
  if (value.startsWith("/") || isWindowsDrivePath(value)) {
    throw new Error(`${label} must be relative: ${reportedValue}`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${reportedValue}`);
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  assertPortableRelativePathSyntax(trimmed, label, entryPath);
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

export function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

export function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

export function assertArchiveSymbolicLinkTarget(params: {
  archiveRoot: string;
  entryPath: string;
  linkpath?: string;
  assetArchivePaths: readonly string[];
}): void {
  if (!params.linkpath) {
    throw new Error(`Archive symbolic link is missing its target: ${params.entryPath}`);
  }
  assertPortableRelativePathSyntax(
    params.linkpath,
    "Archive symbolic link target",
    `${params.entryPath} -> ${params.linkpath}`,
  );
  const entryPath = normalizeArchivePath(params.entryPath, "Archive symbolic link path");
  const targetPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(entryPath), params.linkpath),
  );
  if (!isArchivePathWithin(targetPath, normalizeArchiveRoot(params.archiveRoot))) {
    throw new Error(
      `Archive symbolic link target is outside the declared archive root: ${params.entryPath} -> ${params.linkpath}`,
    );
  }
  const insideDeclaredAsset = (linkPath: string) =>
    params.assetArchivePaths.some((assetPath) =>
      isArchivePathWithin(linkPath, normalizeArchivePath(assetPath, "Backup manifest asset path")),
    );
  if (!insideDeclaredAsset(entryPath) || !insideDeclaredAsset(targetPath)) {
    throw new Error(
      `Archive symbolic link is outside the declared backup assets: ${params.entryPath} -> ${params.linkpath}`,
    );
  }
}
