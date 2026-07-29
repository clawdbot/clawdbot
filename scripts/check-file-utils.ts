// Check File Utils helper supports OpenClaw script workflows.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".generated"]);
export const REPO_SCAN_ROOTS = ["src", "test", "extensions", "packages", "ui", "scripts"] as const;
export const REPO_SCAN_SKIPPED_DIR_NAMES: ReadonlySet<string> = new Set([
  ".artifacts",
  ".generated",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "vendor",
]);

export function isCodeFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(filePath);
}

export function isTestRelatedFile(relativePath: string): boolean {
  return (
    /(?:^|[/.])(?:test|spec)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\.(?:e2e|live)\.test\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /\.(?:test-helpers|test-utils|test-harness|test-support)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /-(?:test-helpers|test-utils|test-harness|test-support)\.[cm]?[jt]sx?$/u.test(relativePath) ||
    /(?:^|\/)(?:test|tests|test-helpers|test-utils|test-harness|test-support)\//u.test(
      relativePath,
    ) ||
    relativePath.startsWith("scripts/e2e/") ||
    /^scripts\/.*-(?:client|e2e|harness|probe|smoke)\.[cm]?[jt]s$/u.test(relativePath)
  );
}

export function collectFilesSync(
  rootDir: string,
  options: {
    includeFile: (filePath: string) => boolean;
    skipDirNames?: ReadonlySet<string>;
  },
): string[] {
  const skipDirNames = options.skipDirNames ?? DEFAULT_SKIPPED_DIR_NAMES;
  const files: string[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (skipDirNames.has(entry.name)) {
          continue;
        }
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && options.includeFile(fullPath)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

export function listRepoFilesSync(
  repoRoot: string,
  options: {
    includeFile: (relativePath: string) => boolean;
    roots?: readonly string[];
    skipDirNames?: ReadonlySet<string>;
  },
): string[] {
  const roots = options.roots ?? REPO_SCAN_ROOTS;
  try {
    return execFileSync("git", ["-C", repoRoot, "ls-files", "--", ...roots], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    })
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(toPosixPath)
      .filter(options.includeFile)
      .toSorted((left, right) => left.localeCompare(right));
  } catch {
    return roots
      .flatMap((root) => {
        const absoluteRoot = path.join(repoRoot, root);
        if (!fs.existsSync(absoluteRoot)) {
          return [];
        }
        return collectFilesSync(absoluteRoot, {
          includeFile: (filePath) =>
            options.includeFile(toPosixPath(path.relative(repoRoot, filePath))),
          skipDirNames: options.skipDirNames ?? REPO_SCAN_SKIPPED_DIR_NAMES,
        }).map((filePath) => toPosixPath(path.relative(repoRoot, filePath)));
      })
      .toSorted((left, right) => left.localeCompare(right));
  }
}

export function toPosixPath(filePath: string): string {
  if (path.sep === "/") {
    return filePath;
  }
  return filePath.replaceAll("\\", "/");
}

export function relativeToCwd(filePath: string): string {
  const relativePath = path.relative(process.cwd(), filePath) || filePath;
  return toPosixPath(relativePath);
}
