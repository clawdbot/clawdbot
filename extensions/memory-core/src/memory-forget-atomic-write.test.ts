import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyMemoryFileRewrite } from "./memory-forget-atomic-write.js";
import { MemoryWriteConflictError } from "./short-term-promotion-memory-write.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function setupMemoryFile(content: string): Promise<string> {
  const tempRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "memory-forget-atomic-write-test-")),
  );
  const memoryPath = path.join(tempRoot, "MEMORY.md");
  await fs.writeFile(memoryPath, content, "utf-8");
  cleanups.push(async () => {
    await fs.chmod(tempRoot, 0o755);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  return memoryPath;
}

const original =
  "# Long-Term Memory\n" +
  "Curated operator fact that must survive.\n" +
  "<!-- openclaw-memory-promotion:archived-entry -->\n" +
  "- Archived secret.\n";
const scrubbed = "# Long-Term Memory\nCurated operator fact that must survive.\n";

it.runIf(process.platform !== "win32")(
  "rewrites through a temp file plus atomic rename, preserving the file mode",
  async () => {
    const memoryPath = await setupMemoryFile(original);
    await fs.chmod(memoryPath, 0o640);

    await applyMemoryFileRewrite({
      absolutePath: memoryPath,
      content: scrubbed,
      remove: false,
      expectedContent: original,
    });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(scrubbed);
    expect((await fs.stat(memoryPath)).mode & 0o777).toBe(0o640);
  },
);

it.runIf(process.platform !== "win32")(
  "falls back to the checked in-place write when the parent directory rejects temp-file replacement",
  async () => {
    const memoryPath = await setupMemoryFile(original);
    // Writable target file under a parent that rejects sibling temp files:
    // the pre-atomic direct write succeeded here, so the rewrite must too.
    await fs.chmod(path.dirname(memoryPath), 0o555);

    await applyMemoryFileRewrite({
      absolutePath: memoryPath,
      content: scrubbed,
      remove: false,
      expectedContent: original,
    });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(scrubbed);
  },
);

it.runIf(process.platform !== "win32")(
  "rejects the in-place fallback when the file changed after the rewrite was planned",
  async () => {
    const externalEdit = `${original}- Edited externally after planning.\n`;
    const memoryPath = await setupMemoryFile(externalEdit);
    await fs.chmod(path.dirname(memoryPath), 0o555);

    await expect(
      applyMemoryFileRewrite({
        absolutePath: memoryPath,
        content: scrubbed,
        remove: false,
        expectedContent: original,
      }),
    ).rejects.toBeInstanceOf(MemoryWriteConflictError);

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(externalEdit);
  },
);

it.runIf(process.platform !== "win32")(
  "rejects the atomic rename when the file changed after the rewrite was planned",
  async () => {
    const externalEdit = `${original}- Edited externally after planning.\n`;
    const memoryPath = await setupMemoryFile(externalEdit);

    await expect(
      applyMemoryFileRewrite({
        absolutePath: memoryPath,
        content: scrubbed,
        remove: false,
        expectedContent: original,
      }),
    ).rejects.toBeInstanceOf(MemoryWriteConflictError);

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(externalEdit);
  },
);

it.runIf(process.platform !== "win32")(
  "removes the file without touching the fallback path when the rewrite is a removal",
  async () => {
    const memoryPath = await setupMemoryFile(original);

    await applyMemoryFileRewrite({
      absolutePath: memoryPath,
      content: "",
      remove: true,
      expectedContent: original,
    });

    await expect(fs.stat(memoryPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
