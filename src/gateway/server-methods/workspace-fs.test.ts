import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { readWorkspaceFilePrefix } from "./workspace-fs.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => {
  vi.restoreAllMocks();
});

type FileHandleRead = (
  target: Uint8Array,
  offset: number,
  length: number,
  position: number | null,
) => Promise<{ bytesRead: number; buffer: Uint8Array }>;

async function getFileHandleRead(filePath: string) {
  const probe = await open(filePath, "r");
  const fileHandlePrototype = Object.getPrototypeOf(probe) as { read: FileHandleRead };
  await probe.close();
  return fileHandlePrototype;
}

describe("readWorkspaceFilePrefix", () => {
  it("fills the bounded prefix when the handle serves short reads", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-");
    const filePath = path.join(tempDir, "notes.txt");
    const content = Buffer.from("prefix-bytes-that-must-not-be-truncated");
    await writeFile(filePath, content);

    const fileHandlePrototype = await getFileHandleRead(filePath);
    const originalRead = fileHandlePrototype.read;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(
      async function (this: unknown, target, offset, length, position) {
        return await originalRead.call(this, target, offset, Math.min(length, 1), position);
      },
    );

    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", 100);

    expect(result?.buffer).toEqual(content);
    expect(result?.canonicalPath).toBe("notes.txt");
    expect(result?.stat.size).toBe(content.length);
  });

  it("returns bytes read before an explicit EOF", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-eof-");
    const filePath = path.join(tempDir, "notes.txt");
    await writeFile(filePath, "prefix");

    const fileHandlePrototype = await getFileHandleRead(filePath);
    const originalRead = fileHandlePrototype.read;
    let readCount = 0;
    vi.spyOn(fileHandlePrototype, "read").mockImplementation(
      async function (this: unknown, target, offset, length, position) {
        readCount += 1;
        if (readCount === 2) {
          return { bytesRead: 0, buffer: target };
        }
        return await originalRead.call(this, target, offset, Math.min(length, 3), position);
      },
    );

    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", 100);

    expect(result?.buffer.toString()).toBe("pre");
    expect(readCount).toBe(2);
  });

  it("still bounds the returned prefix to maxBytes", async () => {
    const tempDir = tempDirs.make("openclaw-workspace-fs-prefix-bound-");
    await writeFile(path.join(tempDir, "notes.txt"), "bounded-prefix");

    const result = await readWorkspaceFilePrefix(tempDir, "notes.txt", 7);

    expect(result?.buffer.toString()).toBe("bounded");
  });
});
