import { spawnSync } from "node:child_process";
import path from "node:path";

const gitTrackedFilesCache = new Map<string, string[] | null>();

export function toRepoPath(filePath: string): string {
  return filePath.replaceAll("\\", "/");
}

export function toRepoRelativePath(repoRoot: string, filePath: string): string {
  return toRepoPath(path.relative(repoRoot, filePath));
}

export function sortRepoPaths(paths: Iterable<string>): string[] {
  return [...paths].map(toRepoPath).toSorted();
}

export function listGitTrackedFiles(params: {
  pathspecs: string | readonly string[];
  repoRoot?: string;
}): string[] | null {
  const pathspecs = Array.isArray(params.pathspecs) ? [...params.pathspecs] : [params.pathspecs];
  const repoRoot = params.repoRoot ?? process.cwd();
  const cacheKey = JSON.stringify({ repoRoot, pathspecs });
  const cached = gitTrackedFilesCache.get(cacheKey);
  if (cached !== undefined) {
    return cached ? [...cached] : null;
  }
  const result = spawnSync("git", ["ls-files", "--", ...pathspecs], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    gitTrackedFilesCache.set(cacheKey, null);
    return null;
  }
  const files = sortRepoPaths(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
  gitTrackedFilesCache.set(cacheKey, files);
  return [...files];
}
