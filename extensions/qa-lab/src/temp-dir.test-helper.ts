import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

export function createTempDirHarness() {
  const tempDirs: string[] = [];

  return {
    async cleanup() {
      await Promise.all(
        tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
      );
    },
    async makeTempDir(prefix: string) {
      const dir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
      tempDirs.push(dir);
      return dir;
    },
  };
}
