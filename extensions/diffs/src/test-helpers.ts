import fs from "node:fs/promises";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "../api.js";
import { DiffArtifactStore } from "./store.js";

export async function createTempDiffRoot(prefix: string): Promise<{
  rootDir: string;
  cleanup: () => Promise<void>;
}> {
  const rootDir = await fs.mkdtemp(path.join(resolvePreferredOpenClawTmpDir(), prefix));
  return {
    rootDir,
    cleanup: async () => {
      await fs.rm(rootDir, { recursive: true, force: true });
    },
  };
}

export async function createDiffStoreHarness(prefix: string): Promise<{
  rootDir: string;
  store: DiffArtifactStore;
  cleanup: () => Promise<void>;
}> {
  const { rootDir, cleanup } = await createTempDiffRoot(prefix);
  return {
    rootDir,
    store: new DiffArtifactStore({ rootDir }),
    cleanup,
  };
}
