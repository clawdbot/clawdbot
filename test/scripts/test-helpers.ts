// Test script helpers provide shared filesystem and process utilities for script tests.
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

export function createScriptTestHarness() {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  function createTempDir(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  async function createTempDirAsync(prefix: string): Promise<string> {
    const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function trackTempDir(dir: string): string {
    tempDirs.push(dir);
    return dir;
  }

  return {
    createTempDir,
    createTempDirAsync,
    trackTempDir,
  };
}
