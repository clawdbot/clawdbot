import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function makeTempDir(tempDirs: string[] | Set<string>, prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  if (Array.isArray(tempDirs)) {
    tempDirs.push(dir);
  } else {
    tempDirs.add(dir);
  }
  return dir;
}

export function cleanupTempDirs(tempDirs: string[] | Set<string>): void {
  const dirs = Array.isArray(tempDirs) ? tempDirs.splice(0) : [...tempDirs];
  for (const dir of dirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  if (!Array.isArray(tempDirs)) {
    tempDirs.clear();
  }
}
