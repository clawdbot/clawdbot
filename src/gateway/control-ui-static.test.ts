import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readAndCloseControlUiFile } from "./control-ui-static.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

type ReadChunk = (
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number | null,
  callback: (error: NodeJS.ErrnoException | null, bytesRead: number, buffer: Buffer) => void,
) => void;

function openFile(body: string) {
  const filePath = path.join(tempDirs.make("openclaw-ui-read-"), "asset.txt");
  fs.writeFileSync(filePath, body);
  const fd = fs.openSync(filePath, "r");
  vi.spyOn(fs, "closeSync");
  return { filePath, fd, size: fs.fstatSync(fd).size };
}

function expectClosed(fd: number) {
  // Observe release itself: after awaiting the read, another worker may reuse the fd number.
  expect(fs.closeSync).toHaveBeenCalledWith(fd);
}

describe("pinned Control UI file reads", () => {
  it.each([0, 512 * 1024 + 19])("reads and closes a file of %i bytes", async (size) => {
    const body = "x".repeat(size);
    const file = openFile(body);
    const result = await readAndCloseControlUiFile(file);
    expect(result.toString()).toBe(body);
    expectClosed(file.fd);
  });

  it("fills short reads without adding bytes beyond the pinned size", async () => {
    const file = openFile("a small static response");
    const read = fs.read;
    const shortRead: ReadChunk = (fd, buffer, offset, length, position, callback) =>
      read(fd, buffer, offset, Math.min(length, 3), position, callback);
    vi.spyOn(fs, "read").mockImplementation(shortRead as typeof fs.read);
    expect((await readAndCloseControlUiFile(file)).toString()).toBe("a small static response");
    expectClosed(file.fd);
  });

  it("returns only bytes read when the pinned file is truncated", async () => {
    const file = openFile("original longer content");
    fs.writeFileSync(file.filePath, "short");
    expect((await readAndCloseControlUiFile(file)).toString()).toBe("short");
    expectClosed(file.fd);
  });

  it("closes the descriptor when a read fails", async () => {
    const file = openFile("response");
    const error = Object.assign(new Error("synthetic read failure"), { code: "EIO" });
    const failRead: ReadChunk = (_fd, buffer, _offset, _length, _position, callback) =>
      queueMicrotask(() => callback(error, 0, buffer));
    vi.spyOn(fs, "read").mockImplementation(failRead as typeof fs.read);
    await expect(readAndCloseControlUiFile(file)).rejects.toBe(error);
    expectClosed(file.fd);
  });

  it("retains the readFile allocation limit and closes before rejecting", async () => {
    const file = openFile("");
    await expect(readAndCloseControlUiFile({ ...file, size: 2 ** 31 })).rejects.toMatchObject({
      code: "ERR_FS_FILE_TOO_LARGE",
    });
    expectClosed(file.fd);
  });
});
