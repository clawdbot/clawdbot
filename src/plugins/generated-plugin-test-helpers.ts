import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export const pluginTestRepoRoot = path.resolve(import.meta.dirname, "../..");

const tempDirs: string[] = [];

export function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function createGeneratedPluginTempRoot(prefix: string): string {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(tempRoot);
  return tempRoot;
}

export function installGeneratedPluginTempRootCleanup() {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
