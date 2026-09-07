// Guards the fs-safe 0.5.2 adoption: patch mutations must keep working through
// contained directory aliases, mirroring the canonicalized read path.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch.test-support.js";

async function withTempDir<T>(fn: (dir: string) => Promise<T>) {
  // realpath: production sandbox checks compare against canonical paths; on macOS
  // os.tmpdir() is a /var -> /private/var symlink, which otherwise trips the guard.
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-alias-")));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatch through directory aliases", () => {
  it.runIf(process.platform !== "win32")(
    "updates files through contained directory aliases",
    async () => {
      await withTempDir(async (dir) => {
        const realDir = path.join(dir, "real");
        await fs.mkdir(realDir, { recursive: true });
        await fs.writeFile(path.join(realDir, "note.txt"), "initial\n", "utf8");
        await fs.symlink(realDir, path.join(dir, "alias"), "dir");

        const patch = `*** Begin Patch
*** Update File: alias/note.txt
@@
-initial
+updated
*** End Patch`;

        await applyPatch(patch, { cwd: dir });
        await expect(fs.readFile(path.join(realDir, "note.txt"), "utf8")).resolves.toBe(
          "updated\n",
        );
      });
    },
  );
});
