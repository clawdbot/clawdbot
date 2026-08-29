import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { hashMemoryContent, writeMemoryContent } from "./short-term-promotion-memory-write.js";

const openState = vi.hoisted(() => ({
  failInPlaceWriteAfterBytes: null as number | null,
  shortFirstRestoreWrite: false,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open: typeof actual.open = async (...args) => {
    const handle = await actual.open(...(args as Parameters<typeof actual.open>));
    const partialBytes = openState.failInPlaceWriteAfterBytes;
    if (args[1] !== "r+" || partialBytes === null) {
      return handle;
    }
    openState.failInPlaceWriteAfterBytes = null;
    let shortWriteArmed = openState.shortFirstRestoreWrite;
    openState.shortFirstRestoreWrite = false;
    const realWrite = handle.write.bind(handle);
    const failingWriteFile = async (content: string) => {
      const partial = Buffer.from(content, "utf-8").subarray(0, partialBytes);
      await realWrite(partial, 0, partial.length, 0);
      throw Object.assign(new Error("EFBIG: file too large, write"), { code: "EFBIG" });
    };
    const write = async (buffer: Buffer, offset: number, length: number, position: number) => {
      const cappedLength = shortWriteArmed && length > 1 ? Math.floor(length / 2) : length;
      shortWriteArmed = false;
      return await realWrite(buffer, offset, cappedLength, position);
    };
    Object.defineProperties(handle, {
      writeFile: { value: failingWriteFile },
      write: { value: write },
    });
    return handle;
  };
  return { ...actual, default: { ...actual, open }, open };
});

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  openState.failInPlaceWriteAfterBytes = null;
  openState.shortFirstRestoreWrite = false;
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

async function setupReadOnlyMemoryDir(originalContent: string): Promise<string> {
  const tempRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "memory-write-test-")),
  );
  const memoryDir = path.join(tempRoot, "workspace");
  await fs.mkdir(memoryDir);
  const memoryPath = path.join(memoryDir, "MEMORY.md");
  await fs.writeFile(memoryPath, originalContent, "utf-8");
  await fs.chmod(memoryDir, 0o555);
  cleanups.push(async () => {
    await fs.chmod(memoryDir, 0o755);
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
  return memoryPath;
}

it.runIf(process.platform !== "win32")(
  "keeps the original MEMORY.md when the in-place fallback write fails partway",
  async () => {
    const original = "# Long-Term Memory\n\n- existing entry that must survive\n";
    const memoryPath = await setupReadOnlyMemoryDir(original);
    const promoted = `${original}${"- promoted entry\n".repeat(200)}`;
    openState.failInPlaceWriteAfterBytes = 1024;

    await expect(
      writeMemoryContent({
        memoryPath,
        memoryWritePath: memoryPath,
        expectedHash: hashMemoryContent(original),
        expectedContent: original,
        allowInPlaceFallback: true,
        content: promoted,
      }),
    ).rejects.toMatchObject({ code: "EFBIG" });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(original);
  },
);

it.runIf(process.platform !== "win32")(
  "completes the restore across short writes before truncating",
  async () => {
    const original = "# Long-Term Memory\n\n- existing entry that must survive\n";
    const memoryPath = await setupReadOnlyMemoryDir(original);
    const promoted = `# Long-Term Memory\n\n## 2026-08-19\n${"- promoted entry\n".repeat(200)}`;
    openState.failInPlaceWriteAfterBytes = 1024;
    openState.shortFirstRestoreWrite = true;

    await expect(
      writeMemoryContent({
        memoryPath,
        memoryWritePath: memoryPath,
        expectedHash: hashMemoryContent(original),
        expectedContent: original,
        allowInPlaceFallback: true,
        content: promoted,
      }),
    ).rejects.toMatchObject({ code: "EFBIG" });

    expect(await fs.readFile(memoryPath, "utf-8")).toBe(original);
  },
);
