import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

export async function listMatchingDirs(root: string, prefix: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(prefix)) {
      names.push(entry.name);
    }
  }
  return names;
}

function normalizeDarwinTmpPath(filePath: string): string {
  return process.platform === "darwin" && filePath.startsWith("/private/var/")
    ? filePath.slice("/private".length)
    : filePath;
}

export function normalizeComparablePath(filePath: string): string {
  const resolved = normalizeDarwinTmpPath(path.resolve(filePath));
  const parent = normalizeDarwinTmpPath(path.dirname(resolved));
  let comparableParent;
  try {
    comparableParent = normalizeDarwinTmpPath(fsSync.realpathSync.native(parent));
  } catch {
    comparableParent = parent;
  }
  const basename =
    process.platform === "win32" ? path.basename(resolved).toLowerCase() : path.basename(resolved);
  return path.join(comparableParent, basename);
}

export async function createExistingInstallFixture(fixtureRoot: string) {
  const installBaseDir = path.join(fixtureRoot, "plugins");
  const sourceDir = path.join(fixtureRoot, "source");
  const targetDir = path.join(installBaseDir, "demo");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(targetDir, { recursive: true });
  await fs.writeFile(path.join(sourceDir, "marker.txt"), "new");
  await fs.writeFile(path.join(targetDir, "marker.txt"), "old");
  return { installBaseDir, sourceDir, targetDir };
}
