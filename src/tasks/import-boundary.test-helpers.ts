import fs from "node:fs/promises";
import path from "node:path";

const TASK_ROOT = path.resolve(import.meta.dirname);

const TASK_BOUNDARY_SRC_ROOT = path.resolve(TASK_ROOT, "..");

export function toTaskBoundaryRelativePath(file: string, root = TASK_BOUNDARY_SRC_ROOT): string {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

export async function listTaskBoundarySourceFiles(
  root = TASK_BOUNDARY_SRC_ROOT,
): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listTaskBoundarySourceFiles(fullPath)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) {
      continue;
    }
    files.push(fullPath);
  }
  return files;
}

export async function readTaskBoundarySource(file: string): Promise<string> {
  return fs.readFile(file, "utf8");
}
