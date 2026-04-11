import path from "node:path";

export function resolveRepoRelativeOutputDir(repoRoot: string, outputDir?: string) {
  if (!outputDir) {
    return undefined;
  }
  if (path.isAbsolute(outputDir)) {
    throw new Error("--output-dir must be a relative path inside the repo root.");
  }
  const resolved = path.resolve(repoRoot, outputDir);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output-dir must stay within the repo root.");
  }
  return resolved;
}
