// Temporary repo helper creates Git repositories for integration tests.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Synchronous temporary repository helpers for tests.

/** Create and track a temporary repo root. */
export function makeTempRepoRoot(tempDirs: string[], prefix: string): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(repoRoot);
  return repoRoot;
}

/** Write formatted JSON to a path, creating parent directories. */
export function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Remove all tracked temporary directories. */
export function cleanupTempDirs(tempDirs: string[]): void {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
