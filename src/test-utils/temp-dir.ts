// Creates temporary directories with cleanup hooks for tests.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/** Runs a test body in a temporary directory and removes it afterward. */
export async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
