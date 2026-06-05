// Diffs helper module supports test helpers behavior.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolvePreferredOpenClawTmpDir } from "../api.js";
import { DiffArtifactStore } from "./store.js";

const execFileAsync = promisify(execFile);

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export async function ensureCuratedViewerRuntimeForTests(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimePath = path.join(repoRoot, "extensions", "diffs", "assets", "viewer-runtime.js");
  if (await pathExists(runtimePath)) {
    return;
  }

  // The curated runtime is generated output. Source tests that serve viewer
  // assets need a clean-checkout fixture before the normal build hook runs.
  await execFileAsync(process.execPath, ["scripts/build-diffs-viewer-runtime.mjs", "curated"], {
    cwd: repoRoot,
  });
}

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
