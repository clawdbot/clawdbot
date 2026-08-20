import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyPatch } from "./apply-patch.test-support.js";

async function withTempDir<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-patch-eof-")));
  try {
    return await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

describe("applyPatch end-of-file hunks", () => {
  it("rejects an end-of-file hunk that reclaims lines an earlier hunk consumed", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "source.txt");
      await fs.writeFile(filePath, "a\nb\nc\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: source.txt
@@
-a
-b
+X
@@
-b
-c
+Y
*** End of File
*** End Patch`;

      await expect(applyPatch(patch, { cwd: dir })).rejects.toThrow(
        /Failed to find expected lines/,
      );
      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("a\nb\nc\n");
    });
  });

  it("applies an end-of-file hunk that follows an earlier disjoint hunk", async () => {
    await withTempDir(async (dir) => {
      const filePath = path.join(dir, "source.txt");
      await fs.writeFile(filePath, "a\nb\nc\nd\n", "utf8");
      const patch = `*** Begin Patch
*** Update File: source.txt
@@
-a
+X
@@
-c
-d
+Y
*** End of File
*** End Patch`;

      await applyPatch(patch, { cwd: dir });

      await expect(fs.readFile(filePath, "utf8")).resolves.toBe("X\nb\nY\n");
    });
  });
});
