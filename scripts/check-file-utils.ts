// Check File Utils helper supports OpenClaw script workflows.
import fs from "node:fs";
import path from "node:path";

const DEFAULT_SKIPPED_DIR_NAMES = new Set(["node_modules", "dist", "coverage", ".generated"]);

export function isCodeFile(filePath: string): boolean {
  if (filePath.endsWith(".d.ts")) {
    return false;
  }
  return /\.(?:[cm]?ts|[cm]?js|tsx|jsx)$/u.test(filePath);
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
