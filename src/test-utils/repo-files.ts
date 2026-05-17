import { spawnSync } from "node:child_process";
import path from "node:path";

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
  const result = spawnSync("git", ["ls-files", "--", ...pathspecs], {
    cwd: params.repoRoot ?? process.cwd(),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  return sortRepoPaths(
    result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  );
}
