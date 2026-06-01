import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSourceFileContents } from "../../scripts/lib/source-file-scan-cache.mjs";

const tempDirs: string[] = [];

async function makeTempRepo() {
  const repoRoot = await mkdtemp(path.join(os.tmpdir(), "openclaw-source-scan-"));
  tempDirs.push(repoRoot);
  return repoRoot;
}

describe("source file scan cache", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("bounds concurrent source file reads while preserving sorted output", async () => {
    const repoRoot = await makeTempRepo();
    const srcRoot = path.join(repoRoot, "src");
    await mkdir(srcRoot, { recursive: true });
    await Promise.all(
      Array.from({ length: 9 }, async (_, index) => {
        const file = path.join(srcRoot, `file-${index}.ts`);
        await writeFile(file, `export const value${index} = ${index};\n`, "utf8");
      }),
    );

    let activeReads = 0;
    let maxActiveReads = 0;
    const readFile = async (filePath: string) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
      activeReads -= 1;
      return `content:${path.basename(filePath)}`;
    };

    const files = await collectSourceFileContents({
      repoRoot,
      scanRoots: ["src"],
      scanExtensions: new Set([".ts"]),
      ignoredDirNames: new Set(),
      maxConcurrentReads: 3,
      readFile,
    });

    expect(maxActiveReads).toBeGreaterThan(1);
    expect(maxActiveReads).toBeLessThanOrEqual(3);
    expect(files.map((file) => file.relativeFile)).toEqual(
      Array.from({ length: 9 }, (_, index) => `src/file-${index}.ts`),
    );
    expect(files.map((file) => file.content)).toEqual(
      Array.from({ length: 9 }, (_, index) => `content:file-${index}.ts`),
    );
  });
});
