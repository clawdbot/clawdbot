// Loads fixture suites from disk for parametrized tests.
import fs from "node:fs/promises";
import path from "node:path";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";

/** Creates a temp fixture root with deterministic per-case subdirectories. */
export function createFixtureSuite(rootPrefix: string) {
  let fixtureRoot = "";
  let fixtureCount = 0;
  const fixtureRoots = new Set<string>();

  return {
    async setup(): Promise<void> {
      fixtureRoot = makeTempDir(fixtureRoots, rootPrefix);
    },
    async cleanup(): Promise<void> {
      if (!fixtureRoot) {
        return;
      }
      cleanupTempDirs(fixtureRoots);
      fixtureRoot = "";
    },
    async createCaseDir(prefix: string): Promise<string> {
      if (!fixtureRoot) {
        throw new Error("Fixture suite not initialized");
      }
      const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
  };
}
