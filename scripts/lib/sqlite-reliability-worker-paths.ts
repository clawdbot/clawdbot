import fs from "node:fs";
import path from "node:path";

export function canonicalPathWithExistingParent(filePath: string): string {
  const resolvedPath = path.resolve(filePath);
  return path.join(fs.realpathSync.native(path.dirname(resolvedPath)), path.basename(resolvedPath));
}

export function isPendingPathInRepository(filePath: unknown, repositoryPath: string): boolean {
  const resolvedPath = path.resolve(String(filePath));
  if (path.basename(resolvedPath) !== ".pending") {
    return false;
  }
  const candidateRepositoryPath = canonicalPathWithExistingParent(
    path.dirname(path.dirname(resolvedPath)),
  );
  return candidateRepositoryPath === repositoryPath;
}
