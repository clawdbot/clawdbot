import fs from "node:fs";
import path from "node:path";

export type QaRepoPathKind = "file" | "directory";

function walkUpDirectories(start: string): string[] {
  const roots: string[] = [];
  let current = path.resolve(start);
  while (true) {
    roots.push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      return roots;
    }
    current = parent;
  }
}

export function resolveQaRepoPath(
  startDir: string,
  relativePath: string,
  kind: QaRepoPathKind = "file",
): string | null {
  for (const dir of walkUpDirectories(startDir)) {
    const candidate = path.join(dir, relativePath);
    if (!fs.existsSync(candidate)) {
      continue;
    }
    const stat = fs.statSync(candidate);
    if ((kind === "file" && stat.isFile()) || (kind === "directory" && stat.isDirectory())) {
      return candidate;
    }
  }
  return null;
}
